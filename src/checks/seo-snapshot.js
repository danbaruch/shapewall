import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { boardDir, writeJsonAtomic } from '../store.js'
import { ID_RE } from '../config.js'
import { REPORT_ID_RE, REPORTS_MAX } from './schema.js'

// Search previews: the page's own public metadata (title, description,
// canonical, social tags) and a small re-encoded copy of its social image,
// saved beside a page check report that ran with SEO on. Unlike reports,
// previews contain page text and URLs, so they stay on this installation:
// they are served only by the private local checks API and are never part
// of a checks bundle, a push, a share or a static export.
export const SNAPSHOT_MAX_BYTES = 300 * 1024
export const THUMBNAIL_MAX_BYTES = 200 * 1024
const short = (n) => z.string().max(n)
const url = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol)
    } catch {
      return false
    }
  }, 'an http(s) URL')
export const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    reportId: z.string().regex(REPORT_ID_RE),
    boardId: z.string().regex(ID_RE),
    pageId: z.string().regex(ID_RE),
    environment: z.string().regex(ID_RE),
    viewport: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    auditedAt: z.iso.datetime(),
    url: url.nullable(),
    title: short(300),
    description: short(600),
    canonical: url.nullable(),
    robots: short(200),
    language: short(35),
    social: z
      .object({
        title: short(300),
        description: short(600),
        siteName: short(120),
        type: short(60),
        card: short(40),
        image: z.boolean(),
      })
      .strict(),
    image: z
      .object({
        // Always the browser's own JPEG re-encode, never the original bytes.
        dataUrl: z
          .string()
          .max(Math.ceil((THUMBNAIL_MAX_BYTES * 4) / 3) + 32)
          .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/),
        width: z.number().int().min(1).max(16384),
        height: z.number().int().min(1).max(16384),
      })
      .strict()
      .nullable(),
  })
  .strict()

export function validateSnapshot(value) {
  if (Buffer.byteLength(JSON.stringify(value)) > SNAPSHOT_MAX_BYTES) throw new Error('Search preview exceeds the size limit.')
  return snapshotSchema.parse(value)
}

const directory = (config, boardId) => path.join(boardDir(config, boardId), 'checks', 'seo')

export function saveSnapshot(config, value) {
  const snapshot = validateSnapshot(value)
  const dir = directory(config, snapshot.boardId)
  fs.mkdirSync(dir, { recursive: true })
  writeJsonAtomic(path.join(dir, `${snapshot.reportId}.json`), snapshot)
  // Keep no more previews than reports.
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && REPORT_ID_RE.test(n.slice(0, -5)))
  if (files.length > REPORTS_MAX) {
    files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs)
    for (const name of files.slice(REPORTS_MAX)) fs.rmSync(path.join(dir, name), { force: true })
  }
  return snapshot
}

export function readSnapshot(config, boardId, reportId) {
  if (!ID_RE.test(boardId) || !REPORT_ID_RE.test(String(reportId))) return null
  const file = path.join(directory(config, boardId), `${reportId}.json`)
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SNAPSHOT_MAX_BYTES) return null
    const snapshot = validateSnapshot(JSON.parse(fs.readFileSync(file, 'utf8')))
    return snapshot.boardId === boardId && snapshot.reportId === reportId ? snapshot : null
  } catch {
    return null
  }
}
