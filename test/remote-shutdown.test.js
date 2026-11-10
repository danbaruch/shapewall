import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { getEventListeners } from 'node:events'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRemote } from '../src/remote/remote.js'
import { watchRemote } from '../src/remote/remote-watch.js'
import { tempDir } from './helpers.js'

test('native SSE read stops after SIGINT-style abort even after garbage collection', () => {
  const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(new URL('./fixtures/remote-sse-gc.mjs', import.meta.url))], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(child.status, 0, child.stdout + child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), { result: false, aborted: true })
})

for (const phase of ['pending read', 'before response']) {
  test(`abort cancels the owned reader when fetch ignores its signal: ${phase}`, async () => {
    let reads = 0
    let cancellations = 0
    let releaseResponse
    let announceRead
    let streamController
    const responseReleased = new Promise((resolve) => (releaseResponse = resolve))
    const reading = new Promise((resolve) => (announceRead = resolve))
    const controller = new AbortController()
    const response = new Response(
      new ReadableStream({
        start(value) {
          streamController = value
        },
        cancel() {
          cancellations++
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const getReader = response.body.getReader.bind(response.body)
    response.body.getReader = () => {
      const reader = getReader()
      const read = reader.read.bind(reader)
      reader.read = () => {
        reads++
        const pending = read()
        announceRead()
        return pending
      }
      return reader
    }
    const remote = createRemote({
      origin: 'http://localhost:9',
      token: 'fixture',
      // Intentionally ignore the request signal, matching the observed CI
      // reader that remained open and consumed a heartbeat after abort.
      fetchImpl: async () => {
        await responseReleased
        return response
      },
    })
    const waiting = remote.waitForChange({ signal: controller.signal })
    try {
      if (phase === 'pending read') {
        releaseResponse()
        await reading
      }
      controller.abort()
      releaseResponse()
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(cancellations, 1, 'abort actively cancels the owned stream')
      assert.equal(reads, phase === 'pending read' ? 1 : 0, 'no read starts after abort')
      assert.equal(await waiting, false)
      assert.equal(cancellations, 1, 'finally does not cancel twice')
    } finally {
      if (!cancellations) streamController.close()
      await waiting
    }
  })
}

test('an event wait aborts its request before awaiting transport cancellation', async () => {
  let requestSignal
  let cancelStarted
  const cancelling = new Promise((resolve) => (cancelStarted = resolve))
  const remote = createRemote({
    origin: 'http://localhost:9',
    token: 'fixture',
    fetchImpl: async (url, { signal }) => {
      requestSignal = signal
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: change\ndata: {}\n\n'))
          },
          cancel() {
            cancelStarted()
            // A transport may finish releasing its stream only after the
            // request is aborted. Waiting for this first deadlocks shutdown.
            return new Promise((resolve) => {
              if (signal.aborted) resolve()
              else signal.addEventListener('abort', resolve, { once: true })
            })
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  const waiting = remote.waitForChange()
  await cancelling
  assert.equal(requestSignal.aborted, true, 'request abort must precede transport cancellation')
  assert.equal(await waiting, true, 'the change is preserved after cleanup')
})

test('an already-aborted event wait never starts a request', async () => {
  let requests = 0
  const remote = createRemote({
    origin: 'http://localhost:9',
    token: 'fixture',
    fetchImpl: async () => {
      requests++
      throw new Error('unexpected request')
    },
  })
  assert.equal(await remote.waitForChange({ signal: AbortSignal.abort() }), false)
  assert.equal(requests, 0)
})

for (const phase of ['before startup', 'during baseline']) {
  test(`watch honors cancellation ${phase} before it scans or claims comments`, async () => {
    const controller = new AbortController()
    if (phase === 'before startup') controller.abort()
    let reads = 0
    await watchRemote({
      remote: {
        comments: async () => {
          reads++
          controller.abort()
          return { comments: [] }
        },
      },
      boardId: 'fixture',
      projectId: `pr_${'a'.repeat(24)}`,
      signal: controller.signal,
      newOnly: true,
      once: true,
      cwd: tempDir('watch-cancel-startup'),
      log: () => {},
    })
    assert.equal(reads, phase === 'before startup' ? 0 : 1)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  })
}

for (const phase of ['change', 'headers', 'body', 'unauthorized', 'wrong-type']) {
  test(`event wait releases the real HTTP stream at ${phase}`, { timeout: 5000 }, async (t) => {
    let received
    let disconnected
    const requestReceived = new Promise((resolve) => (received = resolve))
    const requestClosed = new Promise((resolve) => (disconnected = resolve))
    const server = http.createServer((req, res) => {
      res.once('close', disconnected)
      if (phase !== 'headers') {
        res.writeHead(phase === 'unauthorized' ? 401 : 200, {
          'content-type': phase === 'wrong-type' ? 'text/plain' : 'text/event-stream',
        })
        res.write(phase === 'change' ? 'event: change\ndata: {}\n\n' : ': connected\n\n')
      }
      received()
    })
    t.after(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections()
          server.close(resolve)
        }),
    )
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const controller = new AbortController()
    const remote = createRemote({ origin: `http://127.0.0.1:${server.address().port}`, token: 'fixture' })
    const waiting = remote.waitForChange({ signal: controller.signal })
    // Observe rejection immediately so an early 401 is never unhandled.
    const result = phase === 'unauthorized' ? assert.rejects(waiting, (error) => error.status === 401) : waiting
    await requestReceived
    if (phase === 'headers' || phase === 'body') controller.abort()
    const changed = await result
    if (phase !== 'unauthorized') assert.equal(changed, phase === 'change')
    await requestClosed
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'external abort listener is released')
  })
}
