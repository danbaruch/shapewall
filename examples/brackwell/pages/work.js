// The day-to-day app: home, work orders (lists, board, detail, dialogs and
// their empty, loading and error states), the schedule and dispatch.
import { ME, TECHS, WORK_ORDERS, WEEK } from '../data.js'
import { app } from '../shells.js'
import {
  avatar,
  badge,
  barChart,
  btn,
  card,
  emptyState,
  esc,
  field,
  icon,
  map,
  money,
  pageHead,
  photo,
  prio,
  skeletonRows,
  spark,
  stat,
  status,
  table,
  tabs,
} from '../ui.js'

const H = 'Home'
const W = 'Work orders'
const S = 'Schedule & dispatch'

const WO_COLS = [
  { label: 'Job' },
  { label: 'Customer', cls: 'hide-sm' },
  { label: 'Status' },
  { label: 'Priority', cls: 'hide-sm' },
  { label: 'Technician', cls: 'hide-sm' },
  { label: 'Due', cls: 'hide-sm' },
]
const woRow = (job) => [
  `<a href="/app/work-orders/wo-4823/" style="color:var(--ink)"><strong>${esc(job.title)}</strong></a><div class="muted small mono">${job.id}</div>`,
  esc(job.customer),
  status(job.state),
  prio(job.prio),
  job.tech ? `<span class="row">${avatar(job.tech, 'sm')}${esc(job.tech)}</span>` : '<span class="faint">Unassigned</span>',
  `<span class="num">${job.due}</span>`,
]

const woTabs = (active) =>
  tabs(
    [
      ['All', '/app/work-orders/', 48],
      ['Urgent', '/app/work-orders/urgent/', 6],
      ['Unassigned', '/app/dispatch/unassigned/', 7],
      ['Board', '/app/work-orders/board/'],
    ],
    active,
  )

const woHead = (sub = '48 jobs, 31 open') =>
  pageHead({
    title: 'Work orders',
    sub,
    acts: `${btn('Export', { ic: 'download' })}${btn('New work order', { kind: 'primary', ic: 'plus', href: '/app/work-orders/new/', attrs: ' data-testid="new-wo"' })}`,
  })

const toolbar = (chips = []) =>
  `<div class="toolbar"><div class="search-in">${icon('search')}Search work orders</div>${['Status', 'Technician', 'Customer', 'Due date']
    .map(
      (c, i) =>
        `<span class="chip ${chips.includes(c) ? 'on' : ''} ${i > 1 ? 'hide-sm' : ''}">${icon('funnel')}${c}${chips.includes(c) ? ': 2' : ''}</span>`,
    )
    .join(
      '',
    )}<span class="grow"></span><span class="segmented hide-sm"><span class="on">${icon('layout-grid')}</span><span>${icon('columns-3')}</span></span></div>`

function dashboard(ctx) {
  const today = WORK_ORDERS.slice(0, 6)
  return app({
    title: 'Home',
    nav: 'Home',
    body: `${pageHead({ title: 'Good morning, Robin', sub: 'Monday, November 23. 14 jobs today, 2 need a technician.', acts: btn('New work order', { kind: 'primary', ic: 'plus', href: '/app/work-orders/new/' }) })}
    <div class="grid g4" data-testid="stats">${stat('Jobs today', '14', '+3 vs last Monday')}${stat('Unassigned', '2', 'Assign before 9:00', 'down')}${stat('First-time fix', '89%', '+4 pts this quarter')}${stat('Billed this week', money(48210), '+12%')}</div>
    <div class="grid g-main">${card({
      title: ctx.round >= 2 ? "Today's jobs, by start time" : "Today's jobs",
      actions: `<a class="small" href="/app/schedule/day/">Open day view</a>`,
      pad: false,
      body: `<ul class="list" data-testid="today-jobs">${today
        .map(
          (job, i) =>
            `<li><span class="mono muted" style="width:44px">${['8:00', '8:30', '9:30', '10:00', '13:00', '14:30'][i]}</span><div class="grow"><strong>${esc(job.title)}</strong><div class="muted small">${esc(job.customer)}</div></div><span class="hide-sm">${job.tech ? avatar(job.tech, 'sm') : badge('Unassigned', 'amber')}</span>${status(job.state)}</li>`,
        )
        .join('')}</ul>`,
    })}
    <div class="stack">${card({
      title: 'Crew on shift',
      actions: badge('9 of 12', 'green plain'),
      pad: false,
      body: `<ul class="list">${TECHS.slice(0, 5)
        .map((t) => `<li>${avatar(t.name, 'sm')}<span class="grow">${esc(t.name)}</span>${status(t.state)}</li>`)
        .join('')}</ul>`,
    })}
    ${card({ title: 'Needs attention', pad: false, body: `<ul class="list"><li>${icon('triangle-alert')}<span class="grow">3 jobs past their SLA</span><a class="small" href="/app/work-orders/urgent/">View</a></li><li>${icon('package')}<span class="grow">4 parts below reorder point</span><a class="small" href="/app/inventory/low-stock/">View</a></li><li>${icon('receipt')}<span class="grow">2 invoices overdue</span><a class="small" href="/app/invoices/overdue/">View</a></li></ul>` })}</div></div>
    ${card({ title: 'Jobs completed, last 12 weeks', body: barChart([38, 42, 40, 47, 51, 49, 55, 58, 54, 61, 63, 66], { labels: ['', 'Sep', '', '', 'Oct', '', '', '', 'Nov', '', '', 'Now'], height: 170 }) })}`,
  })
}

function dashboardEmpty() {
  return app({
    title: 'Home (new workspace)',
    nav: 'Home',
    notify: false,
    body: `${pageHead({ title: 'Welcome, Robin', sub: 'Your workspace is ready. Here is what most teams do first.' })}
    <div class="grid g3">${[
      ['clipboard-list', 'Create a work order', 'Start from a template for your trade.', '/app/work-orders/new/'],
      ['users', 'Invite technicians', 'They get a text with the app link.', '/app/team/invite/'],
      ['building', 'Add customers', 'Import a spreadsheet in a minute.', '/app/customers/new/'],
    ]
      .map(
        ([ic, t, p, href]) =>
          `<a class="card card-b stack tight" href="${href}" style="color:inherit"><span class="big-ic" style="width:40px;height:40px;border-radius:10px">${icon(ic)}</span><strong>${t}</strong><span class="muted">${p}</span></a>`,
      )
      .join('')}</div>
    ${card({ body: emptyState({ title: 'No jobs yet', text: "When you create work orders they show up here, with today's schedule and who is on shift.", acts: btn('Create a work order', { kind: 'primary', ic: 'plus', href: '/app/work-orders/new/' }), art: 'clipboard-list' }) })}`,
  })
}

function notifications() {
  const items = [
    ['Dana Whitlock completed WO-4823', 'Rooftop unit not cooling, Crestline Dental Group', '4 min ago', 'circle-check', true],
    ['Invoice INV-20616 is overdue', 'Harborview Apartments, $3,412.00', '1 hour ago', 'triangle-alert', true],
    ['Mei Lin assigned you WO-4841', 'Panel upgrade, east wing', '2 hours ago', 'clipboard-list', true],
    ['Low stock: run capacitor 45/5', '7 left, reorder point is 24', 'Yesterday', 'package', false],
    ['Amara Bell approved estimate EST-311', 'Crestline Dental Group, $6,980.00', 'Yesterday', 'badge-check', false],
    ['Lena Varga requested time off', 'Dec 22 to Dec 26', '2 days ago', 'calendar-days', false],
  ]
  return app({
    title: 'Notifications',
    nav: 'Home',
    body: `${pageHead({ title: 'Notifications', acts: btn('Mark all read', { ic: 'check' }) })}${tabs(
      [
        ['All', '#', 6],
        ['Mentions', '#', 1],
        ['Assigned to me', '#', 2],
      ],
      'All',
    )}
    ${card({ pad: false, body: `<ul class="list">${items.map(([t, s, when, ic, unread]) => `<li style="${unread ? 'background:#fffaf6' : ''}"><span class="big-ic" style="width:34px;height:34px;border-radius:9px">${icon(ic)}</span><div class="grow"><strong>${esc(t)}</strong><div class="muted small">${esc(s)}</div></div><span class="muted small">${when}</span>${unread ? '<span class="badge brand plain">New</span>' : ''}</li>`).join('')}</ul>` })}`,
  })
}

function activity() {
  const rows = [
    ['Dana Whitlock', 'completed', 'WO-4823 Rooftop unit not cooling', '9:42'],
    ['Mei Lin', 'reassigned', 'WO-4841 to Marcus Okafor', '9:30'],
    ['Sam Ortiz', 'sent', 'INV-20631 to Larkspur Hotel', '9:12'],
    ['Lena Varga', 'added 4 photos to', 'WO-4829 Leak under sink, unit 4B', '8:58'],
    ['Robin Ash', 'approved', 'PO-1182 Coastline HVAC Supply', '8:40'],
    ['Jo Park', 'invited', 'alex@northgate.example as Viewer', '8:31'],
    ['Owen Gallagher', 'clocked in at', 'Harborview Apartments', '8:02'],
  ]
  return app({
    title: 'Activity',
    nav: 'Home',
    body: `${pageHead({ title: 'Activity', sub: 'Everything that happened in Northgate Mechanical today.' })}${card({
      body: `<ul class="timeline">${rows.map(([who, verb, what, when]) => `<li><span class="dot">${avatar(who, 'sm')}</span><div><div><strong>${esc(who)}</strong> ${verb} <a href="/app/work-orders/wo-4823/">${esc(what)}</a></div><div class="muted small">Today at ${when}</div></div></li>`).join('')}</ul>`,
    })}`,
  })
}

function search(empty = false) {
  return app({
    title: empty ? 'Search: no results' : 'Search results',
    nav: 'Home',
    body: `<div class="input focus" style="height:44px;font-size:15px">${icon('search')}&nbsp;${empty ? 'walk-in cooler freon' : 'crestline'}</div>${
      empty
        ? card({
            body: emptyState({
              title: 'Nothing matches "walk-in cooler freon"',
              text: 'Try fewer words, or search by job number, customer or part SKU.',
              acts: btn('Clear search'),
              art: 'search',
            }),
          })
        : `<div class="row small muted">12 results for "crestline"</div>${card({ title: 'Customers', pad: false, body: `<ul class="list"><li>${avatar('Crestline Dental Group', 'sm')}<span class="grow"><strong>Crestline Dental Group</strong> <span class="muted">4 sites</span></span>${badge('Healthcare', 'plain')}</li></ul>` })}
      ${card({
        title: 'Work orders',
        pad: false,
        body: `<ul class="list">${WORK_ORDERS.filter((j) => j.customer.startsWith('Crestline'))
          .slice(0, 5)
          .map((j) => `<li><span class="mono muted">${j.id}</span><span class="grow">${esc(j.title)}</span>${status(j.state)}</li>`)
          .join('')}</ul>`,
      })}
      ${card({ title: 'Invoices', pad: false, body: `<ul class="list"><li><span class="mono muted">INV-20621</span><span class="grow">Crestline Dental Group</span><span class="num">${money(1284.5, true)}</span>${status('Paid')}</li></ul>` })}`
    }`,
  })
}

// ---- Work orders ----
function woList(ctx) {
  const rows = WORK_ORDERS.slice(0, 12).map(woRow)
  const bulk = `<div class="bulkbar" data-testid="bulk-bar"><span class="cb on"></span><strong>3 selected</strong><span class="grow"></span>${
    ctx.round >= 2 ? btn('Assign', { ic: 'user-plus', attrs: ' data-testid="bulk-assign"' }) : ''
  }${btn('Reschedule', { ic: 'calendar-days' })}${btn('Priority', { ic: 'tag' })}${btn('Close', { ic: 'circle-check' })}</div>`
  return app({
    title: 'Work orders',
    nav: 'Work orders',
    body: `${woHead()}${woTabs('All')}${toolbar()}${bulk}${table(WO_COLS, rows, { select: true, selected: [1, 2, 4], pager: '1-12 of 48' })}`,
  })
}

function woUrgent() {
  const rows = WORK_ORDERS.filter((j) => j.prio >= 2)
    .slice(0, 6)
    .map(woRow)
  return app({
    title: 'Work orders: urgent',
    nav: 'Work orders',
    body: `${woHead('Saved view: high and urgent, not completed')}${woTabs('Urgent')}${toolbar(['Status'])}<div class="alert warn">${icon('triangle-alert')}<div><strong>3 jobs are past their SLA.</strong> Crestline and Meridian have 4-hour response terms.</div></div>${table(WO_COLS, rows, { pager: '6 jobs' })}`,
  })
}

function woNoResults() {
  return app({
    title: 'Work orders: no results',
    nav: 'Work orders',
    body: `${woHead()}${woTabs('All')}${toolbar(['Status', 'Technician'])}${card({ body: emptyState({ title: 'No work orders match these filters', text: 'Status is On hold and technician is Kofi Mensah. Kofi is off this week.', acts: btn('Clear filters'), art: 'funnel' }) })}`,
  })
}

function woLoading() {
  return app({
    title: 'Work orders: loading',
    nav: 'Work orders',
    body: `${woHead('Loading...')}${woTabs('All')}${toolbar()}${skeletonRows(8)}`,
  })
}

function woError() {
  return app({
    title: 'Work orders: failed to load',
    nav: 'Work orders',
    body: `${woHead('')}${woTabs('All')}<div class="alert err" data-testid="load-error">${icon('circle-x')}<div class="grow"><strong>Work orders did not load.</strong> The server took too long to answer. Your filters are kept.</div>${btn('Try again', { ic: 'refresh-cw', size: 'sm' })}</div>${skeletonRows(4)}`,
  })
}

function woBoard() {
  const lanes = ['New', 'Scheduled', 'In progress', 'On hold', 'Completed']
  return app({
    title: 'Work orders: board',
    nav: 'Work orders',
    body: `${woHead()}${woTabs('Board')}<div class="kanban" data-testid="kanban">${lanes
      .map((lane) => {
        const jobs = WORK_ORDERS.filter((j) => j.state === lane).slice(0, 4)
        return `<div class="lane"><h3>${status(lane)}<span class="n">${jobs.length + 3}</span></h3>${jobs
          .map(
            (j) =>
              `<div class="kcard"><div class="row between"><span class="mono muted">${j.id}</span>${prio(j.prio)}</div><div class="ttl">${esc(j.title)}</div><div class="muted">${esc(j.customer)}</div><div class="row between"><span class="muted small">${icon('clock')} ${j.due}</span>${j.tech ? avatar(j.tech, 'sm') : badge('Unassigned', 'amber')}</div></div>`,
          )
          .join('')}<a class="btn ghost sm" href="/app/work-orders/new/">${icon('plus')}Add</a></div>`
      })
      .join('')}</div>`,
  })
}

const woDetailHead = (active) =>
  `${pageHead({
    title: 'Rooftop unit not cooling',
    sub: `<span class="mono">WO-4823</span> · Crestline Dental Group, North office · ${status('In progress')}`,
    crumbs: [
      ['Work orders', '/app/work-orders/'],
      ['WO-4823', null],
    ],
    acts: `${btn('Edit', { ic: 'pen-line', href: '/app/work-orders/wo-4823/edit/' })}${btn('Assign', { ic: 'user-plus', href: '/app/work-orders/wo-4823/assign/' })}${btn('Complete', { kind: 'primary', ic: 'circle-check', href: '/app/work-orders/wo-4823/complete/', attrs: ' data-testid="complete-job"' })}`,
  })}${tabs(
    [
      ['Overview', '/app/work-orders/wo-4823/'],
      ['Checklist', '/app/work-orders/wo-4823/checklist/', '4/7'],
      ['Photos', '/app/work-orders/wo-4823/photos/', 6],
      ['Activity', '/app/work-orders/wo-4823/activity/'],
    ],
    active,
  )}`

const woSide = () =>
  `<div class="stack">${card({
    title: 'Technician',
    body: `<div class="row">${avatar('Dana Whitlock')}<div class="grow"><strong>Dana Whitlock</strong><div class="muted small">HVAC · North crew</div></div>${status('On a job')}</div><div class="row mt">${btn('Call', { ic: 'phone', size: 'sm' })}${btn('Message', { ic: 'message-square', size: 'sm' })}</div>`,
  })}${card({ title: 'Site', pad: false, body: `${map({ height: 150, pins: [{ x: 50, y: 55, label: '' }] })}<div class="card-b small"><strong>1180 Beacon Way, ${esc('Port Alder')}</strong><div class="muted">Gate code at reception. Roof access via east stairwell.</div></div>` })}
  ${card({ title: 'Equipment', body: `<dl class="kv"><dt>Unit</dt><dd>RTU-2, 7.5 ton</dd><dt>Installed</dt><dd>2017</dd><dt>Warranty</dt><dd>${badge('Expired', 'plain')}</dd><dt>Last visit</dt><dd>Aug 14, filter change</dd></dl>` })}</div>`

function woDetail() {
  return app({
    title: 'Work order',
    nav: 'Work orders',
    body: `${woDetailHead('Overview')}<div class="grid g-main"><div class="stack">${card({
      title: 'Details',
      body: `<dl class="kv"><dt>Customer</dt><dd><a href="/app/customers/crestline/">Crestline Dental Group</a></dd><dt>Contact</dt><dd>Amara Bell, (555) 013-8820</dd><dt>Priority</dt><dd class="row">${prio(3)} Urgent, 4-hour SLA</dd><dt>Window</dt><dd>Today, 9:30 to 12:00</dd><dt>Type</dt><dd>Repair, HVAC</dd></dl>`,
    })}${card({ title: 'Problem', body: `<p>Waiting room is at 81°F. Unit runs but blows warm air. Breaker was reset by staff at 8:10 with no change.</p><div class="grid g3 mt">${photo(0)}${photo(1)}${photo(2)}</div>` })}
    ${card({ title: 'Parts and labor', pad: false, body: `<table class="t"><thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Price</th></tr></thead><tbody><tr><td>Run capacitor 45/5 MFD</td><td class="right">1</td><td class="right num">${money(64, true)}</td></tr><tr><td>Contactor 30A 2-pole</td><td class="right">1</td><td class="right num">${money(79, true)}</td></tr><tr><td>Labor, 1.5 h</td><td class="right">1.5</td><td class="right num">${money(217.5, true)}</td></tr><tr><td><strong>Total</strong></td><td></td><td class="right num"><strong>${money(360.5, true)}</strong></td></tr></tbody></table>` })}</div>${woSide()}</div>`,
  })
}

function woActivity() {
  const rows = [
    ['circle-check', 'Dana Whitlock checked "Capacitor tested"', '10:41'],
    ['camera', 'Dana Whitlock added 3 photos', '10:22'],
    ['map-pin', 'Dana Whitlock arrived on site', '9:48'],
    ['truck', 'Dana Whitlock is on the way, arrival text sent to Amara Bell', '9:21'],
    ['user-plus', 'Mei Lin assigned Dana Whitlock', '8:32'],
    ['inbox', 'Request created from the customer portal by Amara Bell', '8:14'],
  ]
  return app({
    title: 'Work order: activity',
    nav: 'Work orders',
    body: `${woDetailHead('Activity')}<div class="grid g-main">${card({ body: `<ul class="timeline">${rows.map(([ic, t, at]) => `<li><span class="dot">${icon(ic)}</span><div><div>${esc(t)}</div><div class="muted small">Today at ${at}</div></div></li>`).join('')}</ul><div class="row mt">${avatar(ME.name, 'sm')}<div class="input grow"><span class="faint">Add a note for the team...</span></div></div>` })}${woSide()}</div>`,
  })
}

function woChecklist() {
  const items = [
    ['Check thermostat setpoint and mode', true],
    ['Inspect filters, replace if dirty', true],
    ['Test capacitor', true],
    ['Check contactor for pitting', true],
    ['Measure supply and return temperatures', false],
    ['Check refrigerant pressures', false],
    ['Photo of the nameplate', false],
  ]
  return app({
    title: 'Work order: checklist',
    nav: 'Work orders',
    body: `${woDetailHead('Checklist')}<div class="grid g-main">${card({
      title: 'HVAC repair checklist',
      actions: badge('4 of 7', 'amber plain'),
      body: `<div class="progress"><i style="width:57%"></i></div>${items.map(([t, done]) => `<div class="check-row ${done ? 'done' : ''}"><span class="box">${done ? icon('check') : ''}</span><span class="txt grow">${t}</span>${done ? '<span class="muted small">Dana</span>' : ''}</div>`).join('')}`,
    })}${woSide()}</div>`,
  })
}

function woPhotos() {
  return app({
    title: 'Work order: photos',
    nav: 'Work orders',
    body: `${woDetailHead('Photos')}<div class="grid g4">${[0, 1, 2, 3, 1, 0].map((n, i) => `<div class="stack tight">${photo(n + i)}<span class="small muted">${['Before', 'Before', 'Nameplate', 'Capacitor', 'After', 'After'][i]}, Dana, 10:${20 + i}</span></div>`).join('')}</div>${btn('Upload photos', { ic: 'upload' })}`,
  })
}

const woForm = (title, values) =>
  `${pageHead({
    title,
    crumbs: [
      ['Work orders', '/app/work-orders/'],
      [title, null],
    ],
  })}<div class="grid g-main"><form class="card card-b stack" action="/app/work-orders/wo-4823/" method="post">
  ${field('Job title', values.title, { placeholder: 'What needs doing?' })}<div class="grid g2">${field('Customer', values.customer, { kind: 'select', placeholder: 'Pick a customer' })}${field('Site', values.site, { kind: 'select', placeholder: 'Pick a site' })}</div>
  <div class="grid g2">${field('Template', values.template, { kind: 'select', placeholder: 'No template' })}${field('Priority', values.prio, { kind: 'select' })}</div>
  ${field('Description', values.desc, { kind: 'textarea', placeholder: 'What the customer reported, access notes...' })}
  <div class="grid g2">${field('Scheduled', values.when, { kind: 'select', placeholder: 'Not scheduled' })}${field('Technician', values.tech, { kind: 'select', placeholder: 'Unassigned' })}</div>
  <div class="row" style="justify-content:flex-end">${btn('Cancel', { kind: 'ghost', href: '/app/work-orders/' })}<button class="btn primary" type="submit">${values.title ? 'Save changes' : 'Create work order'}</button></div></form>
  ${card({ title: 'Tips', body: '<p class="muted">Templates add a checklist and typical parts. Jobs without a technician show up in Dispatch, under Unassigned.</p>' })}</div>`

const woNew = () =>
  app({
    title: 'New work order',
    nav: 'Work orders',
    body: woForm('New work order', { customer: 'Crestline Dental Group', prio: 'Normal' }),
  })
const woEdit = () =>
  app({
    title: 'Edit work order',
    nav: 'Work orders',
    body: woForm('Edit WO-4823', {
      title: 'Rooftop unit not cooling',
      customer: 'Crestline Dental Group',
      site: 'North office',
      template: 'HVAC repair',
      prio: 'Urgent',
      desc: 'Waiting room is at 81°F. Unit runs but blows warm air.',
      when: 'Today, 9:30 to 12:00',
      tech: 'Dana Whitlock',
    }),
  })

function woAssign() {
  const overlay = `<div class="scrim"><div class="modal" role="dialog" aria-label="Assign technician"><div class="card-h"><h2>Assign WO-4823</h2>${btn('', { kind: 'ghost', ic: 'x' })}</div><div class="card-b stack"><div class="search-in input">${icon('search')}&nbsp;<span class="faint">Search technicians</span></div>
  <ul class="list" style="margin:0 -16px" data-testid="assign-list">${TECHS.filter((t) => ['HVAC', 'Controls'].includes(t.trade))
    .map(
      (t, i) =>
        `<li style="${i === 0 ? 'background:#fffaf6' : ''}">${avatar(t.name, 'sm')}<div class="grow"><strong>${esc(t.name)}</strong><div class="muted small">${t.trade} · ${['2.1 mi away, free at 9:30', '4.8 mi away, free at 11:00', '6.0 mi away, free now', '3.3 mi away, free at 13:00'][i % 4]}</div></div>${i === 0 ? badge('Best match', 'green') : ''}<span class="cb ${i === 0 ? 'on' : ''}"></span></li>`,
    )
    .join(
      '',
    )}</ul><label class="row small"><span class="cb on"></span>Text the customer the arrival window</label></div><div class="card-f">${btn('Cancel', { kind: 'ghost' })}${btn('Assign Dana', { kind: 'primary' })}</div></div></div>`
  return app({ title: 'Assign technician', nav: 'Work orders', body: `${woDetailHead('Overview')}${skeletonRows(3)}`, overlay })
}

function woComplete() {
  const overlay = `<div class="scrim"><div class="modal wide" role="dialog" aria-label="Complete job"><div class="card-h"><h2>Complete WO-4823</h2>${btn('', { kind: 'ghost', ic: 'x' })}</div><div class="card-b stack">
  <div class="alert ok">${icon('circle-check')}<div>Checklist done: 7 of 7. 6 photos. Customer signed at 11:52.</div></div>${field('Resolution', 'Replaced run capacitor and contactor. Supply air 56°F after 20 minutes.', { kind: 'textarea' })}
  <div class="grid g2">${field('Time on site', '2 h 04 min')}${field('Follow-up', 'Quote coil cleaning', { kind: 'select' })}</div>
  <div class="radio-card on"><span class="big-ic green" style="width:36px;height:36px;border-radius:10px">${icon('receipt')}</span><div class="grow"><strong>Create the invoice now</strong><div class="muted small">${money(360.5, true)} from parts and labor, sent to Amara Bell</div></div><span class="cb on"></span></div></div>
  <div class="card-f">${btn('Cancel', { kind: 'ghost' })}${btn('Complete and invoice', { kind: 'primary', href: '/app/invoices/new/' })}</div></div></div>`
  return app({ title: 'Complete job', nav: 'Work orders', body: `${woDetailHead('Overview')}${skeletonRows(3)}`, overlay })
}

// ---- Schedule & dispatch ----
const schedHead = (active, extra = '') =>
  `${pageHead({ title: 'Schedule', sub: 'Week of November 23 · 12 technicians', acts: `${btn('Time off', { ic: 'calendar-clock', href: '/app/schedule/time-off/' })}${btn('Add shift', { kind: 'primary', ic: 'plus', href: '/app/schedule/shift/' })}` })}
  <div class="toolbar">${btn('', { ic: 'arrow-left', size: 'sm' })}${btn('Today', { size: 'sm' })}${btn('', { ic: 'arrow-right', size: 'sm' })}<span class="segmented">${[
    ['Day', '/app/schedule/day/'],
    ['Week', '/app/schedule/'],
    ['Month', '/app/schedule/month/'],
  ]
    .map(([l]) => `<span class="${l === active ? 'on' : ''}">${l}</span>`)
    .join('')}</span><span class="grow"></span>${extra}<span class="chip hide-sm">${icon('funnel')}All crews</span></div>`

const TONES = ['blue', 'brand', 'green', 'violet', 'amber']
function scheduleWeek(ctx, { conflicts = false } = {}) {
  const days = ['Mon 23', 'Tue 24', 'Wed 25', 'Thu 26', 'Fri 27']
  const highlight = conflicts || ctx.round >= 3
  return app({
    title: conflicts ? 'Schedule: conflicts' : 'Schedule: week',
    nav: 'Schedule',
    body: `${schedHead('Week', conflicts ? badge('3 conflicts', 'red') : '')}${conflicts ? `<div class="alert err">${icon('triangle-alert')}<div><strong>3 conflicts this week.</strong> Two jobs overlap for Lena Varga on Wednesday; Kofi Mensah is on leave but has a job on Thursday.</div></div>` : ''}
    <div class="card" style="overflow-x:auto"><div class="cal" style="grid-template-columns:150px repeat(5,minmax(120px,1fr));min-width:760px" data-testid="week-grid"><div class="hd"></div>${days.map((d) => `<div class="hd">${d}</div>`).join('')}${TECHS.slice(
      0,
      8,
    )
      .map(
        (t, r) =>
          `<div class="row small" style="font-weight:600">${avatar(t.name, 'sm')}<span>${esc(t.name)}<br /><span class="muted" style="font-weight:400">${t.trade}</span></span></div>${days
            .map((_, c) => {
              const clash = highlight && ((r === 2 && c === 2) || (r === 5 && c === 3))
              const off = r === 5 && c >= 2
              return `<div class="${off ? 'off' : ''}">${off ? '<span class="small">On leave</span>' : ''}${(r + c) % 3 !== 2 || clash ? `<span class="ev ${clash ? 'red' : TONES[(r + c) % 5]}">${esc(WORK_ORDERS[(r * 5 + c) % 40].title)}</span>` : ''}${(r * c) % 4 === 1 || clash ? `<span class="ev ${clash ? 'red' : TONES[(r + c + 2) % 5]}">${esc(WORK_ORDERS[(r * 7 + c + 3) % 40].title)}</span>` : ''}</div>`
            })
            .join('')}`,
      )
      .join('')}</div></div>`,
  })
}

function scheduleDay() {
  const hours = ['7:00', '8:00', '9:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00']
  return app({
    title: 'Schedule: day',
    nav: 'Schedule',
    body: `${schedHead('Day')}<div class="card" style="overflow-x:auto"><div class="gantt" style="min-width:720px"><div class="lbl muted small" style="font-weight:600">Monday, Nov 23</div><div class="trk" style="display:flex">${hours
      .map((h) => `<span class="muted small" style="flex:1;padding:9px 4px">${h}</span>`)
      .join('')}</div>${TECHS.slice(0, 9)
      .map((t, i) => {
        const start = (i * 13) % 40
        const len = 18 + ((i * 7) % 20)
        return `<div class="lbl row">${avatar(t.name, 'sm')}${esc(t.name)}</div><div class="trk"><span class="bar" style="left:${start}%;width:${len}%;background:${['#2563eb', '#ea6a1f', '#15803d', '#6d28d9'][i % 4]}">${esc(WORK_ORDERS[i].title)}</span><span class="bar" style="left:${start + len + 6}%;width:${Math.max(10, 30 - len / 2)}%;background:${['#0f766e', '#b45309', '#be185d'][i % 3]}">${esc(WORK_ORDERS[i + 12].title)}</span></div>`
      })
      .join('')}</div></div>`,
  })
}

function scheduleMonth() {
  const cells = []
  for (let d = -1; d < 34; d++) {
    const day = d + 1
    const out = day < 1 || day > 30
    const n = out ? 0 : (day * 7) % 5
    cells.push(
      `<div class="${out ? 'off' : ''}"><strong>${out ? (day < 1 ? 31 : day - 30) : day}</strong>${Array.from({ length: Math.min(n, 3) }, (_, k) => `<span class="ev ${TONES[(day + k) % 5]}">${esc(WORK_ORDERS[(day * 3 + k) % 40].title)}</span>`).join('')}${n > 3 ? `<span class="muted small">+${n - 3} more</span>` : ''}</div>`,
    )
  }
  return app({
    title: 'Schedule: month',
    nav: 'Schedule',
    body: `${schedHead('Month')}<div class="card cal-month"><div class="cal" style="grid-template-columns:repeat(7,minmax(0,1fr))">${WEEK.map((d) => `<div class="hd">${d}</div>`).join('')}${cells.join('')}</div></div>`,
  })
}

function shiftEdit() {
  const overlay = `<div class="drawer-scrim"></div><aside class="drawer" aria-label="Edit shift"><div class="card-h"><h2>Shift: Lena Varga</h2>${btn('', { kind: 'ghost', ic: 'x' })}</div><div class="card-b stack" style="flex:1">${field('Date', 'Wednesday, Nov 25', { kind: 'select' })}<div class="grid g2">${field('Start', '7:00')}${field('End', '15:30')}</div>${field('Crew', 'River crew', { kind: 'select' })}${field('Van', 'Van 7 (Plumbing)', { kind: 'select' })}${toggleShift()}<div class="alert warn">${icon('triangle-alert')}<div>Two jobs overlap from 10:00 to 11:00. Move one, or extend the shift.</div></div></div><div class="card-f">${btn('Delete shift', { kind: 'danger ghost' })}<span class="grow"></span>${btn('Save', { kind: 'primary' })}</div></aside>`
  return app({ title: 'Edit shift', nav: 'Schedule', body: schedHead('Week') + skeletonRows(5), overlay })
}
const toggleShift = () =>
  `<div class="row between"><div><strong>On call after hours</strong><div class="muted small">Gets emergency jobs until 22:00</div></div><span class="toggle on"></span></div>`

function timeOff() {
  const rows = [
    ['Lena Varga', 'Dec 22 to Dec 26', 'Vacation', 'Pending'],
    ['Kofi Mensah', 'Nov 25 to Nov 29', 'Leave', 'Approved'],
    ['Theo Brandt', 'Dec 4', 'Appointment', 'Approved'],
    ['Felix Moreau', 'Dec 18 to Dec 19', 'Vacation', 'Declined'],
  ].map(([n, when, why, st]) => [
    `<span class="row">${avatar(n, 'sm')}<strong>${n}</strong></span>`,
    when,
    `<span class="muted">${why}</span>`,
    status(st),
    st === 'Pending' ? `<span class="row">${btn('Decline', { size: 'sm' })}${btn('Approve', { size: 'sm', kind: 'primary' })}</span>` : '',
  ])
  return app({
    title: 'Time off',
    nav: 'Schedule',
    body: `${pageHead({
      title: 'Time off',
      sub: '1 request waiting',
      crumbs: [
        ['Schedule', '/app/schedule/'],
        ['Time off', null],
      ],
      acts: btn('Add time off', { kind: 'primary', ic: 'plus' }),
    })}${table([{ label: 'Technician' }, { label: 'Dates' }, { label: 'Type', cls: 'hide-sm' }, { label: 'Status' }, { label: '' }], rows)}`,
  })
}

const dispatchPins = [
  { x: 18, y: 28, label: '1' },
  { x: 42, y: 52, label: '2', kind: 'late', tag: 'WO-4823 late' },
  { x: 66, y: 24, label: '3', kind: 'done' },
  { x: 74, y: 66, label: '4' },
  { x: 30, y: 74, label: '5' },
  { x: 55, y: 40, label: 'DW', kind: 'tech', tag: 'Dana' },
  { x: 24, y: 48, label: 'MO', kind: 'tech', tag: 'Marcus' },
  { x: 84, y: 38, label: 'LV', kind: 'tech', tag: 'Lena' },
]
function dispatch(ctx) {
  return app({
    title: 'Dispatch',
    nav: 'Dispatch',
    body: `${pageHead({ title: 'Dispatch', sub: 'Live · 9 technicians on shift · 14 jobs today', acts: `${btn('Unassigned (7)', { ic: 'inbox', href: '/app/dispatch/unassigned/' })}${ctx.prod ? '' : btn('Plan routes', { kind: 'primary', ic: 'route', href: '/app/dispatch/routes/' })}` })}
    <div class="grid g-main"><div class="stack">${map({ height: 520, pins: dispatchPins })}${ctx.round >= 2 ? `<div class="legend" data-testid="map-legend"><span><i style="background:var(--brand)"></i>Scheduled</span><span><i style="background:var(--red-strong)"></i>Late</span><span><i style="background:var(--green)"></i>Done</span><span><i style="background:var(--blue)"></i>Technician</span></div>` : ''}</div>
    ${card({
      title: 'Technicians',
      pad: false,
      body: `<ul class="list" data-testid="dispatch-techs">${TECHS.slice(0, 8)
        .map(
          (t) =>
            `<li>${avatar(t.name, 'sm')}<div class="grow"><strong>${esc(t.name)}</strong><div class="muted small">${t.jobs} jobs · ${t.state === 'En route' ? 'ETA 12 min' : t.state}</div></div>${status(t.state)}</li>`,
        )
        .join('')}</ul>`,
    })}</div>`,
  })
}

function dispatchUnassigned() {
  const jobs = WORK_ORDERS.filter((j) => !j.tech).concat(WORK_ORDERS.slice(20, 23))
  return app({
    title: 'Dispatch: unassigned',
    nav: 'Dispatch',
    body: `${pageHead({
      title: 'Unassigned jobs',
      sub: '7 jobs need a technician',
      crumbs: [
        ['Dispatch', '/app/dispatch/'],
        ['Unassigned', null],
      ],
      acts: btn('Auto-assign all', { kind: 'primary', ic: 'sparkles' }),
    })}<div class="grid g2">${jobs
      .slice(0, 6)
      .map(
        (j, i) =>
          `<section class="card card-b stack tight"><div class="row between"><span class="mono muted">${j.id}</span>${prio(j.prio)}</div><strong>${esc(j.title)}</strong><span class="muted">${esc(j.customer)} · due ${j.due}</span><div class="row between mt-s"><span class="row small muted">${icon('sparkles')}Suggested: ${esc(TECHS[(i * 3) % TECHS.length].name)}</span>${btn('Assign', { size: 'sm' })}</div></section>`,
      )
      .join('')}</div>`,
  })
}

function routePlan() {
  return app({
    title: 'Route planning',
    nav: 'Dispatch',
    body: `${pageHead({
      title: 'Route plan: Dana Whitlock',
      sub: `5 stops · 38 mi · ${badge('New', 'brand')}`,
      crumbs: [
        ['Dispatch', '/app/dispatch/'],
        ['Routes', null],
      ],
      acts: `${btn('Optimize', { ic: 'sparkles' })}${btn('Send to phone', { kind: 'primary', ic: 'smartphone' })}`,
    })}
    <div class="grid g-main">${map({
      height: 500,
      pins: dispatchPins.slice(0, 5).map((p, i) => ({ ...p, label: String(i + 1), kind: '' })),
      route: [
        [55, 40],
        [18, 28],
        [42, 52],
        [30, 74],
        [74, 66],
        [66, 24],
      ],
    })}
    ${card({
      title: 'Stops',
      pad: false,
      body: `<ul class="timeline" style="padding:16px">${WORK_ORDERS.slice(0, 5)
        .map(
          (j, i) =>
            `<li><span class="dot" style="background:var(--brand-soft);color:var(--brand-2);font-weight:700">${i + 1}</span><div><strong>${esc(j.title)}</strong><div class="muted small">${esc(j.customer)} · ${['8:00', '9:20', '10:45', '13:00', '14:40'][i]} · ${[6, 9, 4, 11, 8][i]} min drive</div></div></li>`,
        )
        .join('')}</ul>`,
    })}</div>`,
  })
}

function techTimeline() {
  const t = TECHS[0]
  return app({
    title: 'Technician day',
    nav: 'Dispatch',
    body: `${pageHead({
      title: t.name,
      sub: `${t.trade} · ${t.crew} · ${status(t.state)}`,
      crumbs: [
        ['Dispatch', '/app/dispatch/'],
        [t.name, null],
      ],
      acts: btn('Message', { ic: 'message-square' }),
    })}
    <div class="grid g4">${stat('Jobs today', '5')}${stat('Done', '2')}${stat('Drive time', '1 h 12 m')}${stat('Utilization', '92%', 'Above target')}</div>
    ${card({
      title: 'Today',
      body: `<ul class="timeline">${[
        ['circle-check', 'Quarterly PM: boilers', 'Harborview Apartments', '7:30 to 9:05', 'Completed'],
        ['circle-check', 'Exhaust fan noisy', 'Pine & Copper Bistro', '9:25 to 10:10', 'Completed'],
        ['wrench', 'Rooftop unit not cooling', 'Crestline Dental Group', '10:30 to now', 'In progress'],
        ['clock', 'Chiller startup', 'Meridian Office Tower', '13:30', 'Scheduled'],
        ['clock', 'Thermostat offline, floor 3', 'Meridian Office Tower', '15:00', 'Scheduled'],
      ]
        .map(
          ([ic, job, cust, when, st]) =>
            `<li><span class="dot">${icon(ic)}</span><div class="row between wrap"><div><strong>${job}</strong><div class="muted small">${cust} · ${when}</div></div>${status(st)}</div></li>`,
        )
        .join('')}</ul>`,
    })}
    ${card({ title: 'Utilization, last 8 weeks', body: `<div class="row">${spark([78, 81, 85, 83, 88, 90, 89, 92])}<span class="muted small">Target 85%</span></div>` })}`,
  })
}

export const pages = [
  { id: 'dashboard', path: '/app/', title: 'Dashboard', group: H, render: dashboard },
  {
    id: 'dashboard-empty',
    path: '/app/welcome/',
    title: 'Dashboard: new workspace',
    group: H,
    note: 'Empty state',
    render: dashboardEmpty,
  },
  { id: 'notifications', path: '/app/notifications/', title: 'Notifications', group: H, render: notifications },
  { id: 'activity', path: '/app/activity/', title: 'Activity feed', group: H, render: activity },
  { id: 'search', path: '/app/search/', title: 'Search results', group: H, render: () => search(false) },
  {
    id: 'search-empty',
    path: '/app/search/empty/',
    title: 'Search: no results',
    group: H,
    note: 'Empty state',
    render: () => search(true),
  },
  { id: 'wo-list', path: '/app/work-orders/', title: 'Work orders', group: W, render: woList },
  { id: 'wo-urgent', path: '/app/work-orders/urgent/', title: 'Work orders: urgent', group: W, render: woUrgent },
  { id: 'wo-board', path: '/app/work-orders/board/', title: 'Work orders: board', group: W, render: woBoard },
  {
    id: 'wo-no-results',
    path: '/app/work-orders/no-results/',
    title: 'Work orders: no results',
    group: W,
    note: 'Empty state',
    render: woNoResults,
  },
  {
    id: 'wo-loading',
    path: '/app/work-orders/loading/',
    title: 'Work orders: loading',
    group: W,
    note: 'Loading state',
    render: woLoading,
  },
  { id: 'wo-error', path: '/app/work-orders/error/', title: 'Work orders: failed to load', group: W, note: 'Error state', render: woError },
  { id: 'wo-new', path: '/app/work-orders/new/', title: 'New work order', group: W, render: woNew },
  { id: 'wo-detail', path: '/app/work-orders/wo-4823/', title: 'Work order', group: W, render: woDetail },
  { id: 'wo-checklist', path: '/app/work-orders/wo-4823/checklist/', title: 'Work order: checklist', group: W, render: woChecklist },
  { id: 'wo-photos', path: '/app/work-orders/wo-4823/photos/', title: 'Work order: photos', group: W, render: woPhotos },
  { id: 'wo-activity', path: '/app/work-orders/wo-4823/activity/', title: 'Work order: activity', group: W, render: woActivity },
  { id: 'wo-edit', path: '/app/work-orders/wo-4823/edit/', title: 'Edit work order', group: W, render: woEdit },
  {
    id: 'wo-assign',
    path: '/app/work-orders/wo-4823/assign/',
    title: 'Assign technician',
    group: W,
    note: 'Dialog open',
    render: woAssign,
  },
  {
    id: 'wo-complete',
    path: '/app/work-orders/wo-4823/complete/',
    title: 'Complete job',
    group: W,
    note: 'Dialog open',
    render: woComplete,
  },
  { id: 'schedule', path: '/app/schedule/', title: 'Schedule: week', group: S, render: (ctx) => scheduleWeek(ctx) },
  { id: 'schedule-day', path: '/app/schedule/day/', title: 'Schedule: day', group: S, render: scheduleDay },
  { id: 'schedule-month', path: '/app/schedule/month/', title: 'Schedule: month', group: S, render: scheduleMonth },
  {
    id: 'schedule-conflicts',
    path: '/app/schedule/conflicts/',
    title: 'Schedule: conflicts',
    group: S,
    note: 'Error state',
    render: (ctx) => scheduleWeek(ctx, { conflicts: true }),
  },
  { id: 'shift-edit', path: '/app/schedule/shift/', title: 'Edit shift', group: S, note: 'Drawer open', render: shiftEdit },
  { id: 'time-off', path: '/app/schedule/time-off/', title: 'Time off', group: S, render: timeOff },
  { id: 'dispatch', path: '/app/dispatch/', title: 'Dispatch map', group: S, render: dispatch },
  { id: 'dispatch-unassigned', path: '/app/dispatch/unassigned/', title: 'Dispatch: unassigned', group: S, render: dispatchUnassigned },
  {
    id: 'route-plan',
    path: '/app/dispatch/routes/',
    title: 'Route planning',
    group: S,
    note: 'New on staging, not on production yet',
    stagingOnly: true,
    render: routePlan,
  },
  { id: 'tech-day', path: '/app/dispatch/dana-whitlock/', title: 'Technician day', group: S, render: techTimeline },
]
