// A scripted OpenAI-compatible model for the starter agent tests: never a
// real endpoint. Turn N of a run (N = assistant messages already in the
// request) answers script[N]: { tools: [{ name, args }] } streams tool calls,
// { text } streams a final answer. Every request body is kept in `calls`
// (and, run as a program, appended to $STUB_OUT/calls.jsonl).
//
//   node starter-model-stub.mjs     (PORT, STUB_SCRIPT as JSON, STUB_OUT)

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const delta = (value, finish = null) => ({ choices: [{ index: 0, delta: value, finish_reason: finish }] })

export function createStarterStub({ script, usage = true, onCall = () => {} }) {
  const calls = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(404).end()
        return
      }
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        res.writeHead(400).end()
        return
      }
      const call = { url: req.url, authorization: req.headers.authorization || null, body }
      calls.push(call)
      onCall(call)
      const turn = body.messages.filter((message) => message.role === 'assistant').length
      const step = script[Math.min(turn, script.length - 1)] || { text: 'Done.' }
      const chunks = []
      if (step.tools) {
        step.tools.forEach((tool, index) =>
          chunks.push(
            delta({
              tool_calls: [
                {
                  index,
                  id: `call_${turn}_${index}`,
                  type: 'function',
                  function: { name: tool.name, arguments: JSON.stringify(tool.args || {}) },
                },
              ],
            }),
          ),
        )
        chunks.push(delta({}, 'tool_calls'))
      } else {
        chunks.push(delta({ content: step.text }, 'stop'))
      }
      if (usage && body.stream_options?.include_usage)
        chunks.push({
          choices: [],
          usage: { prompt_tokens: step.promptTokens ?? 100, completion_tokens: 20, total_tokens: (step.promptTokens ?? 100) + 20 },
        })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  return { server, calls }
}

export async function startStarterStub(options) {
  const stub = createStarterStub(options)
  await new Promise((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
  return { ...stub, port: stub.server.address().port, close: () => new Promise((resolve) => stub.server.close(resolve)) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.env.STUB_OUT || null
  const { server } = createStarterStub({
    script: JSON.parse(process.env.STUB_SCRIPT || '[{"text":"Done."}]'),
    onCall: (call) => out && fs.appendFileSync(path.join(out, 'calls.jsonl'), `${JSON.stringify(call)}\n`),
  })
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => process.stdout.write('stub ready\n'))
  process.on('SIGTERM', () => process.exit(0))
}
