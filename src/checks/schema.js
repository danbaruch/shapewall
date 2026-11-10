import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { BUDGET_METRICS } from './budgets.js'
import { findingSeverity } from './seo-analysis.js'

export const REPORT_MAX_BYTES = 128 * 1024
export const REPORTS_MAX = 200
export const REPORT_ID_RE = /^check-[a-f0-9-]{36}$/
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
// Shared diagnostics never carry original URLs, private endpoint paths,
// raw page text, selectors, headers, error stacks or arbitrary HTML.
const text = z
  .string()
  .max(500)
  .refine((s) => !/[<>]|https?:|file:|\/[\w.~]|[?&#=]|@/i.test(s) && ![...s].some((c) => c.charCodeAt(0) < 32), 'unsafe diagnostic text')
const metric = z.number().finite().min(0).max(1e15).nullable()
export const reportSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(REPORT_ID_RE),
    runId: z.string().uuid(),
    boardId: id,
    pageId: id,
    environment: id,
    viewport: z
      .object({
        name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
        width: z.number().int().min(240).max(3840),
        height: z.number().int().min(240).max(8000),
      })
      .strict(),
    captureVersion: z
      .string()
      .regex(/^\d{8}T\d{9}Z(?:-[a-f0-9]{4})?$/)
      .nullable(),
    sampledSeparately: z.literal(true),
    state: z.enum(['complete', 'partial', 'failed', 'unsupported']),
    auditedAt: z.iso.datetime(),
    profile: z
      .object({
        runner: z.enum(['playwright', 'lighthouse', 'playwright-flow', 'axe']),
        version: z.string().regex(/^[a-zA-Z0-9.+-]{1,60}$/),
        mode: z.enum(['navigation', 'timespan', 'snapshot']),
        cache: z.enum(['new-context', 'cold', 'warm', 'auth-preserved']),
        authRole: z.enum(['anonymous', 'configured']),
        sourceBuild: hash.nullable(),
        stateFingerprint: hash,
        seo: z.boolean(),
        production: z.enum(['production', 'development', 'unknown']),
        location: z.literal('local'),
        sampleCount: z.number().int().min(1).max(10),
        authStateHash: hash.optional(),
        sourceEnvironment: id.optional(),
        flowHash: hash.optional(),
        flowStep: z.number().int().min(0).max(20).optional(),
        accessibilityVersion: z
          .string()
          .regex(/^[a-zA-Z0-9.+-]{1,60}$/)
          .optional(),
        browser: z
          .object({ version: z.string().regex(/^[a-zA-Z0-9.+-]{1,60}$/), userAgentHash: hash })
          .strict()
          .optional(),
        throttling: z
          .object({
            method: z.enum(['simulate', 'devtools', 'provided']),
            rttMs: metric,
            throughputKbps: metric,
            cpuSlowdownMultiplier: metric,
          })
          .strict()
          .optional(),
        device: z.object({ mobile: z.boolean(), deviceScaleFactor: metric, screenEmulationDisabled: z.boolean() }).strict().optional(),
      })
      .strict(),
    completeness: z
      .object({
        window: z.enum(['navigation-through-configured-actions', 'explicit-flow', 'accessibility-snapshot']),
        network: z.enum(['observed', 'partial', 'unavailable']),
        serviceWorker: z.boolean().nullable(),
        limitations: z.array(text).max(10),
      })
      .strict(),
    metrics: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,59}$/), metric).refine((v) => Object.keys(v).length <= 40),
    budgets: z
      .object({
        version: z.literal(1),
        source: z.literal('config'),
        thresholds: z.partialRecord(z.enum(Object.keys(BUDGET_METRICS)), z.number().finite().min(0).max(1e15)),
      })
      .strict()
      .optional(),
    findings: z
      .array(
        z
          .object({
            id,
            category: z.enum(['reliability', 'semantics', 'seo', 'performance', 'accessibility']),
            severity: z.enum(['warning', 'advisory']),
            title: text,
            observation: text,
            impact: text,
            nextAction: text,
          })
          .strict(),
      )
      .max(80),
  })
  .strict()

export function validateReport(value) {
  if (Buffer.byteLength(JSON.stringify(value)) > REPORT_MAX_BYTES) throw new Error('Check report exceeds the size limit.')
  return reportSchema.parse(value)
}
export const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const reportId = () => `check-${randomUUID()}`
export const summary = (report) => ({
  actionable: report.findings.filter((f) => findingSeverity(f) === 'warning').length,
  advisory: report.findings.filter((f) => findingSeverity(f) === 'advisory').length,
})

export function compareProfiles(left, right) {
  const a = validateReport(left),
    b = validateReport(right)
  const reasons = []
  if (a.boardId !== b.boardId || a.pageId !== b.pageId || a.environment !== b.environment) reasons.push('Different page or environment.')
  if (fingerprint(a.viewport) !== fingerprint(b.viewport)) reasons.push('Different viewport dimensions.')
  if (fingerprint(a.profile) !== fingerprint(b.profile)) reasons.push('Different runner conditions, build or configured state.')
  if (!['complete', 'partial'].includes(a.state) || !['complete', 'partial'].includes(b.state))
    reasons.push('A run has no usable measurements.')
  return { comparable: !reasons.length, reasons }
}
