// Reproduce native fetch losing abort propagation after its response arrives.
// This child owns its HTTP server and always closes it before exiting.
import http from 'node:http'
import { createRemote } from '../../src/remote/remote.js'

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(': connected\n\n')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
let timer
const controller = new AbortController()
const remote = createRemote({
  origin: `http://127.0.0.1:${server.address().port}`,
  token: 'fixture',
  fetchImpl: async (...args) => {
    const response = await fetch(...args)
    setImmediate(() => {
      global.gc()
      setImmediate(() => {
        global.gc()
        controller.abort()
      })
    })
    return response
  },
})
try {
  const result = await Promise.race([
    remote.waitForChange({ signal: controller.signal }),
    new Promise((resolve) => (timer = setTimeout(() => resolve('hung'), 3000))),
  ])
  console.log(JSON.stringify({ result, aborted: controller.signal.aborted }))
  if (result !== false || !controller.signal.aborted) process.exitCode = 1
} finally {
  clearTimeout(timer)
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
