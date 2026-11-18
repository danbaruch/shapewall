// The site's videos: the manifest (src/media.json) and its checks, the helpers the pages use, the build's refusal to go
// on without a referenced file, and the prerendered markup (posters only, real buttons, no video before a click).
// Nothing here needs website/media/: the build that is inspected runs with SHAPEWALL_MEDIA_CHECK=0, as CI does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { MEDIA_NAME, assertMedia, checkMediaFiles, manifestFiles, readManifest } from '../scripts/media-lib.mjs'
import { FILMS, MEDIA, clipState, clock, isoDuration, orderedSources, videoObject } from '../src/videos.js'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(SITE, 'dist')
const manifest = readManifest()

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-media-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('the manifest: every film and clip has hashed sources, an MP4, posters with sizes, and the tour has captions', () => {
  const files = manifestFiles(manifest)
  assert.ok(files.length > 0)
  for (const { file, bytes } of files) {
    assert.match(file, MEDIA_NAME)
    assert.ok(Number.isInteger(bytes) && bytes > 0, file)
  }
  for (const [id, video] of Object.entries(manifest.videos)) {
    assert.ok(video.width > 0 && video.height > 0 && video.duration > 0, id)
    assert.ok(['film', 'clip'].includes(video.kind), id)
    assert.ok(
      video.sources.some((source) => source.type.startsWith('video/mp4')),
      `${id}: an MP4 every browser plays`,
    )
    assert.ok(
      video.sources.some((source) => source.type.startsWith('video/webm')),
      `${id}: a WebM`,
    )
    assert.ok(video.poster.jpg.file.endsWith('.jpg') && video.poster.webp.length >= 1, `${id}: poster`)
    if (video.kind === 'clip') assert.equal(video.audio, false, `${id}: clips are silent`)
  }
  for (const id of ['launch-film', 'tour', 'docs-quickstart']) assert.ok(manifest.videos[id], id)
  assert.equal(manifest.videos.tour.tracks?.[0]?.kind, 'subtitles')
  assert.equal(manifest.videos.tour.tracks[0].srclang, 'en')
  assert.ok(manifest.videos['launch-film'].audio, 'the launch film has sound')
})

test('every clip the features page names is in the manifest', () => {
  const page = fs.readFileSync(path.join(SITE, 'src/pages/Features.jsx'), 'utf8')
  const ids = [...page.matchAll(/id: '(clip-[a-z-]+)'/g)].map((match) => match[1])
  assert.equal(new Set(ids).size, 12, 'all twelve clips are placed, once each')
  for (const id of ids) assert.ok(MEDIA[id], id)
})

test('a missing or wrong-sized file is reported by name, and the check can only be skipped on purpose', (t) => {
  const dir = tmp(t)
  const files = manifestFiles(manifest)
  // All present but one missing and one truncated.
  for (const { file, bytes } of files.slice(2)) fs.writeFileSync(path.join(dir, file), Buffer.alloc(bytes))
  fs.writeFileSync(path.join(dir, files[1].file), 'short')
  const result = checkMediaFiles(manifest, dir)
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, [files[0].file])
  assert.deepEqual(result.wrongSize, [files[1].file])
  assert.throws(
    () => assertMedia({ manifest, dir, env: {} }),
    (error) => {
      assert.match(error.message, new RegExp(`missing {5}${files[0].file.replace(/\./g, '\\.')}`))
      assert.match(error.message, /wrong size/)
      assert.match(error.message, /media-encode\.mjs/)
      return true
    },
  )
  assert.deepEqual(assertMedia({ manifest, dir, env: { SHAPEWALL_MEDIA_CHECK: '0' } }), { skipped: true })
  // Complete: passes.
  fs.writeFileSync(path.join(dir, files[0].file), Buffer.alloc(files[0].bytes))
  fs.writeFileSync(path.join(dir, files[1].file), Buffer.alloc(files[1].bytes))
  assert.equal(assertMedia({ manifest, dir, env: {} }).ok, true)
})

test('a manifest with a file name that is not a hashed media name is refused', () => {
  const bad = { videos: { x: { sources: [{ file: '../../etc/passwd', bytes: 1 }], poster: { webp: [] } } } }
  assert.throws(() => manifestFiles(bad), /not a hashed media file name/)
})

test('the build stops with a clear message when a referenced media file is missing', (t) => {
  const empty = tmp(t)
  const out = tmp(t)
  const result = spawnSync(
    process.execPath,
    [path.join(SITE, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', out, '--emptyOutDir'],
    {
      cwd: SITE,
      encoding: 'utf8',
      env: { ...process.env, SHAPEWALL_MEDIA_CHECK: '1', SHAPEWALL_MEDIA_DIR: empty },
    },
  )
  assert.notEqual(result.status, 0, 'the build fails')
  const output = result.stdout + result.stderr
  assert.match(output, /src\/media\.json references media files that are not in/)
  assert.match(output, /missing {5}launch-film-/)
})

test('helpers: durations, source order and the VideoObject data', () => {
  assert.equal(clock(92.34), '1:32')
  assert.equal(clock(59.6), '1:00')
  assert.equal(isoDuration(92.34), 'PT1M32S')
  assert.equal(isoDuration(8.4), 'PT8S')
  const film = orderedSources(MEDIA['launch-film'])
  assert.ok(film[0].type.startsWith('video/mp4') && film[0].height === 1080, 'MP4 1080p first')
  assert.equal(film[0].media, '(min-width: 768px)', 'a phone-width screen skips the 1080p sources')
  assert.ok(
    film.filter((source) => source.height < 1080).every((source) => !source.media),
    '720p takes any screen',
  )
  assert.ok(film.every((source) => source.src.startsWith('/media/')))
  const clip = orderedSources(MEDIA['clip-wall'])
  assert.ok(
    clip.every((source) => !source.media),
    'a clip has one size',
  )
  for (const id of ['launch-film', 'tour']) {
    const data = videoObject(id, 'https://shapewall.com')
    assert.equal(data['@type'], 'VideoObject')
    assert.equal(data.name, FILMS[id].name)
    assert.match(data.uploadDate, /^\d{4}-\d{2}-\d{2}$/)
    assert.match(data.duration, /^PT\d+M\d+S$/)
    assert.match(data.contentUrl, /^https:\/\/shapewall\.com\/media\/[a-z-]+-1080\.[0-9a-f]{10}\.mp4$/)
    assert.ok(data.thumbnailUrl.every((url) => url.startsWith('https://shapewall.com/media/')))
  }
})

test('clips: nothing loads before the screen, reduce motion never autoplays, a visitor choice wins', () => {
  const base = { reduce: false, near: false, inView: false, userChoice: null, playing: false, failed: false }
  // Off screen: no video element, nothing loads.
  assert.deepEqual(clipState(base), { wantsPlay: false, mounted: false, large: false })
  // On screen: loads and plays, small pause button.
  assert.deepEqual(clipState({ ...base, near: true, inView: true }), { wantsPlay: true, mounted: true, large: false })
  // Scrolled away again: pauses.
  assert.equal(clipState({ ...base, near: true, inView: false }).wantsPlay, false)
  // Reduce motion: poster with the big play button, no video loaded, until the visitor presses play.
  assert.deepEqual(clipState({ ...base, reduce: true, near: true, inView: true }), { wantsPlay: false, mounted: false, large: true })
  assert.deepEqual(clipState({ ...base, reduce: true, near: true, inView: true, userChoice: 'play' }), {
    wantsPlay: true,
    mounted: true,
    large: true, // until it is actually playing
  })
  assert.equal(clipState({ ...base, reduce: true, near: true, inView: true, userChoice: 'play', playing: true }).large, false)
  // Paused by the visitor: stays paused on screen.
  assert.equal(clipState({ ...base, near: true, inView: true, userChoice: 'pause' }).wantsPlay, false)
  assert.equal(clipState({ ...base, near: true, inView: true, userChoice: 'pause' }).large, true)
  // Failed: the poster stays, no player, no button.
  assert.deepEqual(clipState({ ...base, near: true, inView: true, failed: true }), { wantsPlay: true, mounted: false, large: false })
})

test('prerendered pages: posters only, with sizes; real, labelled play buttons; VideoObject data', () => {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: SITE,
    env: { ...process.env, SHAPEWALL_STEALTH: '', SHAPEWALL_UMAMI_ID: '', SHAPEWALL_LAUNCHED: '', SHAPEWALL_MEDIA_CHECK: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const read = (name) => fs.readFileSync(path.join(DIST, name), 'utf8')
  const pages = { home: read('index.html'), features: read('features.html'), start: read('docs/getting-started.html') }
  for (const [name, html] of Object.entries(pages)) {
    assert.ok(!/<video/.test(html), `${name}: no <video> before a click or a scroll`)
    assert.ok(!/<source[^>]+\.(mp4|webm)/.test(html), `${name}: no video source in the HTML`)
  }
  const ld = (html) =>
    [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((match) => JSON.parse(match[1])['@graph'])
  // Home: the screenshot stays the poster (and the largest paint); the button names the film, its length and sound.
  assert.match(pages.home, /<button type="button"[^>]*aria-label="Play Shapewall launch film, 1:32, with sound"/)
  assert.match(pages.home, />Watch the launch film</)
  const homeMarkup = pages.home.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '')
  assert.ok(!homeMarkup.includes('/media/'), 'home: nothing from /media/ loads with the page (the structured data only names it)')
  assert.ok(ld(pages.home).some((item) => item['@type'] === 'VideoObject' && item.name === FILMS['launch-film'].name))
  // Features: the tour (eager poster, at the top) and twelve clips with lazy posters, each with its own width and height.
  assert.match(pages.features, /aria-label="Play Shapewall product tour, \d:\d\d, with sound"/)
  assert.ok(ld(pages.features).some((item) => item['@type'] === 'VideoObject' && item.name === FILMS.tour.name))
  const clips = [...pages.features.matchAll(/<figure[^>]*data-clip="(clip-[a-z-]+)"[^>]*>([\s\S]*?)<\/figure>/g)]
  assert.equal(clips.length, 8, 'eight sections with a clip (two of them with tabs; the first tab is rendered)')
  for (const [, id, body] of clips) {
    assert.match(body, /<img[^>]+width="1440"[^>]+height="900"/, `${id}: poster with its size`)
    assert.match(body, /loading="lazy"/, `${id}: poster loads lazily`)
    assert.match(body, /<source type="image\/webp"/, `${id}: WebP poster`)
    assert.match(body, /<button type="button"[^>]*aria-label="Play video: /, `${id}: a real play button`)
  }
  assert.match(pages.features, /role="tablist" aria-label="Videos for this feature"/)
  assert.equal((pages.features.match(/role="tab"/g) || []).length, 6, 'tabs: two for Comments, four for Teams')
  // Getting started: the quickstart above the steps, with the line that says the steps are the same.
  assert.match(pages.start, /data-doc-video="docs-quickstart"/)
  assert.match(pages.start, /aria-label="Play Shapewall quickstart, 1:27, silent"/)
  assert.match(pages.start, /shows the same steps as the text below/)
  // Every page keeps its frame size: each video frame declares its aspect ratio.
  for (const html of [pages.features, pages.start]) assert.match(html, /aspect-ratio:1920 \/ 1080/)
})
