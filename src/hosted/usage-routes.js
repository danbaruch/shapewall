// The console API for the Usage and Activity pages (src/hosted/app.js).
// Thin on purpose: every answer is one function of src/hosted/usage.js or
// src/hosted/activity.js called with the request's filter and the reader's
// scope, so a CLI command or an admin tool can call the same functions.
//
// Who reads what:
//   usage     owners and admins: the workspace. A member: the turns they
//             asked for and every turn of an agent they connected. Viewers:
//             nothing (403). No session: 401. Another workspace: 404.
//   activity  owners and admins: the workspace's log. Anyone else in the
//             workspace: their own entries.
//   access review, another person's page, an agent's page: admins and owners.
//
// Exports obey the same filter and scope as the page, are capped, and leave
// an audit entry. There are no scheduled or emailed exports.

import { exportFileName } from './admin.js'
import { ACTIVITY_LIMITS, activityCsv, activityViewer, cleanActivityFilter, createActivity, reviewCsv } from './activity.js'
import { transaction } from './db.js'
import { HttpError } from './http.js'
import { NEEDS } from './permissions.js'
import {
  USAGE_LIMITS,
  cleanBucket,
  cleanDimension,
  cleanMetric,
  cleanUsageFilter,
  createUsage,
  createViews,
  usageCsvHeader,
  usageCsvLine,
  usageRetentionDays,
  usageScope,
} from './usage.js'

export function mountUsageRoutes(consoleApi, { db, auth, now, iso, handle, limit, inWorkspace, auditOf, agentsFor }) {
  const usageOf = (req) => createUsage(req.t, { now })
  const scopeOf = (req) => usageScope(req.role, req.user.id)
  const filterOf = (req) => cleanUsageFilter(req.query, { now })
  const workspaceName = (req) => req.t.get('SELECT name FROM workspaces WHERE workspace_id = :ws').name
  // Waits for the socket to drain between pages of an export.
  const writer = (res) => (text) => {
    if (res.destroyed) throw new Error('the download was cancelled')
    if (res.write(text)) return null
    return new Promise((resolve) => {
      const done = () => {
        res.off('drain', done)
        res.off('close', done)
        resolve()
      }
      res.on('drain', done)
      res.on('close', done)
    })
  }

  // ---- Usage ----

  const usage = (path, answer) =>
    consoleApi.get(
      `/workspaces/:ws/usage${path}`,
      inWorkspace(NEEDS.usage),
      handle((req, res) => res.json(answer(req, usageOf(req), scopeOf(req)))),
    )

  usage('/options', (req, store, scope) => ({
    options: store.options(scope),
    scope: scope.all ? 'workspace' : 'own',
    retentionDays: usageRetentionDays(req.t),
    limits: { days: USAGE_LIMITS.days, exportRows: USAGE_LIMITS.exportRows },
  }))
  usage('/summary', (req, store, scope) => store.summary(filterOf(req), scope))
  usage('/series', (req, store, scope) =>
    store.series(filterOf(req), scope, {
      bucket: cleanBucket(req.query.bucket),
      groupBy: cleanDimension(req.query.groupBy, 'none'),
      metric: cleanMetric(req.query.metric),
    }),
  )
  usage('/breakdown', (req, store, scope) => {
    const groupBy = cleanDimension(req.query.groupBy)
    if (groupBy === 'none') throw new HttpError(400, 'invalid_option', 'groupBy: a dimension.')
    return { groupBy, groups: store.breakdown(filterOf(req), scope, groupBy) }
  })
  usage('/latency', (req, store, scope) => {
    const bucket = cleanBucket(req.query.bucket)
    return { bucket, buckets: store.latency(filterOf(req), scope, bucket) }
  })
  usage('/top', (req, store, scope) => store.top(filterOf(req), scope))
  usage('/budgets', (req, store, scope) => ({ projects: store.budgets(scope) }))
  usage('/rows', (req, store, scope) =>
    store.rows(filterOf(req), scope, {
      sort: req.query.sort || 'started',
      dir: req.query.dir || 'desc',
      cursor: req.query.cursor,
      limit: req.query.limit,
    }),
  )
  consoleApi.get(
    '/workspaces/:ws/usage/rows/:id',
    inWorkspace(NEEDS.usage),
    handle((req, res) => {
      // A row the reader may not see answers like one that does not exist.
      const row = usageOf(req).row(String(req.params.id), scopeOf(req))
      if (!row) throw new HttpError(404, 'unknown_row', 'No such usage record.')
      res.json({ row })
    }),
  )

  // The filtered set as a file: ?format=csv (the default) or json. Streamed
  // a page at a time, at most USAGE_LIMITS.exportRows rows, newest first.
  consoleApi.get(
    '/workspaces/:ws/usage/export',
    inWorkspace(NEEDS.usage),
    limit('usageExport', (req) => req.user.id),
    handle(async (req, res) => {
      const format = req.query.format === 'json' ? 'json' : 'csv'
      if (req.query.format && !['csv', 'json'].includes(req.query.format))
        throw new HttpError(400, 'invalid_format', 'format: csv or json.')
      const filter = filterOf(req)
      const scope = scopeOf(req)
      const store = usageOf(req)
      const total = store.totals(filter, scope).calls
      auditOf(req, 'usage_exported', null, {
        format,
        rows: Math.min(total, USAGE_LIMITS.exportRows),
        scope: scope.all ? 'workspace' : 'own',
        from: new Date(filter.fromMs).toISOString(),
        to: new Date(filter.toMs).toISOString(),
      })
      res.setHeader('Content-Type', format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${exportFileName(workspaceName(req))}-usage-${iso().slice(0, 10)}.${format}"`,
      )
      res.setHeader('X-Usage-Rows', String(Math.min(total, USAGE_LIMITS.exportRows)))
      if (total > USAGE_LIMITS.exportRows) res.setHeader('X-Usage-Truncated', String(total))
      const write = writer(res)
      try {
        if (format === 'csv') await write(usageCsvHeader())
        else await write('[')
        let sent = 0
        for (const page of store.pages(filter, scope)) {
          let text = ''
          for (const row of page) text += format === 'csv' ? usageCsvLine(row) : `${sent++ ? ',' : ''}\n  ${JSON.stringify(row)}`
          await write(text)
        }
        if (format === 'json') await write(sent ? '\n]\n' : ']\n')
        res.end()
      } catch (error) {
        res.destroy(error)
      }
    }),
  )

  // ---- Saved views (a person's own, per page) ----

  consoleApi.get(
    '/workspaces/:ws/views',
    inWorkspace(NEEDS.usage),
    handle((req, res) => {
      const page = req.query.page === 'activity' ? 'activity' : 'usage'
      res.json({ views: createViews(req.t, { now }).list(req.user.id, page) })
    }),
  )
  consoleApi.post(
    '/workspaces/:ws/views',
    inWorkspace(NEEDS.usage),
    handle((req, res) => {
      const view = transaction(db, () => createViews(req.t, { now }).save(req.user.id, req.body || {}))
      res.status(201).json({ view })
    }),
  )
  consoleApi.delete(
    '/workspaces/:ws/views/:id',
    inWorkspace(NEEDS.usage),
    handle((req, res) => {
      createViews(req.t, { now }).remove(req.user.id, req.params.id)
      res.json({ ok: true })
    }),
  )

  // ---- Activity ----

  const activityOf = (req) => createActivity(req.t, { db, now })
  const viewerOf = (req) => activityViewer(req.role, req.user.id)

  consoleApi.get(
    '/workspaces/:ws/activity',
    inWorkspace(NEEDS.activity),
    handle((req, res) => {
      const viewer = viewerOf(req)
      res.json({
        ...activityOf(req).list(cleanActivityFilter(req.query), viewer, {
          before: req.query.before,
          limit: req.query.limit || ACTIVITY_LIMITS.page,
        }),
        scope: viewer.all ? 'workspace' : 'own',
      })
    }),
  )
  consoleApi.get(
    '/workspaces/:ws/activity/filters',
    inWorkspace(NEEDS.activity),
    handle((req, res) => res.json(activityOf(req).filters(viewerOf(req)))),
  )
  // The same filters as a CSV file (at most ACTIVITY_LIMITS.exportRows rows).
  consoleApi.get(
    '/workspaces/:ws/activity/export',
    inWorkspace(NEEDS.activity),
    limit('usageExport', (req) => req.user.id),
    handle((req, res) => {
      const viewer = viewerOf(req)
      const { entries } = activityOf(req).list(cleanActivityFilter(req.query), viewer, { limit: ACTIVITY_LIMITS.exportRows })
      auditOf(req, 'audit_exported', null, { rows: entries.length, scope: viewer.all ? 'workspace' : 'own', view: 'activity' })
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${exportFileName(workspaceName(req))}-activity-${iso().slice(0, 10)}.csv"`,
      )
      res.send(activityCsv(entries))
    }),
  )
  // One person: admins and owners, or the person themselves. Anyone else
  // gets the same 404 as for someone who is not in the workspace.
  consoleApi.get(
    '/workspaces/:ws/people/:uid',
    inWorkspace(NEEDS.activity),
    handle((req, res) => {
      const person = activityOf(req).person(String(req.params.uid), viewerOf(req), {
        sessionsOf: (userId) => auth.listSessions(userId, null),
      })
      if (!person) throw new HttpError(404, 'unknown_member', 'No such member.')
      res.json({ person })
    }),
  )
  // One agent, for its page (activity and usage are fetched with ?agent=).
  consoleApi.get(
    '/workspaces/:ws/agents/:aid/profile',
    inWorkspace(NEEDS.accessReview),
    handle((req, res) => {
      const agent = transaction(db, () =>
        agentsFor(req.t).consoleList(null, { audit: (action, target, detail) => auditOf(req, action, target, detail) }),
      ).find((item) => item.id === String(req.params.aid))
      if (!agent) throw new HttpError(404, 'unknown_agent', 'No such agent.')
      res.json({ agent })
    }),
  )

  // ---- Access review ----

  const reviewOf = (req) =>
    activityOf(req).review({
      agents: transaction(db, () =>
        agentsFor(req.t).consoleList(null, { audit: (action, target, detail) => auditOf(req, action, target, detail) }),
      ),
    })
  consoleApi.get(
    '/workspaces/:ws/access-review',
    inWorkspace(NEEDS.accessReview),
    handle((req, res) => res.json(reviewOf(req))),
  )
  consoleApi.get(
    '/workspaces/:ws/access-review/export',
    inWorkspace(NEEDS.accessReview),
    limit('usageExport', (req) => req.user.id),
    handle((req, res) => {
      const data = reviewOf(req)
      auditOf(req, 'access_exported', null, {
        people: data.people.length,
        tokens: data.tokens.length,
        agents: data.agents.length,
        shares: data.shares.length,
      })
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${exportFileName(workspaceName(req))}-access-review-${iso().slice(0, 10)}.csv"`,
      )
      res.send(reviewCsv(data))
    }),
  )
}
