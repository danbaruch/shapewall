import { randomUUID } from 'node:crypto'
import { reportId } from '../src/checks/schema.js'
import { targetFingerprint } from '../src/checks/store.js'
import { entryVersion, readManifest } from '../src/store.js'

export function checkReport(
  config,
  { pageId = 'home', viewport = 'desktop', runner = 'playwright', state = 'complete', finding = true } = {},
) {
  const board = config.boards[0],
    page = board.pages.find((p) => p.id === pageId),
    environment = board.environments[0]
  const manifest = readManifest(config, board.id)
  return {
    schemaVersion: 1,
    id: reportId(),
    runId: randomUUID(),
    boardId: board.id,
    pageId,
    environment: environment.id,
    viewport: { name: viewport, ...config.viewports[viewport] },
    captureVersion: entryVersion(manifest?.pages?.[pageId]?.[viewport], manifest),
    sampledSeparately: true,
    state,
    auditedAt: new Date().toISOString(),
    profile: {
      runner,
      version: '1.0.0',
      mode: 'navigation',
      cache: 'new-context',
      authRole: 'anonymous',
      sourceBuild: null,
      stateFingerprint: targetFingerprint(config, board, page, environment, viewport),
      seo: false,
      production: 'unknown',
      location: 'local',
      sampleCount: 1,
    },
    completeness: {
      window: 'navigation-through-configured-actions',
      network: 'observed',
      serviceWorker: null,
      limitations: ['Separately sampled from the screenshot.'],
    },
    metrics: { loadMs: 120, resourceTransferBytes: null },
    findings: finding
      ? [
          {
            id: 'http-errors',
            category: 'reliability',
            severity: 'warning',
            title: 'Error responses during load',
            observation: 'An API returned HTTP 429 during load.',
            impact: 'The page may show incomplete data.',
            nextAction: 'Inspect the original application network panel.',
          },
        ]
      : [],
  }
}
