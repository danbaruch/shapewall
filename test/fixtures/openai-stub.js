// A stub OpenAI-compatible chat completions server for the chat tests: it
// streams canned answers chosen by the last person message. Never a real
// endpoint or key.
//
//   "use a tool"      -> a list_comments tool call, then (after the result) a short answer
//   "slowly"          -> 200 words, one every 25 ms (for Stop)
//   "no tools here"   -> 400 when tools are offered, then the default answer
//   "markdown"        -> a reply with a list, bold, code and a fenced block
//   "cut short"       -> a reply that ends on the length limit (finish_reason "length")
//   "show board refs" -> board references (real and unknown ones) and a code block
//   "no images here"  -> 400 (Ollama's words) when the request has an image, then the default answer
//   anything else     -> reasoning, then "Hello from the stub."
//   POST /bad/...     -> 401 that echoes the key (the board must not)
//   GET /v1/models    -> stub-model and stub-other (Settings > Agent "Test connection");
//                        GET /bad/models 401 with the key echoed, any other GET 404
import http from 'node:http'

const delta = (value, finish = null) => ({ choices: [{ index: 0, delta: value, finish_reason: finish }] })

export function lastUserText(body) {
  const message = [...body.messages].reverse().find((item) => item.role === 'user')
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

function sse(res, chunks, { delayMs = 0 } = {}) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  let index = 0
  const next = () => {
    if (res.destroyed) return
    if (index >= chunks.length) {
      res.end('data: [DONE]\n\n')
      return
    }
    res.write(`data: ${JSON.stringify(chunks[index++])}\n\n`)
    if (delayMs) setTimeout(next, delayMs)
    else next()
  }
  next()
}

const MARKDOWN = [
  'Here is the plan:\n\n',
  '1. Make the **Plus** button bolder\n',
  '2. Move the yearly price below\n\n',
  'Use `font-weight: 600`:\n\n',
  '```css\n.plus { font-weight: 600; }\n```\n',
]

export async function startOpenAIStub() {
  const calls = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      if (req.method === 'GET') {
        calls.push({ url: req.url, headers: req.headers, body: null })
        if (req.url === '/bad/models') {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${req.headers.authorization?.slice(7)}` } }))
        } else if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model' }, { id: 'stub-other' }] }))
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'no such route' } }))
        }
        return
      }
      const body = JSON.parse(raw)
      calls.push({ url: req.url, headers: req.headers, body })
      if (req.url === '/bad/chat/completions') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${req.headers.authorization?.slice(7)}` } }))
        return
      }
      const text = lastUserText(body)
      if (body.messages.at(-1).role === 'tool') {
        sse(res, [delta({ content: 'There is ' }), delta({ content: '**one** open comment.' }, 'stop')])
      } else if (text.includes('use a tool')) {
        sse(res, [
          delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'list_comments', arguments: '' } }] }),
          delta({ tool_calls: [{ index: 0, function: { arguments: '{"status":"open"}' } }] }, 'tool_calls'),
        ])
      } else if (text.includes('slowly')) {
        sse(
          res,
          Array.from({ length: 200 }, (_, index) => delta({ content: `word${index} ` })),
          { delayMs: 25 },
        )
      } else if (text.includes('no tools here') && body.tools) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'this model does not support tools' } }))
      } else if (text.includes('no images here') && JSON.stringify(body.messages).includes('"image_url"')) {
        // What Ollama answers for an image to a model without vision.
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Multimodal data provided, but model does not support multimodal requests.' } }))
      } else if (text.includes('cut short')) {
        // The model runs out of room for its answer.
        sse(res, [delta({ content: 'The first part of a long ' }), delta({ content: 'answer' }, 'length')])
      } else if (text.includes('show board refs')) {
        sse(res, [
          delta({
            content:
              '[[comment:1]] asks for a bolder button on [[page:pricing]]. See also #1, `/pricing` and **Features**; ' +
              'not [[comment:999]], #998 or [[page:nope]].\n\n',
          }),
          delta({ content: '```js\nconst plus = document.querySelector(".plus") // the card\n```\n' }, 'stop'),
        ])
      } else if (text.includes('markdown')) {
        sse(
          res,
          MARKDOWN.map((part) => delta({ content: part })),
          { delayMs: 30 },
        )
      } else {
        sse(res, [
          delta({ reasoning_content: 'Thinking about it.' }),
          delta({ content: 'Hello ' }),
          delta({ content: 'from the stub.' }, 'stop'),
        ])
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, calls, close: () => new Promise((resolve) => server.close(resolve)) }
}
