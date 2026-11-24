// A tiny "app" for the app-capture end-to-end tests: a guest entry, a canvas
// over a button, touch, mouse and key input, a readiness flag, localStorage
// and cookies, an analytics beacon, and a tall page to scroll. Each page
// writes what it saw into #out, which the live HTML snapshot keeps.
import http from 'node:http'

const page = (title, body, script = '') => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;font:16px sans-serif}#out{white-space:pre}</style></head>
<body>${body}<p id="out"></p>
<script>
const out = (line) => { document.getElementById('out').textContent += line + '\\n' };
${script}
</script></body></html>`

const PAGES = {
  // What the browser looks like: size, touch, user agent, motion, storage, cookies.
  '/device': page(
    'Device',
    '<h1>Device</h1>',
    `out('size=' + innerWidth + 'x' + innerHeight);
out('touch=' + (navigator.maxTouchPoints > 0 ? 1 : 0));
out('mobileUa=' + (/iPhone|iPad/.test(navigator.userAgent) ? 1 : 0));
out('motion=' + (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference'));
out('seed=' + (localStorage.getItem('seed') || '-') + ',' + (localStorage.getItem('boardSeed') || '-'));
out('guest=' + (localStorage.getItem('guest') || '-'));
out('cookie=' + (document.cookie || '-'));`,
  ),
  // Ten 400 px bands: band N is at y = N * 400.
  '/tall': page(
    'Tall',
    Array.from(
      { length: 10 },
      (_, i) => `<div id="band${i}" style="height:400px;background:rgb(${i * 25},${200 - i * 20},${i % 2 ? 40 : 220})"></div>`,
    ).join(''),
  ),
  // The app: guest entry, then a game screen.
  '/app': page(
    'App',
    `<div id="welcome"><h1>Welcome</h1><button id="guest">Continue as guest</button></div>
<div id="dash" hidden><h1>Dashboard</h1></div>
<div style="position:fixed;left:400px;top:20px;width:300px;height:120px">
  <button id="play" style="position:absolute;left:20px;top:20px;width:120px;height:60px">Play</button>
  <canvas id="cover" width="300" height="120" style="position:absolute;inset:0"></canvas>
</div>
<button id="tapme" style="width:120px;height:60px">Tap me</button>
<button id="desktop-only">Desktop only</button>`,
    `const show = () => {
  const guest = localStorage.getItem('guest') === '1';
  document.getElementById('welcome').hidden = guest;
  document.getElementById('dash').hidden = !guest;
};
show();
document.getElementById('guest').addEventListener('click', async () => {
  await fetch('/api/guest', { method: 'POST' });
  localStorage.setItem('guest', '1');
  document.cookie = 'guest=1; path=/';
  show();
});
document.getElementById('play').addEventListener('click', () => out('played'));
document.getElementById('tapme').addEventListener('touchend', () => out('tapped'));
document.getElementById('desktop-only').addEventListener('click', () => out('desktop-clicked'));
document.getElementById('cover').addEventListener('mousedown', (e) => out('mouse=' + e.offsetX + ',' + e.offsetY));
let down = 0;
addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' && !down) down = performance.now() });
addEventListener('keyup', (e) => { if (e.key === 'ArrowLeft') { out('held=' + (performance.now() - down >= 400 ? 'long' : 'short')); down = 0 } });
setTimeout(() => { window.gameReady = true; out('ready') }, 600);
if (localStorage.getItem('seed')) out('seed=' + localStorage.getItem('seed'));`,
  ),
  // Sends analytics: a beacon on this host, and a script and beacon on "localhost".
  '/tracked': page(
    'Tracked',
    '<h1>Tracked</h1>',
    `fetch('/beacon?e=pageview').catch(() => {});
const s = document.createElement('script'); s.src = 'http://localhost:' + location.port + '/collect.js'; document.head.appendChild(s);`,
  ),
  // A site with a dark theme: in a style element, a style element with a
  // media attribute and a linked sheet with one. Writes the scheme it saw.
  '/scheme': page(
    'Scheme',
    `<style>:root{color-scheme:light dark}main{background:rgb(250,250,250);color:rgb(10,10,10)}
@media (prefers-color-scheme: dark){main{background:rgb(20,20,20)}}
@supports (display: grid){@media screen and (prefers-color-scheme: dark){main{border:3px solid rgb(200,0,0)}}}</style>
<style media="(prefers-color-scheme: dark)">main{color:rgb(240,240,240)}</style>
<link rel="stylesheet" href="/scheme.css" media="screen and (prefers-color-scheme: dark)">
<main id="themed">Themed</main>`,
    `out('scheme=' + (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));`,
  ),
}

const SCHEME_CSS = 'main{outline:4px solid rgb(0,0,200)}'

// Starts the site on a free port. `hits` counts requests by path.
export async function startAppSite() {
  const hits = {}
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname
    hits[pathname] = (hits[pathname] || 0) + 1
    if (pathname === '/api/guest' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"ok":true}')
    }
    if (pathname === '/beacon' || pathname === '/collect.js') {
      res.writeHead(200, { 'content-type': pathname === '/beacon' ? 'text/plain' : 'text/javascript' })
      return res.end('')
    }
    if (pathname === '/scheme.css') {
      res.writeHead(200, { 'content-type': 'text/css' })
      return res.end(SCHEME_CSS)
    }
    const html = PAGES[pathname]
    if (!html) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      return res.end('not found')
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { port, baseUrl: `http://127.0.0.1:${port}`, hits, close: () => new Promise((resolve) => server.close(resolve)) }
}
