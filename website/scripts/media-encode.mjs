// Makes the site's web videos and posters from the film masters, into website/media/ (git-ignored), and writes the
// manifest the pages read, src/media.json (committed). Usage:
//   node scripts/media-encode.mjs <masters folder>      e.g. the shapewall-video repo's out/ folder
// The masters folder holds shapewall-launch-film.mp4 + -poster.png, tour.mp4 + tour.vtt + tour-poster.png,
// docs-quickstart.mp4 + .jpg, and clips/<nn>-<slug>.mp4 + .webm + .jpg. Nothing in it is changed.
//
// What it makes:
// - the launch film, the tour and the docs quickstart: H.264 (High, CRF 27, faststart, AAC 128k when the film has sound)
//   at 1080p (source frame rate) and 720p (30 fps), plus a VP9 WebM at 720p only (CRF 40, Opus 128k), the fallback for a
//   browser without H.264. Every browser that can show 1080p plays H.264, and at 1080p the VP9 was the bigger file;
// - the feature clips: their MP4 and WebM as they are (already small, silent, made to loop);
// - every poster as WebP (full size and half) plus a JPEG fallback;
// - the tour's captions (WebVTT) as they are.
// Every output is named <id>-<variant>.<10 hex of its sha256>.<ext>, so a changed encode is a new URL. Encodes are kept in
// .media-work/ keyed by the master's hash and the settings, so running it again after one film changes only redoes that film.
// Files in media/ that the new manifest no longer references are removed (the server keeps its own copies).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { MEDIA_DIR, MANIFEST_PATH, manifestFiles } from './media-lib.mjs'

const WEBSITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK = path.join(WEBSITE, '.media-work')
const THREADS = '4' // at most 4 workers on the build machine

const FILMS = [
  { id: 'launch-film', master: 'shapewall-launch-film.mp4', poster: 'shapewall-launch-film-poster.png', heights: [1080, 720] },
  // The tour's own poster is its end card; on the site it gets a frame of the product instead (a comment being pinned on
  // Pricing), so the play button sits on the product, not on a second set of buttons. posterAt: seconds into the master.
  { id: 'tour', master: 'tour.mp4', posterAt: 33.5, captions: 'tour.vtt', heights: [1080, 720] },
  // The quickstart's own poster is its title card, which the play button would cover: a finished capture step instead.
  { id: 'docs-quickstart', master: 'docs-quickstart.mp4', posterAt: 33, heights: [1080, 720] },
]

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')}\n${result.stderr || result.stdout}`)
  return result.stdout
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function probe(file) {
  const info = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]))
  const video = info.streams.find((s) => s.codec_type === 'video')
  const [num, den] = (video.r_frame_rate || '30/1').split('/').map(Number)
  return {
    width: video.width,
    height: video.height,
    fps: Math.round(num / (den || 1)),
    duration: Number(Number(info.format.duration).toFixed(2)),
    audio: info.streams.some((s) => s.codec_type === 'audio'),
  }
}

// One cached step: `make(out)` writes out; the cache name carries the inputs' hash and the settings.
function cached(name, key, make) {
  fs.mkdirSync(WORK, { recursive: true })
  const ext = path.extname(name)
  const out = path.join(WORK, `${path.basename(name, ext)}.${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}${ext}`)
  if (!fs.existsSync(out)) {
    const partial = out + '.partial' + ext
    const started = Date.now()
    process.stdout.write(`  making ${name} ... `)
    make(partial)
    fs.renameSync(partial, out)
    console.log(`${((Date.now() - started) / 1000).toFixed(0)} s`)
  }
  return out
}

// Copies a finished file into media/ under its content-hashed name.
const published = []
function publish(id, variant, file) {
  const ext = path.extname(file).slice(1)
  const name = `${id}-${variant}.${sha(file).slice(0, 10)}.${ext}`
  const dest = path.join(MEDIA_DIR, name)
  if (!fs.existsSync(dest)) fs.copyFileSync(file, dest)
  const bytes = fs.statSync(dest).size
  published.push({ name, bytes })
  return { file: name, bytes }
}

const META = ['-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact']

function h264(src, height, fps, audio) {
  const outFps = height >= 1080 ? fps : Math.min(fps, 30)
  const args = (out) => [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    src,
    '-vf',
    `scale=-2:${height}:flags=lanczos`,
    '-r',
    String(outFps),
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '27',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-g',
    String(outFps * 2),
    '-threads',
    THREADS,
    ...(audio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-an']),
    ...META,
    '-movflags',
    '+faststart',
    out,
  ]
  return { key: `h264|crf27|slow|${height}|${outFps}|${audio}`, args }
}

function vp9(src, height, fps, audio) {
  const outFps = height >= 1080 ? fps : Math.min(fps, 30)
  const args = (out) => [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    src,
    '-vf',
    `scale=-2:${height}:flags=lanczos`,
    '-r',
    String(outFps),
    '-c:v',
    'libvpx-vp9',
    '-crf',
    '40',
    '-b:v',
    '0',
    '-deadline',
    'good',
    '-cpu-used',
    '4',
    '-row-mt',
    '1',
    '-tile-columns',
    '2',
    '-pix_fmt',
    'yuv420p',
    '-g',
    String(outFps * 2),
    '-threads',
    THREADS,
    ...(audio ? ['-c:a', 'libopus', '-b:a', '128k', '-ac', '2'] : ['-an']),
    ...META,
    out,
  ]
  return { key: `vp9|crf40|good4|${height}|${outFps}|${audio}`, args }
}

// Poster: WebP at full width and half, plus a JPEG fallback at full width.
function posters(id, src, width) {
  const hash = sha(src)
  const webp = []
  for (const w of [width, Math.round(width / 2)]) {
    const out = cached(`${id}-poster-${w}.webp`, `${hash}|webp|q78|${w}`, (o) =>
      run('magick', [src, '-resize', `${w}x`, '-strip', '-quality', '78', '-define', 'webp:method=6', o]),
    )
    webp.push({ ...publish(id, `poster-${w}`, out), width: w })
  }
  const jpgOut = cached(`${id}-poster.jpg`, `${hash}|jpg|q80|${width}`, (o) =>
    run('magick', [src, '-resize', `${width}x`, '-strip', '-quality', '80', '-sampling-factor', '4:2:0', '-interlace', 'Plane', o]),
  )
  return { webp, jpg: { ...publish(id, 'poster', jpgOut), width } }
}

// One frame of a master as a PNG (for a poster taken from the film itself).
function frameAt(src, hash, seconds) {
  return cached(`frame-${seconds}.png`, `${hash}|frame|${seconds}`, (o) =>
    run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(seconds),
      '-i',
      src,
      '-frames:v',
      '1',
      '-f',
      'image2',
      '-c:v',
      'png',
      o,
    ]),
  )
}

function film(def, dir) {
  const src = path.join(dir, def.master)
  if (!fs.existsSync(src)) throw new Error(`missing master: ${src}`)
  console.log(`${def.id}: ${def.master}`)
  const info = probe(src)
  const hash = sha(src)
  const sources = []
  for (const height of def.heights) {
    for (const [codec, make, type] of [
      ['webm', vp9, info.audio ? 'video/webm; codecs="vp9, opus"' : 'video/webm; codecs="vp9"'],
      ['mp4', h264, info.audio ? 'video/mp4; codecs="avc1.640028, mp4a.40.2"' : 'video/mp4; codecs="avc1.640028"'],
    ]) {
      if (codec === 'webm' && height >= 1080) continue // WebM is the fallback, at 720p only
      const job = make(src, height, info.fps, info.audio)
      const out = cached(`${def.id}-${height}.${codec}`, `${hash}|${job.key}`, (o) => run('ffmpeg', job.args(o)))
      // A master replaced while it was being read (a render finishing) would leave a mixed encode under the old hash.
      if (sha(src) !== hash) {
        fs.rmSync(out, { force: true })
        throw new Error(`${def.master} changed while it was being encoded; run the script again when it is finished`)
      }
      sources.push({ ...publish(def.id, String(height), out), type, height })
    }
  }
  const entry = {
    kind: 'film',
    width: info.width,
    height: info.height,
    duration: info.duration,
    audio: info.audio,
    sources,
    poster: posters(def.id, def.posterAt === undefined ? path.join(dir, def.poster) : frameAt(src, hash, def.posterAt), 1920),
  }
  if (def.captions) {
    const vtt = path.join(dir, def.captions)
    if (!fs.existsSync(vtt)) throw new Error(`missing captions: ${vtt}`)
    entry.tracks = [{ ...publish(def.id, 'captions-en', vtt), kind: 'subtitles', srclang: 'en', label: 'English' }]
  }
  return entry
}

function clip(dir, base) {
  const slug = base.replace(/^\d+-/, '')
  const id = `clip-${slug}`
  console.log(`${id}: clips/${base}`)
  const mp4 = path.join(dir, 'clips', `${base}.mp4`)
  const info = probe(mp4)
  const webmSource = publish(id, 'loop', path.join(dir, 'clips', `${base}.webm`))
  const mp4Source = publish(id, 'loop', mp4)
  return {
    kind: 'clip',
    width: info.width,
    height: info.height,
    duration: info.duration,
    audio: false,
    sources: [
      { ...webmSource, type: 'video/webm; codecs="vp9"', height: info.height },
      { ...mp4Source, type: 'video/mp4; codecs="avc1.640028"', height: info.height },
    ],
    poster: posters(id, path.join(dir, 'clips', `${base}.jpg`), info.width),
  }
}

function main() {
  const dir = process.argv[2] || process.env.SHAPEWALL_VIDEO_MASTERS
  if (!dir || !fs.existsSync(dir)) {
    console.error('usage: node scripts/media-encode.mjs <masters folder> (or SHAPEWALL_VIDEO_MASTERS)')
    process.exit(2)
  }
  fs.mkdirSync(MEDIA_DIR, { recursive: true })
  const videos = {}
  for (const def of FILMS) videos[def.id] = film(def, dir)
  const clipNames = fs
    .readdirSync(path.join(dir, 'clips'))
    .filter((name) => /^\d\d-[a-z0-9-]+\.mp4$/.test(name))
    .sort()
    .map((name) => name.slice(0, -4))
  for (const base of clipNames) {
    const entry = clip(dir, base)
    videos[`clip-${base.replace(/^\d+-/, '')}`] = entry
  }
  const manifest = {
    note: 'Written by scripts/media-encode.mjs. Files live in website/media/ (git-ignored) and on the server in media/.',
    base: '/media/',
    videos,
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')

  // Drop local files the manifest no longer references.
  const keep = new Set(manifestFiles(manifest).map((f) => f.file))
  for (const name of fs.readdirSync(MEDIA_DIR)) if (!keep.has(name)) fs.rmSync(path.join(MEDIA_DIR, name))

  // Sizes.
  const mb = (n) => (n / 1e6).toFixed(2).padStart(7) + ' MB'
  let total = 0
  console.log('\nmedia/ (what the server would hold for this manifest):')
  for (const { file, bytes } of manifestFiles(manifest)) {
    total += bytes
    console.log(`${mb(bytes)}  ${file}`)
  }
  console.log(`${mb(total)}  total, ${keep.size} files\nwrote ${path.relative(process.cwd(), MANIFEST_PATH)}`)
}

main()
