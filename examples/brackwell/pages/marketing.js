// Brackwell's public site: home, product, features, solutions, customers,
// pricing, changelog, contact and security.
import { CUSTOMERS, TECHS, WORK_ORDERS } from '../data.js'
import { marketing } from '../shells.js'
import { avatar, badge, barChart, card, esc, field, icon, lineChart, map, status } from '../ui.js'

const LOGOS = ['NORTHGATE', 'Copperfield', 'HALVERSON & CO', 'bluewater', 'MERIDIAN', 'Saltline']
const G = 'Marketing'
const TALL = { desktop: 2300, phone: 3600 }

function heroShot() {
  const jobs = WORK_ORDERS.slice(0, 4)
  return `<div class="shot"><div class="row" style="padding:10px 12px;background:#fff;border-bottom:1px solid var(--line)"><span class="badge plain">Dispatch</span><span class="muted small">Today, 14 jobs</span></div>
  <div class="grid" style="grid-template-columns:1.4fr 1fr;gap:0">${map({
    height: 300,
    pins: [
      { x: 22, y: 30, label: '1' },
      { x: 48, y: 55, label: '2', kind: 'late' },
      { x: 70, y: 28, label: '3', kind: 'done' },
      { x: 35, y: 78, label: 'DW', kind: 'tech' },
      { x: 82, y: 70, label: 'MO', kind: 'tech' },
    ],
    route: [
      [35, 78],
      [22, 30],
      [48, 55],
    ],
  })}
  <ul class="list" style="background:#fff">${jobs
    .map(
      (job) =>
        `<li><div class="grow"><div style="font-weight:600;font-size:12px">${esc(job.title)}</div><div class="muted small">${esc(job.customer)}</div></div>${status(job.state)}</li>`,
    )
    .join('')}</ul></div></div>`
}

const features = (items) =>
  `<div class="grid g3">${items
    .map(
      ([ic, title, text]) =>
        `<section class="card feature"><div class="ic">${icon(ic)}</div><h3>${esc(title)}</h3><p>${esc(text)}</p></section>`,
    )
    .join('')}</div>`

const ctaBand = () =>
  `<section class="section"><div class="wrap"><div class="cta-band"><div class="grow"><h2>Run your next week on Brackwell</h2><p style="color:#9fb0c2;margin-top:6px">Free for 14 days. Bring your jobs, crews and customers in an afternoon.</p></div><a class="btn primary lg" href="/signup/">Start free trial</a></div></div></section>`

function home(ctx) {
  const headline = ctx.prod ? 'Field service software for growing teams' : 'Every job, crew and invoice in one place'
  return marketing({
    title: 'Field operations software',
    body: `<div class="wrap"><section class="hero"><div><span class="eyebrow" data-testid="hero-eyebrow">${icon('sparkles')}${ctx.prod ? 'New: offline mode' : 'New: route planning'}</span>
      <h1 data-testid="hero-title">${headline}</h1>
      <p class="lede">Brackwell schedules your technicians, routes them through the day, tracks parts on every van and sends the invoice before they are back at the shop.</p>
      <div class="ctas"><a class="btn primary lg" href="/signup/" data-testid="hero-cta">Start free trial</a><a class="btn lg" href="/product/">See the product</a></div>
      <p class="muted small" style="margin-top:14px">14 days free. No card needed.</p></div>${heroShot()}</section>
      <div class="logos" data-testid="logos">${LOGOS.map((logo) => `<span>${logo}</span>`).join('')}</div></div>
      <section class="section"><div class="wrap stack" style="gap:28px"><h2 class="big">From the first call to the paid invoice</h2>${features(
        [
          ['calendar-days', 'Schedule in minutes', 'Drag jobs onto a crew calendar that knows skills, hours and travel time.'],
          ['route', 'Dispatch with a live map', 'See every technician, reroute around delays, text the customer an arrival time.'],
          ['smartphone', 'A mobile app crews like', 'Checklists, photos, parts and signatures, even with no signal in the basement.'],
          ['package', 'Parts that do not run out', 'Stock per van and warehouse, with reorder points and purchase orders.'],
          ['receipt', 'Invoice on the spot', 'Turn a finished job into an invoice and take payment before leaving the site.'],
          ['chart-column', 'Reports that answer questions', 'First-time fix rate, utilization and margin by customer, every morning.'],
        ],
      )}</div></section>
      <section class="section alt"><div class="wrap grid g2" style="align-items:center;gap:48px"><div class="stack"><span class="eyebrow">${icon('star')}Customer story</span><p class="quote">"Our first-time fix rate went from 71% to 89% in two quarters, mostly because the right part is on the right van."</p><div class="row">${avatar('Gus Halvorsen')}<div><strong>Gus Halvorsen</strong><div class="muted small">Facilities director, Ridgeway Logistics Park</div></div></div></div>
      ${card({ title: 'First-time fix rate', body: lineChart([[71, 73, 76, 79, 82, 84, 86, 89]], { labels: ['Q1', '', 'Q2', '', 'Q3', '', 'Q4', ''], height: 200 }) })}</div></section>
      ${ctaBand()}`,
  })
}

function product() {
  return marketing({
    title: 'Product',
    active: 'Product',
    body: `<div class="wrap"><section class="hero" style="grid-template-columns:1fr"><div style="text-align:center;margin:0 auto"><span class="eyebrow">${icon('layers')}The platform</span><h1>One system from request to revenue</h1><p class="lede" style="margin:0 auto">Six connected modules. Use one, or run the whole business on all of them.</p></div></section>
    <div class="grid g3">${[
      ['clipboard-list', 'Work orders', 'Templates, checklists, priorities and SLAs for every kind of job.'],
      ['calendar-days', 'Scheduling', 'Crew calendars with skills, shifts, time off and conflicts flagged.'],
      ['map', 'Dispatch', 'Live map, route planning and arrival texts to customers.'],
      ['package', 'Inventory', 'Warehouses, van stock, purchase orders and reorder points.'],
      ['receipt', 'Billing', 'Estimates, invoices, payments and a price book.'],
      ['chart-column', 'Reporting', 'Utilization, fix rate, SLA compliance and margin.'],
    ]
      .map(
        ([ic, t, p]) =>
          `<section class="card feature"><div class="ic">${icon(ic)}</div><h3>${t}</h3><p>${p}</p><a class="small" href="/features/scheduling/" style="display:inline-flex;gap:4px;margin-top:10px;align-items:center">Learn more ${icon('arrow-right')}</a></section>`,
      )
      .join('')}</div></div>
    <section class="section"><div class="wrap grid g2" style="gap:40px;align-items:center"><div class="stack"><h2 class="big">Built for the office and the van</h2><p class="lede">Dispatchers plan on a big screen; technicians work from their phones. Both see the same job, the same notes and the same parts, in real time.</p></div>${heroShot()}</div></section>${ctaBand()}`,
  })
}

function featurePage(kind) {
  const spec = {
    scheduling: [
      'calendar-days',
      'Scheduling that respects reality',
      'Skills, shifts, travel time and time off, all on one crew calendar.',
      'Scheduling',
    ],
    dispatch: [
      'map',
      'Dispatch from a live map',
      'Every technician and every job on one map, with routes that update themselves.',
      'Dispatch',
    ],
    mobile: [
      'smartphone',
      'The app your crews will actually use',
      'Big buttons, offline mode, photos and signatures. Built with technicians.',
      'Mobile app',
    ],
  }[kind]
  const visual =
    kind === 'dispatch'
      ? map({
          height: 380,
          pins: TECHS.slice(0, 6).map((t, i) => ({
            x: 12 + i * 15,
            y: 25 + ((i * 37) % 55),
            label: t.name
              .split(' ')
              .map((p) => p[0])
              .join(''),
            kind: 'tech',
          })),
        })
      : kind === 'mobile'
        ? `<div class="row" style="justify-content:center;gap:24px">${[0, 1]
            .map(
              (n) =>
                `<div class="card" style="width:220px;height:420px;border-radius:28px;padding:14px;background:var(--nav)"><div style="background:#fff;border-radius:18px;height:100%;padding:12px" class="stack tight"><strong>${n ? 'Checklist' : 'Today'}</strong>${[
                  1, 2, 3, 4, 5,
                ]
                  .map(
                    (i) =>
                      `<div class="row small" style="padding:8px;border:1px solid var(--line);border-radius:8px">${icon(n ? 'circle-check' : 'clock')}<span class="sk" style="width:${50 + i * 7}%"></span></div>`,
                  )
                  .join('')}</div></div>`,
            )
            .join('')}</div>`
        : `<div class="card" style="padding:12px">${weekStrip()}</div>`
  return marketing({
    title: spec[3],
    active: 'Product',
    body: `<div class="wrap"><section class="hero"><div><span class="eyebrow">${icon(spec[0])}${spec[3]}</span><h1>${spec[1]}</h1><p class="lede">${spec[2]}</p><div class="ctas"><a class="btn primary lg" href="/signup/">Start free trial</a><a class="btn lg" href="/contact/">Talk to sales</a></div></div>${visual}</section></div>
    <section class="section alt"><div class="wrap">${features([
      ['zap', 'Fast to set up', 'Import crews and customers from a spreadsheet in minutes.'],
      ['shield-check', 'Permissions that fit', 'Dispatchers, technicians and billing each see what they need.'],
      ['plug', 'Works with your tools', 'Accounting, calendars and payments connect in a click.'],
    ])}</div></section>${ctaBand()}`,
  })
}

export function weekStrip() {
  const days = ['Mon 23', 'Tue 24', 'Wed 25', 'Thu 26', 'Fri 27']
  const tones = ['blue', 'brand', 'green', 'violet', 'amber']
  return `<div class="cal" style="grid-template-columns:110px repeat(5,1fr)"><div class="hd"></div>${days.map((d) => `<div class="hd">${d}</div>`).join('')}${TECHS.slice(
    0,
    5,
  )
    .map(
      (t, r) =>
        `<div class="row small" style="font-weight:600">${avatar(t.name, 'sm')}${esc(t.name.split(' ')[0])}</div>${days
          .map(
            (_, c) =>
              `<div>${(r + c) % 3 !== 2 ? `<span class="ev ${tones[(r + c) % 5]}">${esc(WORK_ORDERS[(r * 5 + c) % 40].title)}</span>` : ''}${(r * c) % 4 === 1 ? `<span class="ev ${tones[(r + c + 2) % 5]}">${esc(WORK_ORDERS[(r * 7 + c) % 40].title)}</span>` : ''}</div>`,
          )
          .join('')}`,
    )
    .join('')}</div>`
}

function solution(kind) {
  const hvac = kind === 'hvac'
  return marketing({
    title: hvac ? 'HVAC and mechanical' : 'Facilities teams',
    active: 'Solutions',
    body: `<div class="wrap"><section class="hero"><div><span class="eyebrow">${icon(hvac ? 'fan' : 'building')}${hvac ? 'For HVAC and mechanical' : 'For in-house facilities teams'}</span><h1>${hvac ? 'Keep every unit running and every tech busy' : 'Every building, every request, one queue'}</h1><p class="lede">${
      hvac
        ? 'Preventive maintenance plans, refrigerant logs and service agreements, built in.'
        : 'Requests from tenants and staff land in one queue, routed to the right trade with the right priority.'
    }</p><div class="ctas"><a class="btn primary lg" href="/signup/">Start free trial</a></div></div>
    ${card({ title: hvac ? 'Maintenance plans due this month' : 'Requests by building', body: barChart(hvac ? [14, 22, 18, 30, 26, 19] : [32, 18, 27, 12, 21, 9], { labels: hvac ? ['Wk 1', 'Wk 2', 'Wk 3', 'Wk 4', 'Wk 5', 'Wk 6'] : ['North', 'Annex', 'Tower', 'Lab', 'Depot', 'Clinic'] }) })}</section></div>
    <section class="section alt"><div class="wrap">${features(
      hvac
        ? [
            ['thermometer', 'Equipment history', 'Every unit, its model, warranty and every visit.'],
            ['calendar-clock', 'PM plans', 'Generate visits for every agreement automatically.'],
            ['droplets', 'Refrigerant logs', 'Track charges and leaks per unit for compliance.'],
          ]
        : [
            ['inbox', 'Request portal', 'Staff submit requests with photos in seconds.'],
            ['gauge', 'SLA tracking', 'See what is late before anyone has to ask.'],
            ['building', 'Asset registry', 'Every asset in every building, with its manuals.'],
          ],
    )}</div></section>${ctaBand()}`,
  })
}

function customers() {
  return marketing({
    title: 'Customers',
    active: 'Customers',
    body: `<div class="wrap"><section class="section" style="padding-bottom:24px;text-align:center"><h1 class="mk-h1">Teams that run on Brackwell</h1><p class="lede" style="margin:0 auto">From two-van shops to 300-technician service companies.</p></section>
    <div class="grid g3">${CUSTOMERS.slice(0, 9)
      .map(
        (c, i) =>
          `<section class="card feature"><div class="row" style="margin-bottom:12px">${avatar(c.name)}<strong>${esc(c.name)}</strong></div><p>"${esc(
            [
              'We cut drive time by a fifth.',
              'Invoices go out the same day now.',
              'Our techs stopped calling the office for job details.',
              'PM visits finally happen on time.',
              'We know which vans carry which parts.',
              'Billing disputes dropped to almost none.',
            ][i % 6],
          )}"</p><a class="small" href="/customers/ridgeway/" style="display:inline-flex;gap:4px;margin-top:10px;align-items:center">Read the story ${icon('arrow-right')}</a></section>`,
      )
      .join('')}</div></div>${ctaBand()}`,
  })
}

function story() {
  return marketing({
    title: 'Ridgeway Logistics Park',
    active: 'Customers',
    body: `<div class="wrap" style="max-width:820px"><section class="section stack"><a class="small row" href="/customers/">${icon('arrow-left')}All customers</a><span class="eyebrow">Customer story</span><h1 class="mk-h1">How Ridgeway keeps 40 loading docks open all winter</h1>
    <div class="grid g3">${[
      ['89%', 'first-time fix rate'],
      ['-22%', 'drive time'],
      ['3 days', 'faster to invoice'],
    ]
      .map(([v, l]) => `<section class="card stat"><div class="value">${v}</div><div class="label">${l}</div></section>`)
      .join('')}</div>
    <p class="lede">Ridgeway's facilities team covers five buildings and forty dock doors. Before Brackwell, requests arrived by phone, email and hallway conversation.</p><p class="lede">Now every request lands in one queue. Dispatch sees which technician is closest and has the part on the van, and the customer gets a text when the tech is on the way.</p>
    <p class="quote">"We stopped losing requests. That alone paid for it."</p>${photoRow()}</section></div>${ctaBand()}`,
  })
}
const photoRow = () =>
  `<div class="grid g3">${[0, 1, 2]
    .map(
      (n) =>
        `<div class="photo"><svg viewBox="0 0 160 120" aria-hidden="true"><rect width="160" height="120" fill="${['#cdd6df', '#d9d0c4', '#cfd9cf'][n]}"/><rect x="20" y="40" width="120" height="60" rx="4" fill="${['#8a99a8', '#a48d74', '#8aa08a'][n]}"/><rect x="34" y="52" width="40" height="48" fill="#fff" opacity=".5"/></svg></div>`,
    )
    .join('')}</div>`

function pricing(ctx) {
  const prices = ctx.prod ? [29, 59, null] : [35, 65, null]
  const yearly = !ctx.prod && ctx.round >= 3
  const plans = [
    [
      'Starter',
      prices[0],
      'For small crews getting organized',
      ['Up to 5 technicians', 'Scheduling and dispatch', 'Mobile app', 'Invoices and payments'],
    ],
    [
      'Growth',
      prices[1],
      'For teams with several crews',
      ['Unlimited technicians', 'Route planning', 'Inventory and purchase orders', 'Customer portal', 'Reports'],
    ],
    [
      'Enterprise',
      prices[2],
      'For multi-region operations',
      ['Single sign-on', 'Custom roles', 'Audit log export', 'Dedicated success manager'],
    ],
  ]
  return marketing({
    title: 'Pricing',
    active: 'Pricing',
    body: `<div class="wrap"><section class="section stack" style="align-items:center;text-align:center"><h1 class="mk-h1">Simple pricing per technician</h1><p class="lede">Office seats are free. Pay only for the people in the field.</p>
    <div class="segmented" data-testid="billing-toggle"><span class="${yearly ? '' : 'on'}">Monthly</span><span class="${yearly ? 'on' : ''}">Yearly ${badge('2 months free', 'green plain')}</span></div></section>
    <div class="grid g3" data-testid="plans">${plans
      .map(
        ([name, price, sub, items], i) =>
          `<section class="card plan ${i === 1 ? 'featured' : ''}" data-testid="plan-${name.toLowerCase()}">${i === 1 ? badge('Most popular', 'brand plain') : '<span style="height:22px"></span>'}<h2>${name}</h2><p class="muted">${sub}</p><div class="price">${
            price ? `$${yearly ? Math.round((price * 10) / 12) : price}<small> per tech / month</small>` : 'Custom'
          }</div><a class="btn ${i === 1 ? 'primary' : ''} block lg" href="${price ? '/signup/' : '/contact/'}">${price ? 'Start free trial' : 'Talk to sales'}</a><ul>${items.map((item) => `<li>${icon('check')}${item}</li>`).join('')}</ul></section>`,
      )
      .join('')}</div>
    <section class="section stack" style="max-width:760px;margin:0 auto"><h2 class="big">Questions</h2>${[
      ['Do office users cost extra?', 'No. Dispatchers, admins and billing staff are free on every plan.'],
      ['Can we import our customers?', 'Yes, from a spreadsheet or from most accounting tools.'],
      ['What happens after the trial?', 'Pick a plan, or your workspace stays read-only for 30 days.'],
    ]
      .map(([q, a]) => `<div class="card card-b"><strong>${q}</strong><p class="muted mt-s">${a}</p></div>`)
      .join('')}</section></div>${ctaBand()}`,
  })
}

function changelog(ctx) {
  const entries = [
    ...(ctx.prod ? [] : [['Nov 18', 'Route planning', "Plan a technician's whole day on the map, with drive times between jobs.", 'New']]),
    ['Nov 4', 'Offline mode for technicians', 'Checklists, photos and signatures save on the phone and sync later.', 'New'],
    ['Oct 21', 'Bulk actions on work orders', 'Select many jobs and reschedule, reprioritize or close them at once.', 'Improved'],
    ['Oct 7', 'Faster invoice PDFs', 'Invoices render in under a second, with your logo and terms.', 'Improved'],
    ['Sep 23', 'Purchase order approvals', 'Set a limit above which a PO needs an admin to approve it.', 'New'],
  ]
  return marketing({
    title: 'Changelog',
    active: 'Changelog',
    body: `<div class="wrap" style="max-width:820px"><section class="section stack"><h1 class="mk-h1">Changelog</h1><p class="lede">What is new in Brackwell, every two weeks.</p>${entries
      .map(
        ([date, title, text, kind], i) =>
          `<article class="card card-b stack tight" ${i === 0 ? 'data-testid="release-latest"' : ''}><div class="row"><span class="muted small">${date}</span>${badge(kind, kind === 'New' ? 'brand' : 'blue')}</div><h2>${title}</h2><p class="muted">${text}</p></article>`,
      )
      .join('')}</section></div>`,
  })
}

function contact() {
  return marketing({
    title: 'Contact sales',
    body: `<div class="wrap"><section class="section grid g2" style="gap:48px"><div class="stack"><h1 class="mk-h1">Talk to our team</h1><p class="lede">Tell us about your crews and we will show you Brackwell with your kind of jobs.</p><ul class="list card">${[
      ['clock', 'A 30 minute call, at a time that suits you'],
      ['layers', 'A workspace with your data imported'],
      ['shield-check', 'Security review documents on request'],
    ]
      .map(([ic, t]) => `<li>${icon(ic)}${t}</li>`)
      .join('')}</ul></div>
    <form class="card card-b stack" action="/contact/" method="post">${field('Full name', 'Jordan Reyes')}${field('Work email', '', { placeholder: 'you@company.example' })}<div class="grid g2">${field('Company', '', { placeholder: 'Company name' })}${field('Technicians', '25-100', { kind: 'select' })}</div>${field('What should we cover?', '', { kind: 'textarea', placeholder: 'Scheduling, inventory, moving from spreadsheets...' })}<button class="btn primary lg" type="submit">Book a call</button></form></section></div>`,
  })
}

function security() {
  return marketing({
    title: 'Security',
    body: `<div class="wrap" style="max-width:900px"><section class="section stack"><span class="eyebrow">${icon('shield-check')}Trust</span><h1 class="mk-h1">Security at Brackwell</h1><p class="lede">Your customers' addresses and your crews' locations deserve care. Here is how we handle them.</p>
    <div class="grid g2">${[
      ['lock', 'Encryption', 'Data is encrypted in transit and at rest.'],
      ['key-round', 'Single sign-on', 'SAML and OIDC on the Enterprise plan.'],
      ['history', 'Audit log', 'Every change to roles, settings and data exports is recorded.'],
      ['map-pin', 'Location privacy', 'Technician locations are shared only while they are on shift.'],
    ]
      .map(
        ([ic, t, p]) =>
          `<section class="card feature"><div class="ic">${icon(ic === 'history' ? 'clock' : ic)}</div><h3>${t}</h3><p>${p}</p></section>`,
      )
      .join('')}</div></section></div>`,
  })
}

export const pages = [
  { id: 'home', path: '/', title: 'Home', group: G, render: home, frameHeight: TALL },
  { id: 'product', path: '/product/', title: 'Product overview', group: G, render: product, frameHeight: TALL },
  {
    id: 'feat-scheduling',
    path: '/features/scheduling/',
    title: 'Feature: scheduling',
    group: G,
    render: () => featurePage('scheduling'),
    frameHeight: TALL,
  },
  {
    id: 'feat-dispatch',
    path: '/features/dispatch/',
    title: 'Feature: dispatch',
    group: G,
    render: () => featurePage('dispatch'),
    frameHeight: TALL,
  },
  {
    id: 'feat-mobile',
    path: '/features/mobile/',
    title: 'Feature: mobile app',
    group: G,
    render: () => featurePage('mobile'),
    frameHeight: TALL,
  },
  { id: 'sol-hvac', path: '/solutions/hvac/', title: 'Solution: HVAC', group: G, render: () => solution('hvac'), frameHeight: TALL },
  {
    id: 'sol-facilities',
    path: '/solutions/facilities/',
    title: 'Solution: facilities',
    group: G,
    render: () => solution('facilities'),
    frameHeight: TALL,
  },
  { id: 'customers', path: '/customers/', title: 'Customers', group: G, render: customers, frameHeight: TALL },
  { id: 'story', path: '/customers/ridgeway/', title: 'Customer story', group: G, render: story, frameHeight: TALL },
  { id: 'pricing', path: '/pricing/', title: 'Pricing', group: G, render: pricing, frameHeight: TALL },
  { id: 'changelog', path: '/changelog/', title: 'Changelog', group: G, render: changelog, frameHeight: { desktop: 1400, phone: 2200 } },
  { id: 'contact', path: '/contact/', title: 'Contact sales', group: G, render: contact, frameHeight: { desktop: 1300, phone: 2000 } },
  { id: 'security', path: '/security/', title: 'Security', group: G, render: security, frameHeight: { desktop: 1400, phone: 2200 } },
]
