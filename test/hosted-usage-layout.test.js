// The layout of the Usage dashboard on a hosted server: a person saves,
// reads and resets their own layout and nobody else's; owners set the
// layout everyone starts from (audited); a saved view can carry a layout
// for whoever opens its link; viewers, guests, project tokens, people who
// are signed out and other workspaces get nothing; and what is stored is
// always a checked layout, whatever was sent.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import * as helpers from './hosted-helpers.js'
import { seedWorkspace } from './fixtures/usage-seed.js'
import { tenant } from '../src/hosted/tenancy.js'
import { createLayouts, createViews } from '../src/hosted/usage.js'
import { LAYOUT_LIMITS, defaultLayout, duplicateItem, moveItem, removeItem, resizeItem, setOptions } from '../src/hosted/usage-layout.js'

const { createBrowser, invite, reauth, signUp, startHostedServer, tokenCall } = helpers

let hosted
let s
let other
const api = (rest, ws = s.ws) => `/api/workspaces/${ws}${rest}`
const put = (person, path, body) => person.browser.call('PUT', api(path), { body })
const del = (person, path) => person.browser.call('DELETE', api(path))
const layoutOf = async (person) => {
  const result = await person.browser.get(api('/usage/layout'))
  assert.equal(result.status, 200, result.text)
  return result.json
}
const rows = (kind) => hosted.db.prepare('SELECT * FROM usage_layouts WHERE kind = ? ORDER BY subject').all(kind)
const audits = (action) =>
  hosted.db
    .prepare('SELECT user_id, detail FROM audit_log WHERE workspace_id = ? AND action = ? ORDER BY id')
    .all(s.ws, action)
    .map((row) => ({ user: row.user_id, detail: JSON.parse(row.detail || '{}') }))
// Layouts a person might make.
const tall = () => resizeItem(defaultLayout(), 'latency', 6, 7)
const noTiles = () => ['tile_cost', 'tile_fixes', 'tile_failed'].reduce((layout, id) => removeItem(layout, id), defaultLayout())
const twoCharts = () => {
  const half = resizeItem(defaultLayout(), 'time', 6, 6)
  const { layout, id } = duplicateItem(half, 'time')
  return setOptions(layout, id, { metric: 'tokens', by: 'model', bucket: 'week', style: 'lines' })
}

before(async () => {
  hosted = await startHostedServer('usage-layout', { signup: 'open' })
  s = await seedWorkspace(hosted, helpers)
  other = await signUp(hosted, { handle: 'mal', displayName: 'Mal' })
})
beforeEach(() => hosted.rateLimiter.reset())
after(async () => {
  await hosted.close()
})

test('a person starts with no layout of their own, saves one, reads it back, and resets it', async () => {
  assert.deepEqual(await layoutOf(s.cyd), { layout: null, default: null, canSetDefault: false })
  const saved = await put(s.cyd, '/usage/layout', { layout: tall() })
  assert.equal(saved.status, 200, saved.text)
  assert.deepEqual(saved.json.layout, tall())
  assert.deepEqual((await layoutOf(s.cyd)).layout, tall())
  // Saving again replaces it: one row per person.
  assert.equal((await put(s.cyd, '/usage/layout', { layout: twoCharts() })).status, 200)
  const mine = (await layoutOf(s.cyd)).layout
  assert.deepEqual(mine, twoCharts())
  assert.deepEqual(
    mine.items.filter((item) => item.type === 'time').map((item) => [item.id, item.w, item.options.metric, item.options.style]),
    [
      ['time', 6, 'calls', 'stacked'],
      ['time-2', 6, 'tokens', 'lines'],
    ],
    'two charts over time, each with its own options',
  )
  assert.equal(rows('person').filter((row) => row.subject === s.cyd.user.id).length, 1)
  // Reset: back to no layout of their own.
  const reset = await del(s.cyd, '/usage/layout')
  assert.equal(reset.status, 200, reset.text)
  assert.deepEqual(reset.json, { layout: null, default: null, canSetDefault: false })
  assert.equal(rows('person').filter((row) => row.subject === s.cyd.user.id).length, 0)
  assert.equal((await del(s.cyd, '/usage/layout')).status, 200, 'resetting twice is fine')
})

test('each person has their own: nobody reads or writes another member’s layout', async () => {
  assert.equal((await put(s.ada, '/usage/layout', { layout: tall() })).status, 200)
  assert.equal((await put(s.cyd, '/usage/layout', { layout: noTiles() })).status, 200)
  assert.deepEqual((await layoutOf(s.ada)).layout, tall())
  assert.deepEqual((await layoutOf(s.cyd)).layout, noTiles())
  assert.equal((await layoutOf(s.ben)).layout, null, 'an admin sees their own (none), not anyone else’s')
  // There is no address for another person's layout, and a user id in the request changes nothing.
  for (const path of [
    `/usage/layout/${s.ada.user.id}`,
    `/usage/layout?user=${s.ada.user.id}`,
    `/usage/layouts`,
    `/usage/layout/person/${s.ada.user.id}`,
  ]) {
    const result = await s.cyd.browser.get(api(path))
    assert.ok(result.status === 404 || (result.status === 200 && JSON.stringify(result.json.layout) === JSON.stringify(noTiles())), path)
    assert.ok(!result.text.includes('"h":7'), `${path} never answers with Ada's layout`)
  }
  const sneaky = await put(s.cyd, '/usage/layout', {
    layout: twoCharts(),
    userId: s.ada.user.id,
    user: s.ada.user.id,
    subject: s.ada.user.id,
  })
  assert.equal(sneaky.status, 200)
  assert.deepEqual((await layoutOf(s.ada)).layout, tall(), 'Ada’s layout is untouched')
  assert.deepEqual((await layoutOf(s.cyd)).layout, twoCharts())
  assert.equal((await del(s.cyd, `/usage/layout/${s.ada.user.id}`)).status, 404)
  await del(s.cyd, '/usage/layout')
  assert.deepEqual((await layoutOf(s.ada)).layout, tall(), 'a reset is the person’s own too')
})

test('no access: a viewer, a share link guest, a project token, nobody signed in, another workspace, another site', async () => {
  const signedOut = createBrowser(hosted.port, hosted.origin)
  await reauth(s.ada)
  await s.ada.browser.call('PATCH', api('/settings'), { body: { shareLinks: true } })
  const share = await s.ada.browser.post(api(`/projects/${s.projects[0].id}/shares`), {
    mode: 'view',
    name: 'For a guest',
    expiresInDays: 7,
  })
  assert.equal(share.status, 201, share.text)
  const guest = createBrowser(hosted.port, hosted.origin)
  assert.equal((await guest.post('/api/shares/open', { token: new URL(share.json.url).hash.slice(1), name: 'Gus' })).status, 200)
  const view = (await s.ada.browser.post(api('/views'), { page: 'usage', name: 'With a layout', query: 'range=7d', layout: tall() })).json
    .view
  const before = JSON.stringify([rows('person'), rows('default'), rows('view')])
  const calls = [
    ['GET', '/usage/layout'],
    ['PUT', '/usage/layout', { layout: noTiles() }],
    ['DELETE', '/usage/layout'],
    ['PUT', '/usage/layout/default', { layout: noTiles() }],
    ['DELETE', '/usage/layout/default'],
    ['GET', `/views/${view.id}/layout`],
  ]
  for (const [method, path, body] of calls) {
    const name = `${method} ${path}`
    // No session at all.
    assert.equal((await signedOut.call(method, api(path), { body })).status, 401, `signed out: ${name}`)
    assert.equal((await guest.call(method, api(path), { body })).status, 401, `guest: ${name}`)
    // A project token is not a session (a write with one is turned away before it is even looked at).
    assert.ok(
      [401, 403].includes((await tokenCall(hosted, s.agents[0].token, method, api(path), { body })).status),
      `project token: ${name}`,
    )
    // A viewer has no Usage page.
    const viewer = await s.viewer.browser.call(method, api(path), { body })
    assert.equal(viewer.status, 403, `viewer: ${name}`)
    assert.doesNotMatch(viewer.text, /tile_|"items"/)
    // Someone from another workspace: this one does not exist for them.
    const outsider = await other.browser.call(method, api(path), { body })
    assert.equal(outsider.status, 404, `another workspace: ${name}`)
    assert.doesNotMatch(outsider.text, /tile_|"items"/)
    // A write sent from another site.
    if (method !== 'GET') {
      const crossSite = await s.ada.browser.call(method, api(path), {
        body,
        headers: { Origin: 'https://evil.example' },
        sendOrigin: false,
      })
      assert.equal(crossSite.status, 403, `another origin: ${name}`)
    }
  }
  assert.equal(JSON.stringify([rows('person'), rows('default'), rows('view')]), before, 'nothing was written or removed')
  // A view of this workspace is not reachable through another workspace's address, and the other way round.
  assert.equal((await other.browser.get(api(`/views/${view.id}/layout`, other.workspaceId))).status, 404)
  assert.equal((await s.ada.browser.get(api(`/views/${view.id}/layout`, other.workspaceId))).status, 404)
  const theirs = await other.browser.call('PUT', api('/usage/layout', other.workspaceId), { body: { layout: noTiles() } })
  assert.equal(theirs.status, 200)
  assert.deepEqual((await layoutOf(s.ada)).layout, tall(), 'a layout saved in one workspace is not the layout of another')
  assert.equal((await s.ada.browser.get(api('/usage/layout', other.workspaceId))).status, 404)
})

test('what is stored is a checked layout: junk is refused, unknown widgets and impossible sizes are dropped', async () => {
  const stored = () => rows('person').find((row) => row.subject === s.ben.user.id)
  for (const [body, status, code] of [
    [{}, 400, 'invalid_layout'],
    [{ layout: null }, 400, 'invalid_layout'],
    [{ layout: 'default' }, 400, 'invalid_layout'],
    [{ layout: 7 }, 400, 'invalid_layout'],
    [{ layout: { v: 1 } }, 400, 'invalid_layout'],
    [{ layout: { v: 1, items: 'all' } }, 400, 'invalid_layout'],
    [{ layout: { v: 99, items: [] } }, 400, 'invalid_layout'],
    [{ layout: { v: 1, items: [], pad: 'x'.repeat(LAYOUT_LIMITS.bytes) } }, 413, 'layout_too_large'],
    // Larger than any request body the console's API reads.
    [
      { layout: { v: 1, items: Array.from({ length: 2000 }, (_, n) => ({ id: `t${n}`, type: 'tile_calls', x: 0, y: n, w: 4, h: 2 })) } },
      413,
      'too_large',
    ],
  ]) {
    const result = await put(s.ben, '/usage/layout', body)
    assert.equal(result.status, status, `${JSON.stringify(body).slice(0, 60)}: ${result.text}`)
    assert.equal(result.json.error.code, code)
    assert.equal(stored(), undefined, 'nothing was stored')
  }
  // Far more than the server reads at all.
  const enormous = await put(s.ben, '/usage/layout', { layout: { v: 1, items: [], pad: 'x'.repeat(3_000_000) } })
  assert.ok([400, 413].includes(enormous.status), `status ${enormous.status}`)
  assert.equal(stored(), undefined)

  // A layout with good and bad items: only what can be drawn is kept.
  const mixed = await put(s.ben, '/usage/layout', {
    layout: {
      v: 1,
      evil: '<script>alert(1)</script>',
      items: [
        {
          id: 'time',
          type: 'time',
          x: 0,
          y: 0,
          w: 12,
          h: 6,
          options: { metric: 'tokens', by: "agent'; DROP TABLE usage_layouts;--", onload: 'x' },
        },
        { id: 'clock', type: 'clock', x: 0, y: 6, w: 4, h: 2 },
        { id: 'tile_calls', type: 'tile_calls', x: 0, y: 6, w: 400, h: 2 },
        { id: 'tile_tokens', type: 'tile_tokens', x: 0, y: 6, w: 4, h: 2, html: '<img src=x onerror=alert(1)>' },
        { id: 'outcomes', type: 'outcomes', x: -3, y: 8, w: 6, h: 5 },
        { id: 'latency', type: 'latency', x: 0, y: 8, w: 6, h: 5.5 },
        { id: '<b>', type: 'approvals', x: 0, y: 8, w: 6, h: 5 },
        { id: 'tile_cost', type: '__proto__', x: 0, y: 8, w: 4, h: 2 },
        { id: 'breakdown', type: 'breakdown', x: 6, y: 0, w: 6, h: 5, options: { rows: 100000, share: 'no' } },
        null,
        'budgets',
      ],
    },
  })
  assert.equal(mixed.status, 200, mixed.text)
  assert.deepEqual(
    mixed.json.layout.items.map((item) => [item.id, item.x, item.y, item.w, item.h]),
    [
      ['time', 0, 0, 12, 6],
      ['tile_tokens', 0, 6, 4, 2],
      ['breakdown', 6, 6, 6, 5],
    ],
    'the overlap was pulled apart too',
  )
  assert.deepEqual(mixed.json.layout.items[0].options, {
    metric: 'tokens',
    by: 'agent',
    bucket: 'auto',
    style: 'stacked',
    legend: true,
    brush: true,
    view: 'chart',
  })
  assert.deepEqual(mixed.json.layout.items[2].options, { by: 'project', metric: 'chart', rows: 8, share: true, view: 'chart' })
  const text = stored().layout
  assert.doesNotMatch(text, /script|onerror|DROP|clock|evil|html|onload/)
  assert.deepEqual(JSON.parse(text), mixed.json.layout)
  assert.ok(hosted.db.prepare("SELECT name FROM sqlite_master WHERE name = 'usage_layouts'").get(), 'the table is still there')

  // A row that was tampered with in the database is checked again on the way out: never handed over as it is.
  const set = (layout) =>
    hosted.db.prepare("UPDATE usage_layouts SET layout = ? WHERE kind = 'person' AND subject = ?").run(layout, s.ben.user.id)
  set('{not json')
  assert.equal((await layoutOf(s.ben)).layout, null)
  set(
    JSON.stringify({
      v: 1,
      items: [
        { id: 'x', type: 'iframe', x: 0, y: 0, w: 12, h: 9, src: 'https://evil.example' },
        { id: 'tile_calls', type: 'tile_calls', x: 0, y: 4, w: 4, h: 2 },
      ],
    }),
  )
  assert.deepEqual(
    (await layoutOf(s.ben)).layout.items.map((item) => [item.id, item.y]),
    [['tile_calls', 0]],
  )
  set(JSON.stringify({ v: 7, items: [] }))
  assert.equal((await layoutOf(s.ben)).layout, null, 'a layout from a newer build reads as none')
  await del(s.ben, '/usage/layout')
})

test('the workspace default: owners set and remove it, it is audited, and everyone without their own layout gets it', async () => {
  // Only an owner. An admin and a member are refused, and nothing is written or logged.
  for (const person of [s.ben, s.cyd]) {
    assert.equal((await put(person, '/usage/layout/default', { layout: noTiles() })).status, 403)
    assert.equal((await del(person, '/usage/layout/default')).status, 403)
    assert.equal((await layoutOf(person)).canSetDefault, false)
  }
  assert.deepEqual(rows('default'), [])
  assert.deepEqual(audits('usage_layout_default_set'), [])
  assert.equal((await layoutOf(s.ada)).canSetDefault, true)

  const set = await put(s.ada, '/usage/layout/default', { layout: noTiles() })
  assert.equal(set.status, 200, set.text)
  assert.deepEqual(set.json.default, noTiles())
  assert.deepEqual(audits('usage_layout_default_set'), [{ user: s.ada.user.id, detail: { widgets: noTiles().items.length } }])
  // Everyone reads it; a person's own layout still comes first (the page shows `layout` when there is one).
  assert.deepEqual(await layoutOf(s.cyd), { layout: null, default: noTiles(), canSetDefault: false })
  assert.deepEqual(await layoutOf(s.ben), { layout: null, default: noTiles(), canSetDefault: false })
  assert.deepEqual(await layoutOf(s.ada), { layout: tall(), default: noTiles(), canSetDefault: true })
  // Someone who joins later starts from it.
  await reauth(s.ada)
  const dee = await signUp(hosted, { handle: 'dee', displayName: 'Dee', invite: await invite(s.ada, s.ws, 'member') })
  assert.deepEqual(await layoutOf(dee), { layout: null, default: noTiles(), canSetDefault: false })
  // Their own change is theirs alone; resetting brings the default back.
  assert.equal((await put(dee, '/usage/layout', { layout: twoCharts() })).status, 200)
  assert.deepEqual((await layoutOf(dee)).layout, twoCharts())
  assert.equal((await layoutOf(s.cyd)).layout, null)
  assert.deepEqual((await del(dee, '/usage/layout')).json, { layout: null, default: noTiles(), canSetDefault: false })
  // The default is checked like any layout.
  assert.equal((await put(s.ada, '/usage/layout/default', { layout: { v: 1 } })).status, 400)
  assert.equal((await put(s.ada, '/usage/layout/default', {})).status, 400)
  const cleaned = await put(s.ada, '/usage/layout/default', {
    layout: {
      v: 1,
      items: [
        { id: 'time', type: 'time', x: 0, y: 3, w: 12, h: 6 },
        { id: 'nope', type: 'nope', x: 0, y: 0, w: 1, h: 1 },
      ],
    },
  })
  assert.deepEqual(
    cleaned.json.default.items.map((item) => [item.id, item.y]),
    [['time', 0]],
  )
  assert.equal(audits('usage_layout_default_set').length, 2)
  assert.equal(audits('usage_layout_default_set')[1].detail.widgets, 1)
  assert.equal(rows('default').length, 1)
  assert.equal(rows('default')[0].updated_by, s.ada.user.id)
  // It is this workspace's only.
  assert.equal((await other.browser.get(api('/usage/layout', other.workspaceId))).json.default, null)

  // Removing it: audited once, and people see the built-in layout again.
  assert.equal((await del(s.ada, '/usage/layout/default')).status, 200)
  assert.deepEqual(audits('usage_layout_default_removed'), [{ user: s.ada.user.id, detail: {} }])
  assert.equal((await del(s.ada, '/usage/layout/default')).status, 200)
  assert.equal(audits('usage_layout_default_removed').length, 1, 'nothing to remove, nothing to log')
  assert.deepEqual(await layoutOf(s.cyd), { layout: null, default: null, canSetDefault: false })
  // The audit entries read as sentences on the Activity page's data.
  const activity = (await s.ada.browser.get(api('/activity?group=settings&limit=50'))).json.entries.map((entry) => entry.action)
  assert.ok(activity.includes('usage_layout_default_set') && activity.includes('usage_layout_default_removed'))
})

test('a saved view can carry a layout: its link shows the layout to whoever opens it, and replaces nobody’s own', async () => {
  const mine = async (person) => (await person.browser.get(api('/views?page=usage'))).json.views
  const plain = await s.cyd.browser.post(api('/views'), { page: 'usage', name: 'Failures', query: 'outcome=failed' })
  assert.equal(plain.status, 201, plain.text)
  assert.equal(plain.json.view.hasLayout, false)
  const withLayout = await s.cyd.browser.post(api('/views'), {
    page: 'usage',
    name: 'Weekly tokens',
    query: 'range=90d',
    layout: twoCharts(),
  })
  assert.equal(withLayout.status, 201, withLayout.text)
  assert.equal(withLayout.json.view.hasLayout, true)
  assert.equal(withLayout.json.view.layout, undefined, 'the list of views does not carry every layout')
  assert.deepEqual(
    (await mine(s.cyd)).map((view) => [view.name, view.hasLayout]),
    [
      ['Failures', false],
      ['Weekly tokens', true],
    ],
  )
  const id = withLayout.json.view.id
  // Anyone here with the Usage page who has the link reads the view's name and layout: an admin, another member, its maker.
  for (const person of [s.ada, s.ben, s.cyd]) {
    const shown = await person.browser.get(api(`/views/${id}/layout`))
    assert.equal(shown.status, 200, shown.text)
    assert.deepEqual(shown.json, { view: { id, name: 'Weekly tokens', layout: twoCharts() } })
  }
  // Reading it changed nobody's own layout, and the view is still only its maker's.
  assert.deepEqual((await layoutOf(s.ada)).layout, tall())
  assert.equal((await layoutOf(s.ben)).layout, null)
  assert.equal((await layoutOf(s.cyd)).layout, null)
  assert.deepEqual(
    (await mine(s.ben)).map((view) => view.name),
    [],
  )
  assert.equal((await del(s.ben, `/views/${id}`)).status, 404, 'only its maker removes a view')
  // "Use this layout" is an ordinary save of one's own.
  assert.equal((await put(s.ben, '/usage/layout', { layout: twoCharts() })).status, 200)
  assert.deepEqual((await layoutOf(s.ben)).layout, twoCharts())
  assert.equal((await layoutOf(s.cyd)).layout, null)
  await del(s.ben, '/usage/layout')
  // A view without a layout, an unknown view and a view of the Activity page have none to show.
  assert.equal((await s.ada.browser.get(api(`/views/${plain.json.view.id}/layout`))).status, 404)
  assert.equal((await s.ada.browser.get(api('/views/vw_nothing/layout'))).status, 404)
  const activity = await s.cyd.browser.post(api('/views'), { page: 'activity', name: 'Mine', query: '' })
  assert.equal((await s.ada.browser.get(api(`/views/${activity.json.view.id}/layout`))).status, 404)
  assert.equal((await s.cyd.browser.post(api('/views'), { page: 'activity', name: 'With one', query: '', layout: tall() })).status, 400)
  // The layout of a view is checked like any other.
  assert.equal((await s.cyd.browser.post(api('/views'), { page: 'usage', name: 'Bad', query: '', layout: { v: 1 } })).status, 400)
  assert.equal(
    (
      await s.cyd.browser.post(api('/views'), {
        page: 'usage',
        name: 'Big',
        query: '',
        layout: { v: 1, items: [], pad: 'x'.repeat(20000) },
      })
    ).status,
    413,
  )
  assert.deepEqual(
    (await mine(s.cyd)).map((view) => view.name),
    ['Failures', 'Weekly tokens'],
    'a refused view was not saved',
  )
  // Saving the same name again without a layout takes the layout away; with one, replaces it.
  await s.cyd.browser.post(api('/views'), { page: 'usage', name: 'Weekly tokens', query: 'range=90d' })
  assert.equal((await s.ada.browser.get(api(`/views/${id}/layout`))).status, 404)
  await s.cyd.browser.post(api('/views'), { page: 'usage', name: 'Weekly tokens', query: 'range=90d', layout: noTiles() })
  assert.deepEqual((await s.ada.browser.get(api(`/views/${id}/layout`))).json.view.layout, noTiles())
  // Deleting the view deletes its layout.
  assert.equal((await del(s.cyd, `/views/${id}`)).status, 200)
  assert.equal((await s.ada.browser.get(api(`/views/${id}/layout`))).status, 404)
  assert.equal(rows('view').filter((row) => row.subject === id).length, 0)
})

test('layouts leave with their person: removed from the workspace, or the account deleted', async () => {
  await reauth(s.ada)
  const eve = await signUp(hosted, { handle: 'eve', displayName: 'Eve', invite: await invite(s.ada, s.ws, 'member') })
  assert.equal((await put(eve, '/usage/layout', { layout: tall() })).status, 200)
  const view = (await eve.browser.post(api('/views'), { page: 'usage', name: 'Eve’s', query: '', layout: noTiles() })).json.view
  const count = () => [
    rows('person').filter((row) => row.subject === eve.user.id).length,
    rows('view').filter((row) => row.subject === view.id).length,
  ]
  assert.deepEqual(count(), [1, 1])
  const kept = rows('person').filter((row) => row.subject !== eve.user.id).length
  await reauth(s.ada)
  assert.equal((await s.ada.browser.call('DELETE', api(`/members/${eve.user.id}`))).status, 200)
  assert.deepEqual(count(), [0, 0])
  assert.equal(rows('person').filter((row) => row.subject !== eve.user.id).length, kept, 'nobody else’s went')
  assert.equal((await s.ada.browser.get(api(`/views/${view.id}/layout`))).status, 404)

  // An account that is deleted: its layouts in every workspace it was in.
  await reauth(s.ada)
  const fay = await signUp(hosted, { handle: 'fay', displayName: 'Fay', invite: await invite(s.ada, s.ws, 'member') })
  assert.equal((await put(fay, '/usage/layout', { layout: tall() })).status, 200)
  const hers = (await fay.browser.post(api('/views'), { page: 'usage', name: 'Fay’s', query: '', layout: tall() })).json.view
  await reauth(fay)
  assert.equal((await fay.browser.call('DELETE', '/auth/me', { body: { confirm: 'fay' } })).status, 200)
  assert.equal(rows('person').filter((row) => row.subject === fay.user.id).length, 0)
  assert.equal(rows('view').filter((row) => row.subject === hers.id).length, 0)
  assert.deepEqual((await layoutOf(s.ada)).layout, tall(), 'everyone else keeps theirs')
})

test('one function per operation, for a later admin tool: the store does what the routes do', async () => {
  const t = tenant(hosted.db, s.ws)
  const at = new Date('2026-03-04T05:06:07.000Z')
  const layouts = createLayouts(t, { now: () => at })
  const heard = []
  const audit = (action, target, detail) => heard.push([action, target, detail])
  assert.equal(layouts.mine('us_nobody'), null)
  assert.deepEqual(layouts.save(s.cyd.user.id, twoCharts()), twoCharts())
  assert.deepEqual(layouts.mine(s.cyd.user.id), twoCharts())
  assert.equal(rows('person').find((row) => row.subject === s.cyd.user.id).updated_at, at.toISOString())
  assert.throws(
    () => layouts.save(s.cyd.user.id, { v: 1 }),
    (error) => error.statusCode === 400 && error.code === 'invalid_layout',
  )
  assert.deepEqual(layouts.mine(s.cyd.user.id), twoCharts(), 'a refused save leaves what was there')
  assert.equal(layouts.reset(s.cyd.user.id), true)
  assert.equal(layouts.reset(s.cyd.user.id), false)
  assert.equal(layouts.shared(), null)
  assert.deepEqual(layouts.setDefault(s.ada.user.id, noTiles(), { audit }), noTiles())
  assert.deepEqual(layouts.shared(), noTiles())
  layouts.clearDefault({ audit })
  layouts.clearDefault({ audit })
  assert.deepEqual(heard, [
    ['usage_layout_default_set', null, { widgets: noTiles().items.length }],
    ['usage_layout_default_removed', null, {}],
  ])
  // Another workspace's handle sees none of it.
  const elsewhere = createLayouts(tenant(hosted.db, other.workspaceId))
  layouts.save(s.cyd.user.id, tall())
  assert.equal(elsewhere.mine(s.cyd.user.id), null)
  assert.equal(elsewhere.shared(), null)
  assert.equal(createViews(tenant(hosted.db, other.workspaceId)).layoutOf('vw_anything'), null)
  layouts.reset(s.cyd.user.id)
  // Moving a widget through the model and saving it round-trips exactly.
  const moved = moveItem(defaultLayout(), 'latency', 6, 0)
  assert.deepEqual(layouts.save(s.cyd.user.id, moved), moved)
  assert.deepEqual(layouts.mine(s.cyd.user.id), moved)
  layouts.reset(s.cyd.user.id)
})

test('the charts the options ask for: four percentiles of turn duration, and top lists of up to ten', async () => {
  const WIDE = 'from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z'
  const [agent] = s.agents
  const insert = hosted.db.prepare(
    `INSERT INTO agent_runs (workspace_id, project_id, id, kind, agent_id, board_id, thread_id, asked_by, started_at, ended_at, outcome, input_tokens,
       output_tokens, duration_ms, agent_owner) VALUES (?, ?, ?, 'chat', ?, 'home', ?, ?, ?, ?, 'answered', ?, 10, ?, ?)`,
  )
  // 200 turns of 1 to 200 seconds, each in a thread of its own.
  for (let n = 1; n <= 200; n += 1)
    insert.run(
      s.ws,
      agent.projectId,
      `run_p${String(n).padStart(4, '0')}`,
      agent.id,
      `comment-${n}`,
      s.ada.user.id,
      '2026-06-01T10:00:00.000Z',
      '2026-06-01T10:05:00.000Z',
      n * 100,
      n * 1000,
      s.ada.user.id,
    )
  const latency = (await s.ada.browser.get(api(`/usage/latency?${WIDE}&bucket=month`))).json.buckets.find((bucket) => bucket.turns)
  assert.deepEqual(
    [latency.turns, latency.p50, latency.p90, latency.p95, latency.p99, latency.longest],
    [200, 100_000, 180_000, 190_000, 198_000, 200_000],
  )
  const summary = (await s.ada.browser.get(api(`/usage/summary?${WIDE}`))).json.current.latency
  assert.deepEqual([summary.p50, summary.p90, summary.p95, summary.p99], [100_000, 180_000, 190_000, 198_000])
  // Five entries unless asked, up to ten, never more.
  const top = async (limit) => await s.ada.browser.get(api(`/usage/top?${WIDE}${limit === null ? '' : `&limit=${limit}`}`))
  assert.deepEqual([(await top(null)).json.slowest.length, (await top(null)).json.threads.length], [5, 5])
  assert.deepEqual([(await top(3)).json.slowest.length, (await top(3)).json.threads.length], [3, 3])
  const ten = (await top(10)).json
  assert.deepEqual([ten.slowest.length, ten.threads.length], [10, 10])
  assert.deepEqual(
    ten.slowest.map((row) => row.durationMs),
    [200, 199, 198, 197, 196, 195, 194, 193, 192, 191].map((n) => n * 1000),
  )
  assert.deepEqual(
    ten.threads.slice(0, 2).map((row) => row.tokens),
    [20_010, 19_910],
  )
  for (const bad of [0, 11, 1000, -1, 'all', '5;DROP', 2.5]) assert.equal((await top(bad)).status, 400, `limit=${bad}`)
  // A member's lists stay inside what they may read.
  assert.equal((await s.cyd.browser.get(api(`/usage/top?${WIDE}&limit=10`))).json.slowest.length, 0)
})
