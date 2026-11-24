// Outside the office: the customer portal (in the service company's own
// colors), the technician's phone app, and the system pages.
import { WORK_ORDERS } from '../data.js'
import { portal, system, tech } from '../shells.js'
import { avatar, badge, btn, card, esc, field, icon, logoMark, map, money, photo, status } from '../ui.js'

const PT = 'Customer portal'
const TA = 'Technician app'
const SY = 'System'

// ---- Customer portal ----
const portalSignIn = () =>
  portal({
    title: 'Portal sign in',
    body: `<section class="card center-card" style="margin:24px auto"><div class="big-ic blue">${icon('lock')}</div><h1>Sign in to your service portal</h1><p class="muted">Track visits, approve estimates and pay invoices from Northgate Mechanical.</p><form class="stack" style="width:100%;text-align:left" action="/portal/" method="post">${field('Email', 'amara@crestline.example')}<button class="btn dark lg" type="submit">Email me a sign-in link</button></form></section>`,
  })

const portalHome = () =>
  portal({
    title: 'Portal home',
    body: `<div class="row between wrap"><div><h1>Hello, Amara</h1><p class="muted">Crestline Dental Group · 4 sites</p></div><a class="btn dark" href="/portal/request/">${icon('plus')}Request service</a></div>
    <div class="alert info">${icon('truck')}<div><strong>Dana is on the way to North office.</strong> Arriving around 9:45.</div></div>
    ${card({ title: 'Open requests', pad: false, body: `<ul class="list"><li><span class="mono muted">WO-4823</span><a class="grow" href="/portal/requests/wo-4823/">Rooftop unit not cooling</a>${status('In progress')}</li><li><span class="mono muted">WO-4840</span><span class="grow">Quarterly PM: boilers</span>${status('Scheduled')}</li></ul>` })}
    <div class="grid g2">${card({ title: 'Waiting for you', pad: false, body: `<ul class="list"><li>${icon('file-text')}<a class="grow" href="/portal/estimates/est-311/">Estimate EST-311, coil cleaning</a><strong class="num">${money(6980)}</strong></li></ul>` })}${card({ title: 'Invoices', pad: false, body: `<ul class="list"><li>${icon('receipt')}<a class="grow" href="/portal/pay/">INV-20621</a><strong class="num">${money(1284.5, true)}</strong>${badge('Due Dec 4', 'amber')}</li></ul>` })}</div>`,
  })

const portalRequest = () =>
  portal({
    title: 'Request service',
    body: `<h1>Request service</h1><form class="card card-b stack" action="/portal/requests/wo-4823/" method="post">${field('Site', 'North office, 1180 Beacon Way', { kind: 'select' })}${field('What is wrong?', 'The waiting room is very warm. The AC seems to run but the air is not cold.', { kind: 'textarea' })}<div class="field"><label>How urgent?</label><div class="row wrap">${['Today', 'This week', 'When convenient'].map((t, i) => `<span class="chip ${i === 0 ? 'on' : ''}">${t}</span>`).join('')}</div></div><div class="field"><label>Photos</label><div class="row">${photo(1).replace('class="photo"', 'class="photo" style="width:120px"')}${btn('Add photo', { ic: 'camera', size: 'sm' })}</div></div><button class="btn dark lg" type="submit">Send request</button></form>`,
  })

const portalStatus = () =>
  portal({
    title: 'Request status',
    body: `<a class="small row" href="/portal/">${icon('arrow-left')}All requests</a><h1>Rooftop unit not cooling</h1><p class="muted">WO-4823 · North office · ${status('In progress')}</p>
    ${card({
      body: `<ul class="timeline">${[
        ['inbox', 'Request received', '8:14'],
        ['user-plus', 'Dana Whitlock assigned', '8:32'],
        ['truck', 'Dana is on the way', '9:21'],
        ['map-pin', 'Dana arrived', '9:48'],
        ['wrench', 'Working on it', 'now'],
      ]
        .map(
          ([ic, t, at]) =>
            `<li><span class="dot">${icon(ic)}</span><div><strong>${t}</strong><div class="muted small">Today ${at}</div></div></li>`,
        )
        .join('')}</ul>`,
    })}${card({ title: 'Your technician', body: `<div class="row">${avatar('Dana Whitlock')}<div class="grow"><strong>Dana Whitlock</strong><div class="muted small">HVAC · rated 4.9</div></div>${btn('Message', { ic: 'message-square', size: 'sm' })}</div>` })}`,
  })

const portalEstimate = () =>
  portal({
    title: 'Approve estimate',
    body: `<h1>Estimate EST-311</h1><p class="muted">Coil cleaning, 2 rooftop units · valid until Dec 20</p>${card({
      pad: false,
      body: `<table class="t"><tbody><tr><td>Coil cleaning, RTU-1</td><td class="right num">${money(3290)}</td></tr><tr><td>Coil cleaning, RTU-2</td><td class="right num">${money(3290)}</td></tr><tr><td>Disposal and materials</td><td class="right num">${money(400)}</td></tr><tr><td><strong>Total</strong></td><td class="right num"><strong>${money(6980)}</strong></td></tr></tbody></table>`,
    })}<div class="field"><label>Sign to approve</label><div class="sig"><svg viewBox="0 0 400 140" aria-hidden="true"><path d="M40 100 C 70 40, 90 120, 120 70 S 170 40, 190 90 S 240 110, 270 60 S 330 70, 360 80" fill="none" stroke="#0e1726" stroke-width="2.5"/></svg></div></div><div class="row">${btn('Decline', { kind: 'ghost' })}<span class="grow"></span>${btn('Approve estimate', { kind: 'dark', ic: 'check', attrs: ' data-testid="approve-estimate"' })}</div>`,
  })

const portalPay = () =>
  portal({
    title: 'Pay invoice',
    body: `<h1>Pay INV-20621</h1><div class="grid g2">${card({ title: 'Summary', body: `<dl class="kv"><dt>Invoice</dt><dd>INV-20621</dd><dt>For</dt><dd>Exhaust fan repair, Oct 30</dd><dt>Due</dt><dd>Dec 4</dd><dt>Amount</dt><dd><strong>${money(1284.5, true)}</strong></dd></dl>` })}
    <form class="card card-b stack" action="/portal/" method="post"><div class="segmented"><span class="on">Card</span><span>Bank transfer</span></div>${field('Name on card', 'Amara Bell')}<div class="field"><label>Card</label><div class="input"><span class="faint">Card number</span></div></div><div class="grid g2"><div class="field"><label>Expiry</label><div class="input"><span class="faint">MM / YY</span></div></div><div class="field"><label>CVC</label><div class="input"></div></div></div><button class="btn dark lg" type="submit">Pay ${money(1284.5, true)}</button><p class="muted small">${icon('lock')} Payments are processed securely. Northgate never sees your card number.</p></form></div>`,
  })

// ---- Technician app ----
const techTop = (title, sub) =>
  `<div class="row between"><span class="row" style="color:#fff;font-weight:700">${logoMark()}${esc(title)}</span>${icon('bell')}</div>${sub ? `<div style="font-size:13px">${sub}</div>` : ''}`

const techToday = () =>
  tech({
    title: 'Technician: today',
    top: `${techTop('Today', '')}<div style="font-size:22px;font-weight:800">Morning, Dana</div><div class="row small" style="color:#c9d4e0">5 jobs · 38 mi · first at 7:30</div>`,
    body: WORK_ORDERS.slice(0, 5)
      .map(
        (j, i) =>
          `<a class="card card-b stack tight" href="/tech/job/" style="color:inherit${i === 2 ? ';border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)' : ''}"><div class="row between"><span class="mono muted">${['7:30', '9:25', '10:30', '13:30', '15:00'][i]}</span>${i < 2 ? badge('Done', 'green') : i === 2 ? badge('Now', 'brand') : status('Scheduled')}</div><strong>${esc(j.title)}</strong><span class="muted small">${esc(j.customer)} · ${[3, 6, 4, 9, 2][i]} mi</span></a>`,
      )
      .join(''),
  })

const techJob = (ctx) =>
  tech({
    title: 'Technician: job',
    tab: 'Jobs',
    top: `${techTop('WO-4823', '')}<div style="font-size:20px;font-weight:800">Rooftop unit not cooling</div><div class="small" style="color:#c9d4e0">Crestline Dental Group · North office</div>`,
    body: `${map({ height: 150, pins: [{ x: 50, y: 55, label: '' }] })}<div class="row">${btn('Navigate', { kind: ctx.round >= 2 ? 'primary lg' : 'sm', ic: 'route', attrs: ' data-testid="tech-navigate"' })}${btn('Call', { ic: 'phone', size: ctx.round >= 2 ? 'lg' : 'sm' })}</div>
    ${card({ title: 'Problem', body: '<p>Waiting room is at 81°F. Unit runs but blows warm air. Breaker reset at 8:10.</p>' })}${card({ title: 'Access', body: '<p class="muted">Gate code at reception. Roof via east stairwell, key in lockbox 3.</p>' })}
    <div class="grid g2">${btn('Checklist 4/7', { ic: 'list-checks', href: '/tech/checklist/' })}${btn('Photos', { ic: 'camera', href: '/tech/photos/' })}</div>`,
    cta: btn('Arrived on site', { kind: 'primary block lg', ic: 'map-pin' }),
  })

const techChecklist = () =>
  tech({
    title: 'Technician: checklist',
    tab: 'Jobs',
    top: `${techTop('Checklist', 'WO-4823 · 4 of 7 done')}<div class="progress"><i style="width:57%"></i></div>`,
    body: card({
      body: [
        ['Check thermostat setpoint and mode', true],
        ['Inspect filters, replace if dirty', true],
        ['Test capacitor', true],
        ['Check contactor for pitting', true],
        ['Measure supply and return temperatures', false],
        ['Check refrigerant pressures', false],
        ['Photo of the nameplate', false],
      ]
        .map(
          ([t, done]) =>
            `<div class="check-row ${done ? 'done' : ''}" style="padding:14px 0"><span class="box">${done ? icon('check') : ''}</span><span class="txt grow">${t}</span></div>`,
        )
        .join(''),
    }),
    cta: btn('Next: measure temperatures', { kind: 'primary block lg' }),
  })

const techPhotos = () =>
  tech({
    title: 'Technician: photos',
    tab: 'Jobs',
    top: techTop('Photos', 'WO-4823 · 6 photos'),
    body: `<div class="grid g2">${[0, 1, 2, 3, 1, 0].map((n) => photo(n)).join('')}</div>`,
    cta: btn('Take photo', { kind: 'primary block lg', ic: 'camera' }),
  })

const techParts = () =>
  tech({
    title: 'Technician: parts used',
    tab: 'Parts',
    top: techTop('Parts used', 'WO-4823 · from Van 2'),
    body: `${card({
      pad: false,
      body: `<ul class="list">${[
        ['Run capacitor 45/5 MFD', 1, 1],
        ['Contactor 30A 2-pole', 1, 3],
        ['Pleated filter 20x25x2', 0, 18],
      ]
        .map(
          ([n, used, left]) =>
            `<li><div class="grow"><strong>${n}</strong><div class="muted small">${left} left on the van</div></div><span class="row">${btn('', { ic: 'x', size: 'sm' })}<strong class="num" style="width:20px;text-align:center">${used}</strong>${btn('', { ic: 'plus', size: 'sm' })}</span></li>`,
        )
        .join('')}</ul>`,
    })}<div class="search-in input">${icon('search')}&nbsp;<span class="faint">Find a part or scan a barcode</span></div>`,
    cta: btn('Save parts', { kind: 'primary block lg' }),
  })

const techSignature = () =>
  tech({
    title: 'Technician: signature',
    tab: 'Jobs',
    top: techTop('Customer sign-off', 'WO-4823'),
    body: `${card({ title: 'Work done', body: `<p>Replaced run capacitor and contactor. Supply air 56°F after 20 minutes.</p><p class="muted small mt-s">Parts and labor: ${money(360.5, true)}</p>` })}<div class="field"><label>Customer signature</label><div class="sig"><svg viewBox="0 0 400 140" aria-hidden="true"><path d="M50 95 C 80 30, 110 120, 140 70 S 200 50, 220 95 S 280 100, 300 55" fill="none" stroke="#0e1726" stroke-width="2.5"/></svg></div></div>${field('Name', 'Vera Stone')}`,
    cta: btn('Complete job', { kind: 'primary block lg', ic: 'circle-check' }),
  })

const techClock = () =>
  tech({
    title: 'Technician: clock in',
    tab: 'Me',
    top: techTop('Time', 'Monday, Nov 23'),
    body: `<section class="card card-b stack" style="align-items:center;text-align:center;padding:28px"><span class="muted small">On the clock</span><div style="font-size:44px;font-weight:800" class="num">3:42</div><span class="muted small">Since 7:02 · Van 2</span>${btn('Start break', { size: 'lg' })}</section>${card({ title: 'This week', pad: false, body: `<ul class="list">${['Mon 3.7 h', 'Sun off', 'Sat off', 'Fri 8.1 h', 'Thu 9.4 h'].map((d) => `<li><span class="grow">${d.split(' ')[0]}</span><strong>${d.split(' ').slice(1).join(' ')}</strong></li>`).join('')}</ul>` })}`,
    cta: btn('Clock out', { kind: 'dark block lg' }),
  })

const techOffline = () =>
  tech({
    title: 'Technician: offline',
    offline: true,
    tab: 'Jobs',
    top: `${techTop('WO-4823', '')}<div style="font-size:20px;font-weight:800">Rooftop unit not cooling</div>`,
    body: `<div class="alert warn">${icon('cloud')}<div><strong>3 changes waiting to sync</strong><br />2 photos and a checklist step are saved on this phone.</div></div>${card({ title: 'Saved on this phone', pad: false, body: `<ul class="list"><li>${icon('camera')}<span class="grow">2 photos</span>${badge('Waiting', 'amber')}</li><li>${icon('check')}<span class="grow">Measure temperatures</span>${badge('Waiting', 'amber')}</li></ul>` })}`,
    cta: btn('Try to sync now', { kind: 'block lg', ic: 'refresh-cw' }),
  })

const techJobs = () =>
  tech({
    title: 'Technician: jobs',
    tab: 'Jobs',
    top: `${techTop('Jobs', '')}<div class="segmented" style="background:#1f3650"><span class="on">This week</span><span style="color:#c9d4e0">Done</span></div>`,
    body: WORK_ORDERS.slice(5, 12)
      .map(
        (j) =>
          `<a class="card card-b row" href="/tech/job/" style="color:inherit"><div class="grow"><strong>${esc(j.title)}</strong><div class="muted small">${esc(j.customer)} · ${j.due}</div></div>${icon('chevron-right')}</a>`,
      )
      .join(''),
  })

// ---- System ----
const notFound = () =>
  system({
    title: 'Page not found',
    body: `<div class="code-big">404</div><h1>We could not find that page</h1><p class="muted">It may have moved, or the link is old.</p><div class="row"><a class="btn primary" href="/app/" data-testid="home-link">Go to your dashboard</a><a class="btn" href="/app/search/">Search</a></div>`,
  })
const serverError = () =>
  system({
    title: 'Something went wrong',
    body: `<div class="code-big">500</div><h1>Something went wrong on our side</h1><p class="muted">We have been told about it. Your work is saved; try again in a minute.</p><div class="row"><a class="btn primary" href="/app/">Back to Brackwell</a><a class="btn" href="/changelog/">Service status</a></div><p class="mono faint">Reference: 7f3a-91c2</p>`,
  })
const maintenance = () =>
  system({
    title: 'Scheduled maintenance',
    body: `<div class="big-ic blue">${icon('wrench')}</div><h1>Brackwell is getting an upgrade</h1><p class="muted">Back by 2:00 Central, Sunday Nov 29. The technician app keeps working offline.</p>`,
  })
const noAccess = () =>
  system({
    title: 'No access',
    body: `<div class="big-ic red">${icon('lock')}</div><h1>You do not have access to this page</h1><p class="muted">Billing is for Owners, Admins and Billing. Ask Robin Ash for access.</p><a class="btn primary" href="/app/">Back to your dashboard</a>`,
  })
const offlinePage = () =>
  system({
    title: 'Offline',
    body: `<div class="big-ic">${icon('wifi-off')}</div><h1>You are offline</h1><p class="muted">Brackwell needs a connection for this page. We will reload it when you are back.</p>${btn('Try again', { ic: 'refresh-cw' })}`,
  })

const TECH_FRAME = { desktop: 960, phone: 844 }
export const pages = [
  { id: 'portal-signin', path: '/portal/signin/', title: 'Portal: sign in', group: PT, render: portalSignIn },
  { id: 'portal', path: '/portal/', title: 'Portal: home', group: PT, render: portalHome },
  { id: 'portal-request', path: '/portal/request/', title: 'Portal: request service', group: PT, render: portalRequest },
  { id: 'portal-status', path: '/portal/requests/wo-4823/', title: 'Portal: request status', group: PT, render: portalStatus },
  { id: 'portal-estimate', path: '/portal/estimates/est-311/', title: 'Portal: approve estimate', group: PT, render: portalEstimate },
  { id: 'portal-pay', path: '/portal/pay/', title: 'Portal: pay invoice', group: PT, render: portalPay },
  { id: 'tech-today', path: '/tech/', title: 'Tech app: today', group: TA, render: techToday, frameHeight: TECH_FRAME },
  { id: 'tech-jobs', path: '/tech/jobs/', title: 'Tech app: jobs', group: TA, render: techJobs, frameHeight: TECH_FRAME },
  { id: 'tech-job', path: '/tech/job/', title: 'Tech app: job', group: TA, render: techJob, frameHeight: TECH_FRAME },
  {
    id: 'tech-checklist',
    path: '/tech/checklist/',
    title: 'Tech app: checklist',
    group: TA,
    render: techChecklist,
    frameHeight: TECH_FRAME,
  },
  { id: 'tech-photos', path: '/tech/photos/', title: 'Tech app: photos', group: TA, render: techPhotos, frameHeight: TECH_FRAME },
  { id: 'tech-parts', path: '/tech/parts/', title: 'Tech app: parts used', group: TA, render: techParts, frameHeight: TECH_FRAME },
  {
    id: 'tech-signature',
    path: '/tech/signature/',
    title: 'Tech app: sign-off',
    group: TA,
    render: techSignature,
    frameHeight: TECH_FRAME,
  },
  { id: 'tech-clock', path: '/tech/clock/', title: 'Tech app: time clock', group: TA, render: techClock, frameHeight: TECH_FRAME },
  {
    id: 'tech-offline',
    path: '/tech/offline/',
    title: 'Tech app: offline',
    group: TA,
    note: 'Offline state',
    render: techOffline,
    frameHeight: TECH_FRAME,
  },
  { id: 'not-found', path: '/404/', title: 'Not found (404)', group: SY, render: notFound },
  { id: 'server-error', path: '/500/', title: 'Server error (500)', group: SY, render: serverError },
  { id: 'maintenance', path: '/maintenance/', title: 'Maintenance', group: SY, render: maintenance },
  { id: 'no-access', path: '/403/', title: 'No access (403)', group: SY, render: noAccess },
  { id: 'offline', path: '/offline/', title: 'Offline', group: SY, render: offlinePage },
]
