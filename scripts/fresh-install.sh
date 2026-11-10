#!/usr/bin/env bash
# Fresh-machine check: packs this checkout the way npm would publish it,
# installs the tarball into an empty project folder (no lockfile, no repo
# files), and runs the quickstart a new user would: init, capture, serve.
# Also checks that serve picks up a config edit without a restart.
#
#   scripts/fresh-install.sh [--dir DIR] [--site URL] [--keep]
#
#   --dir DIR   work folder (default: a new folder under ~/.cache/shapewall-fresh;
#               keep it on disk, /tmp is RAM on some machines)
#   --site URL  capture this site instead of the tiny one the script serves
#   --keep      leave the work folder in place (it is removed on success otherwise)
#
# Needs Node 22+, npm, and network access to the npm registry. Chromium for
# capture comes from "shapewall doctor --install-browser" if it is missing.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work=""
site=""
keep=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) work="$2"; shift 2 ;;
    --site) site="$2"; shift 2 ;;
    --keep) keep=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$work" ]; then
  mkdir -p "$HOME/.cache/shapewall-fresh"
  work="$(mktemp -d "$HOME/.cache/shapewall-fresh/run-XXXXXX")"
else
  mkdir -p "$work"
  if [ -n "$(ls -A "$work")" ]; then echo "--dir $work is not empty" >&2; exit 2; fi
fi
work="$(cd "$work" && pwd)"

pids=()
cleanup() {
  status=$?
  for pid in "${pids[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]:-}"; do [ -n "$pid" ] && wait "$pid" 2>/dev/null || true; done
  if [ $status -eq 0 ] && [ $keep -eq 0 ]; then rm -rf "$work"; else echo "Work folder kept: $work"; fi
  exit $status
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
# Waits for a URL to answer 200 (up to ~30 s).
wait_for() {
  node -e "
    const url = process.argv[1]
    const until = Date.now() + 30000
    const tick = () => fetch(url).then((r) => { if (r.ok) process.exit(0); throw new Error(r.status) })
      .catch(() => (Date.now() > until ? process.exit(1) : setTimeout(tick, 250)))
    tick()" "$1"
}

step "Pack $repo"
mkdir -p "$work/pack"
(cd "$repo" && npm pack --pack-destination "$work/pack" >"$work/pack/pack.log" 2>&1) || { cat "$work/pack/pack.log"; fail "npm pack"; }
tarball="$(ls "$work"/pack/shapewall-*.tgz)"
echo "$tarball"

if [ -z "$site" ]; then
  step "Serve a tiny static site"
  site_port="$(free_port)"
  site="http://127.0.0.1:$site_port"
  mkdir -p "$work/site/about" "$work/site/blog/hello"
  page() { printf '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>%s</title></head><body style="font-family:sans-serif;margin:2rem"><h1>%s</h1><p>A tiny site for the Shapewall fresh-install check.</p><nav><a href="/">Home</a> <a href="/about/">About</a> <a href="/blog/hello/">Blog</a></nav></body></html>\n' "$1" "$1" >"$2"; }
  page "Home" "$work/site/index.html"
  page "About" "$work/site/about/index.html"
  page "Hello" "$work/site/blog/hello/index.html"
  printf '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>%s/</loc></url>\n<url><loc>%s/about/</loc></url>\n<url><loc>%s/blog/hello/</loc></url>\n</urlset>\n' "$site" "$site" "$site" >"$work/site/sitemap.xml"
  node -e "
    const http = require('http'), fs = require('fs'), path = require('path')
    const root = process.argv[1]
    const types = { '.html': 'text/html; charset=utf-8', '.xml': 'application/xml' }
    http.createServer((req, res) => {
      let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname))
      if (!file.startsWith(root)) { res.writeHead(403); return res.end() }
      if (file.endsWith('/')) file += 'index.html'
      fs.readFile(file, (error, body) => {
        if (error) { res.writeHead(404); return res.end('not found') }
        res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' })
        res.end(body)
      })
    }).listen(Number(process.argv[2]), '127.0.0.1')" "$work/site" "$site_port" &
  pids+=($!)
  wait_for "$site/" || fail "the tiny site did not start"
  echo "$site"
fi

step "Execute the supplied tarball without a global install"
mkdir -p "$work/npx"
(cd "$work/npx" && npm_config_cache="$work/npx-cache" npx --yes --package "$tarball" -- shapewall --version) || fail "npx --package"

step "Install the tarball into an empty project"
mkdir -p "$work/project"
cd "$work/project"
npm init -y >/dev/null
npm install --no-audit --no-fund "$tarball" >"$work/install.log" 2>&1 || { tail -40 "$work/install.log"; fail "npm install"; }
npx --no -- shapewall --version
npx --no -- shapewall --help >"$work/help.log"
npx --no -- shapewall auth record --help >"$work/auth-help.log"
node -e "const fs=require('fs');for(const guide of ['config','agents','local-accounts','updates','hosted','capture-warnings'])if(!fs.existsSync('node_modules/shapewall/docs/'+guide+'.md'))throw Error('missing guide: '+guide)"

step "Chromium for capture"
npx --no -- shapewall doctor --install-browser >"$work/browser.log" 2>&1 || { tail -20 "$work/browser.log"; fail "doctor --install-browser"; }
echo ok

step "init --base-url $site --sitemap"
npx --no -- shapewall init --base-url "$site" --sitemap | tee "$work/init.log"
grep -q '^Next: make sure ' "$work/init.log" || fail "init did not print the sitemap Next: hint"
pages="$(node -e "console.log(JSON.parse(require('fs').readFileSync('shapewall.config.json','utf8')).pages.length)")"
[ "$pages" -ge 1 ] || fail "init wrote no pages"
echo "pages: $pages"

step "doctor checks the installed project"
npx --no -- shapewall doctor >"$work/doctor.log" 2>&1 || { tail -30 "$work/doctor.log"; fail "doctor"; }

step "capture"
npx --no -- shapewall capture | tee "$work/capture.log"

step "serve"
board_port="$(free_port)"
board="http://127.0.0.1:$board_port"
# Start the installed entry point directly so cleanup owns the server PID,
# rather than an npx parent that can leave the server behind after SIGTERM.
node node_modules/shapewall/bin/shapewall.js serve --port "$board_port" >"$work/serve.log" 2>&1 &
pids+=($!)
wait_for "$board/api/health" || { cat "$work/serve.log"; fail "serve did not start"; }
node -e "
  const board = process.argv[1]
  const main = async () => {
    const html = await (await fetch(board + '/')).text()
    if (!/<div id=\"root\"|<script/.test(html)) throw new Error('the board page is not the app shell')
    const { boards } = await (await fetch(board + '/api/boards')).json()
    if (!boards?.length) throw new Error('no boards')
    const view = await (await fetch(board + '/api/boards/' + boards[0].id)).json()
    const pages = view.board?.pages || []
    const home = pages[0] && 'captures/' + pages[0].id + '.desktop.png'
    const image = home && (await fetch(board + '/api/boards/' + boards[0].id + '/' + home))
    console.log('board', boards[0].id, 'pages', pages.length, 'first capture', image?.status, image?.headers.get('content-type'))
    if (!pages.length || image?.status !== 200) throw new Error('the board does not serve its captures')
  }
  main().catch((error) => { console.error(error.message); process.exit(1) })" "$board" || { cat "$work/serve.log"; fail "board check"; }

step "Config edit applies without a restart"
node -e "
  const fs = require('fs')
  const raw = JSON.parse(fs.readFileSync('shapewall.config.json', 'utf8'))
  raw.title = 'Fresh install renamed'
  fs.writeFileSync('shapewall.config.json', JSON.stringify(raw, null, 2) + '\n')"
node -e "
  const url = process.argv[1] + '/api/info'
  const until = Date.now() + 10000
  const tick = () => fetch(url).then((r) => r.json()).then((info) => {
    if (info.title === 'Fresh install renamed') return console.log('title:', info.title)
    if (Date.now() > until) { console.error('title still', info.title); process.exit(1) }
    setTimeout(tick, 200)
  })
  tick()" "$board" || { cat "$work/serve.log"; fail "config reload"; }

printf '\nPASS: packed, installed, help, doctor, init, capture, served captures and live config reload work from %s\n' "$(basename "$tarball")"
