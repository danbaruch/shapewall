// A tiny fixture app for the migrate fixtures: two pages, two "environments" (ports).
import http from 'node:http'
const label = process.argv[3] || 'Default'
const page = (title, body) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:0;padding:24px;background:#f6f5f1;color:#222}h1{font-size:28px}
.card{background:#fff;border-radius:8px;padding:16px;margin:12px 0}a{color:#2456c9}</style></head>
<body><h1>${title}</h1><p>Fixture app (${label}).</p>${body}<p><a href="/">Home</a> | <a href="/pricing">Pricing</a></p></body></html>`
http
  .createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    if (req.url === '/')
      return res.end(page('Fixture Home', '<div class="card" id="hero">Welcome to the fixture app.</div><button id="cta">Start</button>'))
    if (req.url === '/pricing')
      return res.end(page('Pricing', '<div class="card" id="plan-a">Plan A</div><div class="card" id="plan-b">Plan B</div>'))
    res.statusCode = 404
    res.end(page('Not found', ''))
  })
  .listen(Number(process.argv[2]), '127.0.0.1')
