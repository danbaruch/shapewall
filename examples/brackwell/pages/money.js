// Money: invoices, estimates, payments and the price book; reports; and
// Northgate's own Brackwell plan and billing.
import { CUSTOMERS, INVOICES, MONTHS, REVENUE, REVENUE_LAST, TECHS } from '../data.js'
import { app } from '../shells.js'
import {
  avatar,
  badge,
  barChart,
  btn,
  card,
  donut,
  esc,
  field,
  icon,
  legend,
  lineChart,
  money,
  pageHead,
  stat,
  status,
  table,
  tabs,
} from '../ui.js'

const B = 'Invoices & payments'
const R = 'Reports'
const PB = 'Plan & billing'

const invTabs = (active) =>
  tabs(
    [
      ['Invoices', '/app/invoices/', 22],
      ['Overdue', '/app/invoices/overdue/', 3],
      ['Estimates', '/app/invoices/estimates/', 8],
      ['Payments', '/app/invoices/payments/'],
      ['Price book', '/app/invoices/price-book/'],
    ],
    active,
  )
const invHead = (active) =>
  `${pageHead({ title: 'Invoices', sub: `${money(48210)} billed this week · ${money(9724)} overdue`, acts: `${btn('Export', { ic: 'download' })}${btn('New invoice', { kind: 'primary', ic: 'plus', href: '/app/invoices/new/' })}` })}${invTabs(active)}`
const INV_COLS = [
  { label: 'Invoice' },
  { label: 'Customer' },
  { label: 'Issued', cls: 'hide-sm' },
  { label: 'Due', cls: 'hide-sm' },
  { label: 'Amount', cls: 'right' },
  { label: 'Status' },
]
const invRow = (inv) => [
  `<a class="mono" href="/app/invoices/inv-20616/">${inv.id}</a>`,
  esc(inv.customer),
  inv.issued,
  inv.due,
  `<span class="num">${money(inv.amount, true)}</span>`,
  status(inv.state),
]

function invoices() {
  return app({
    title: 'Invoices',
    nav: 'Invoices',
    body: `${invHead('Invoices')}<div class="grid g4">${stat('Outstanding', money(31480))}${stat('Overdue', money(9724), '3 invoices', 'down')}${stat('Paid, 30 days', money(186300), '+9%')}${stat('Avg days to pay', '11', '-2 days')}</div>${table(INV_COLS, INVOICES.slice(0, 10).map(invRow), { pager: '1-10 of 22' })}`,
  })
}

function overdue() {
  return app({
    title: 'Invoices: overdue',
    nav: 'Invoices',
    body: `${invHead('Overdue')}<div class="alert err">${icon('triangle-alert')}<div class="grow"><strong>3 invoices are overdue, ${money(9724)} in total.</strong> Reminders went out 3 days ago.</div>${btn('Send reminders', { size: 'sm' })}</div>${table(
      INV_COLS,
      INVOICES.filter((i) => i.state === 'Overdue')
        .concat(INVOICES.slice(5, 6))
        .map((i) => invRow({ ...i, state: 'Overdue' })),
    )}`,
  })
}

const lines = [
  ['Repair, HVAC: rooftop unit not cooling', 1, 0],
  ['Run capacitor 45/5 MFD', 1, 64],
  ['Contactor 30A 2-pole', 1, 79],
  ['Labor, standard rate', 1.5, 145],
]
const invTable = () =>
  `<table class="t"><thead><tr><th>Description</th><th class="right">Qty</th><th class="right hide-sm">Rate</th><th class="right">Amount</th></tr></thead><tbody>${lines
    .filter((l) => l[2])
    .map(
      ([d, q, r]) =>
        `<tr><td>${d}</td><td class="right">${q}</td><td class="right num hide-sm">${money(r, true)}</td><td class="right num">${money(q * r, true)}</td></tr>`,
    )
    .join(
      '',
    )}<tr><td colspan="2"></td><td class="right muted hide-sm">Tax 7%</td><td class="right num">${money(25.24, true)}</td></tr><tr><td colspan="2"></td><td class="right hide-sm"><strong>Total</strong></td><td class="right num"><strong>${money(385.74, true)}</strong></td></tr></tbody></table>`

function invoiceDetail(ctx) {
  return app({
    title: 'Invoice',
    nav: 'Invoices',
    body: `${pageHead({
      title: 'INV-20616',
      sub: `Harborview Apartments · from WO-4823 · ${status('Overdue')}`,
      crumbs: [
        ['Invoices', '/app/invoices/'],
        ['INV-20616', null],
      ],
      acts: `${ctx.round >= 2 ? btn('Download PDF', { ic: 'download', attrs: ' data-testid="invoice-pdf"' }) : ''}${btn('Send reminder', { ic: 'send' })}${btn('Record payment', { kind: 'primary', ic: 'dollar-sign', href: '/app/invoices/payments/' })}`,
    })}
    <div class="grid g-main"><section class="card card-b stack" data-testid="invoice-paper"><div class="row between"><div class="row">${avatar('Northgate Mechanical')}<div><strong>Northgate Mechanical</strong><div class="muted small">42 Tannery Row, Port Alder</div></div></div><div class="right"><div style="font-size:20px;font-weight:800">Invoice</div><div class="muted small mono">INV-20616</div></div></div>
    <div class="grid g2 small"><div><div class="muted">Bill to</div><strong>Harborview Apartments</strong><div>Jonah Pierce, 2210 Kiln St</div></div><div><div class="muted">Issued Nov 3 · Due Nov 18</div><div class="muted">Terms: Net 15</div></div></div>${invTable()}</section>
    <div class="stack">${card({ title: 'Activity', body: `<ul class="timeline"><li><span class="dot">${icon('send')}</span><div>Sent to Jonah Pierce<div class="muted small">Nov 3</div></div></li><li><span class="dot">${icon('eye')}</span><div>Viewed twice<div class="muted small">Nov 4</div></div></li><li><span class="dot">${icon('mail')}</span><div>Reminder sent<div class="muted small">Nov 19</div></div></li></ul>` })}</div></div>`,
  })
}

function invoiceNew() {
  return app({
    title: 'New invoice',
    nav: 'Invoices',
    body: `${pageHead({
      title: 'New invoice from WO-4823',
      crumbs: [
        ['Invoices', '/app/invoices/'],
        ['New', null],
      ],
    })}<div class="grid g-main"><form class="card card-b stack" action="/app/invoices/sent/" method="post"><div class="grid g2">${field('Customer', 'Crestline Dental Group', { kind: 'select' })}${field('Send to', 'billing@crestline.example')}</div><div class="grid g2">${field('Terms', 'Net 15', { kind: 'select' })}${field('Due', 'Dec 8', { kind: 'select' })}</div>${invTable()}${field('Note to customer', 'Thanks for calling us. The unit is cooling again; we recommend a coil cleaning in spring.', { kind: 'textarea' })}<div class="row" style="justify-content:flex-end">${btn('Save draft', { kind: 'ghost' })}${btn('Send invoice', { kind: 'primary', ic: 'send', href: '/app/invoices/sent/' })}</div></form>
    ${card({ title: 'Payment options', body: `<div class="stack tight"><label class="row"><span class="cb on"></span>Card</label><label class="row"><span class="cb on"></span>Bank transfer</label><label class="row"><span class="cb"></span>Check</label></div>` })}</div>`,
  })
}

function invoiceSent() {
  return app({
    title: 'Invoice sent',
    nav: 'Invoices',
    body: `${invHead('Invoices')}${table(INV_COLS, INVOICES.slice(0, 8).map(invRow))}`,
    overlay: `<div class="toast" role="status">${icon('circle-check')}Invoice INV-20636 sent to billing@crestline.example<a href="/app/invoices/inv-20616/" style="color:#fdba74;margin-left:8px">View</a></div>`,
  })
}

function estimates() {
  return app({
    title: 'Estimates',
    nav: 'Invoices',
    body: `${invHead('Estimates')}${table(
      [
        { label: 'Estimate' },
        { label: 'Customer' },
        { label: 'For', cls: 'hide-sm' },
        { label: 'Amount', cls: 'right' },
        { label: 'Status' },
      ],
      [
        ['EST-311', 'Crestline Dental Group', 'Coil cleaning, 2 units', 6980, 'Approved'],
        ['EST-312', 'Larkspur Hotel', 'Exhaust hood motor', 2140, 'Sent'],
        ['EST-313', 'Meridian Office Tower', 'VAV box replacements', 18450, 'Pending'],
        ['EST-314', 'Brightwater Fitness', 'Locker room water heater', 3920, 'Declined'],
        ['EST-315', 'Alder County Library', 'Emergency lighting', 7310, 'Draft'],
      ].map(([id, c, f, a, s]) => [
        `<a class="mono" href="/app/invoices/estimates/est-313/">${id}</a>`,
        c,
        `<span class="muted">${f}</span>`,
        `<span class="num">${money(a)}</span>`,
        status(s),
      ]),
    )}`,
  })
}

function estimate() {
  return app({
    title: 'Estimate',
    nav: 'Invoices',
    body: `${pageHead({
      title: 'EST-313: VAV box replacements',
      sub: `Meridian Office Tower · ${status('Pending')} · good for 30 days`,
      crumbs: [
        ['Estimates', '/app/invoices/estimates/'],
        ['EST-313', null],
      ],
      acts: `${btn('Edit', { ic: 'pen-line' })}${btn('Send to customer', { kind: 'primary', ic: 'send' })}`,
    })}
    <div class="grid g3">${[
      ['Good', 'Replace 4 failed boxes', 9200, false],
      ['Better', 'Replace 8 boxes on floor 3', 18450, true],
      ['Best', 'Floors 3 and 4, new controls', 31800, false],
    ]
      .map(
        ([t, d, a, on]) =>
          `<section class="card plan ${on ? 'featured' : ''}">${on ? badge('Recommended', 'brand plain') : ''}<h2>${t}</h2><p class="muted">${d}</p><div class="price">${money(a)}</div><span class="muted small">${on ? '3 days of work, 2 technicians' : 'Option'}</span></section>`,
      )
      .join('')}</div>`,
  })
}

function payments() {
  return app({
    title: 'Payments',
    nav: 'Invoices',
    body: `${invHead('Payments')}<div class="grid g-main">${card({ title: 'Payments received', body: barChart([32, 41, 38, 52, 47, 58, 61, 55, 66, 72, 69, 78], { labels: MONTHS }) })}${card(
      {
        title: 'By method',
        body: `<div class="row" style="gap:20px">${donut([
          { value: 58, color: '#2563eb' },
          { value: 31, color: '#ea6a1f' },
          { value: 11, color: '#94a3b8' },
        ])}${legend([
          ['Card', '#2563eb'],
          ['Bank transfer', '#ea6a1f'],
          ['Check', '#94a3b8'],
        ])}</div>`,
      },
    )}</div>
    ${table(
      [
        { label: 'Date' },
        { label: 'Customer' },
        { label: 'Method', cls: 'hide-sm' },
        { label: 'Invoice', cls: 'hide-sm' },
        { label: 'Amount', cls: 'right' },
      ],
      INVOICES.filter((i) => i.state === 'Paid').map((i, n) => [
        i.issued,
        esc(i.customer),
        ['Card ending 4412', 'Bank transfer', 'Card ending 0937'][n % 3],
        `<span class="mono">${i.id}</span>`,
        `<span class="num">${money(i.amount, true)}</span>`,
      ]),
    )}`,
  })
}

function priceBook() {
  return app({
    title: 'Price book',
    nav: 'Invoices',
    body: `${invHead('Price book')}${table(
      [
        { label: 'Item' },
        { label: 'Type', cls: 'hide-sm' },
        { label: 'Unit', cls: 'hide-sm' },
        { label: 'Price', cls: 'right' },
        { label: 'Margin', cls: 'right hide-sm' },
      ],
      [
        ['Diagnostic visit', 'Service', 'Visit', 129, 72],
        ['Labor, standard rate', 'Labor', 'Hour', 145, 48],
        ['Labor, after hours', 'Labor', 'Hour', 218, 55],
        ['Quarterly PM, rooftop unit', 'Service', 'Unit', 189, 61],
        ['Run capacitor 45/5 MFD', 'Part', 'Each', 64, 70],
        ['Water heater 50 gal, installed', 'Bundle', 'Each', 2480, 34],
      ].map(([n, t, u, p, m]) => [
        `<strong>${n}</strong>`,
        badge(t, 'plain'),
        u,
        `<span class="num">${money(p)}</span>`,
        `<span class="num">${m}%</span>`,
      ]),
    )}`,
  })
}

// ---- Reports ----
const repHead = (title, sub, trail = true) =>
  pageHead({
    title,
    sub,
    crumbs: trail
      ? [
          ['Reports', '/app/reports/'],
          [title, null],
        ]
      : null,
    acts: `${btn('Last 12 months', { ic: 'calendar-days' })}${btn('Export', { ic: 'download', href: '/app/reports/export/' })}`,
  })

function reports() {
  return app({
    title: 'Reports',
    nav: 'Reports',
    body: `${repHead('Reports', 'Updated every morning at 6:00', false)}<div class="grid g3">${[
      ['trending-up', 'Revenue', 'By month, customer and trade', '/app/reports/revenue/'],
      ['gauge', 'Technician utilization', 'Billable hours against shift hours', '/app/reports/utilization/'],
      ['circle-check', 'First-time fix rate', 'Jobs closed on the first visit', '/app/reports/first-time-fix/'],
      ['timer', 'SLA compliance', 'Response and resolution against terms', '/app/reports/sla/'],
      ['layers', 'Custom report', 'Pick fields, filters and a chart', '/app/reports/custom/'],
      ['download', 'Exports', 'CSV and spreadsheet downloads', '/app/reports/export/'],
    ]
      .map(
        ([ic, t, d, href]) =>
          `<a class="card card-b stack tight" href="${href}" style="color:inherit"><span class="big-ic" style="width:40px;height:40px;border-radius:10px">${icon(ic)}</span><strong>${t}</strong><span class="muted">${d}</span></a>`,
      )
      .join('')}</div>`,
  })
}

function revenue(ctx) {
  const compare = ctx.round >= 3
  return app({
    title: 'Revenue report',
    nav: 'Reports',
    body: `${repHead('Revenue', 'Last 12 months')}<div class="grid g4">${stat('Revenue', '$2.85M', '+18% year on year')}${stat('Gross margin', '41%', '+2 pts')}${stat('Avg job value', money(612), '+$38')}${stat('Repeat customers', '84%')}</div>
    ${card({
      title: compare ? 'Revenue by month, this year and last' : 'Revenue by month',
      actions: compare
        ? legend([
            ['This year', '#ea6a1f'],
            ['Last year', '#2563eb'],
          ])
        : '',
      body: lineChart(compare ? [REVENUE, REVENUE_LAST] : [REVENUE], { labels: MONTHS, height: 240 }),
    })}
    <div class="grid g2">${card({ title: 'By trade', body: barChart([980, 720, 610, 340, 200], { labels: ['HVAC', 'Electrical', 'Plumbing', 'Refrig.', 'Other'] }) })}${card(
      {
        title: 'Top customers',
        pad: false,
        body: `<ul class="list">${CUSTOMERS.slice()
          .sort((a, b) => b.value - a.value)
          .slice(0, 5)
          .map(
            (c) => `<li>${avatar(c.name, 'sm')}<span class="grow">${esc(c.name)}</span><strong class="num">${money(c.value)}</strong></li>`,
          )
          .join('')}</ul>`,
      },
    )}</div>`,
  })
}

function utilization() {
  return app({
    title: 'Utilization report',
    nav: 'Reports',
    body: `${repHead('Technician utilization', 'Billable hours / shift hours, last 30 days')}${card({
      title: 'Team average 81% (target 85%)',
      body: barChart(
        TECHS.map((t) => t.util || 5),
        { labels: TECHS.map((t) => t.name.split(' ')[0]), color: '#2563eb' },
      ),
    })}
    ${table(
      [
        { label: 'Technician' },
        { label: 'Billable', cls: 'right' },
        { label: 'Drive', cls: 'right hide-sm' },
        { label: 'Idle', cls: 'right hide-sm' },
        { label: 'Utilization', cls: 'right' },
      ],
      TECHS.slice(0, 8).map((t) => [
        `<span class="row">${avatar(t.name, 'sm')}${esc(t.name)}</span>`,
        `<span class="num">${Math.round(t.util * 1.6)} h</span>`,
        `<span class="num">${18 + (t.util % 9)} h</span>`,
        `<span class="num">${Math.max(2, 30 - Math.round(t.util / 4))} h</span>`,
        `<span class="num ${t.util < 70 ? 'down' : ''}">${t.util}%</span>`,
      ]),
    )}`,
  })
}

function firstFix() {
  return app({
    title: 'First-time fix report',
    nav: 'Reports',
    body: `${repHead('First-time fix rate', 'Jobs closed without a return visit')}<div class="grid g3">${stat('This quarter', '89%', '+4 pts')}${stat('Return visits', '61', '-18')}${stat('Top reason', 'Part not on van')}</div>${card({ title: 'Trend', body: lineChart([[71, 73, 76, 79, 82, 84, 86, 89]], { labels: ['Q1', 'Q2', 'Q3', 'Q4', 'Q1', 'Q2', 'Q3', 'Q4'] }) })}
    ${card({ title: 'Why a second visit was needed', body: barChart([24, 15, 11, 7, 4], { labels: ['Part missing', 'Needs quote', 'Access', 'Wrong skill', 'Other'], color: '#6d28d9' }) })}`,
  })
}

function sla() {
  return app({
    title: 'SLA compliance report',
    nav: 'Reports',
    body: `${repHead('SLA compliance', "Response and resolution against each customer's terms")}<div class="grid g3">${stat('Responded in time', '94%', '+3 pts')}${stat('Resolved in time', '88%', '-1 pt', 'down')}${stat('Breaches this month', '7', '3 still open', 'down')}</div>
    ${table(
      [
        { label: 'Customer' },
        { label: 'Terms', cls: 'hide-sm' },
        { label: 'Response', cls: 'right' },
        { label: 'Resolution', cls: 'right' },
        { label: 'Status' },
      ],
      [
        ['Crestline Dental Group', '4 h response', '98%', '92%', 'On track'],
        ['Meridian Office Tower', '2 h response', '86%', '79%', 'Off track'],
        ['Ridgeway Logistics Park', '8 h response', '97%', '90%', 'On track'],
        ['Larkspur Hotel', '4 h response', '91%', '84%', 'At risk'],
        ['Foxglove Senior Living', '2 h response', '95%', '93%', 'On track'],
      ].map(([c, t, r, s, st]) => [
        c,
        `<span class="muted">${t}</span>`,
        `<span class="num">${r}</span>`,
        `<span class="num">${s}</span>`,
        status(st),
      ]),
    )}`,
  })
}

function customReport() {
  return app({
    title: 'Custom report',
    nav: 'Reports',
    body: `${repHead('Custom report', 'Untitled report')}<div class="grid g-side"><section class="card card-b stack">${field('Data', 'Work orders', { kind: 'select' })}${field('Group by', 'Customer', { kind: 'select' })}${field('Measure', 'Sum of job value', { kind: 'select' })}${field('Filter', 'Completed, last 90 days', { kind: 'select' })}<div class="field"><label>Chart</label><div class="segmented"><span class="on">Bars</span><span>Line</span><span>Table</span></div></div>${btn('Save report', { kind: 'primary' })}</section>
    ${card({ title: 'Job value by customer, last 90 days', body: barChart([84, 66, 51, 47, 39, 28, 22, 17], { labels: ['Ridgeway', 'Meridian', 'Harborview', 'Larkspur', 'Library', 'Foxglove', 'Crestline', 'Other'] }) })}</div>`,
  })
}

function exportPage() {
  return app({
    title: 'Export data',
    nav: 'Reports',
    body: `${repHead('Exports', 'Download your data as CSV or a spreadsheet')}${table(
      [
        { label: 'Export' },
        { label: 'Rows', cls: 'right hide-sm' },
        { label: 'Requested', cls: 'hide-sm' },
        { label: 'Status' },
        { label: '' },
      ],
      [
        ['Work orders, 2026', '6,214', 'Robin Ash, today', 'Completed'],
        ['Invoices, Q3', '1,882', 'Sam Ortiz, Nov 2', 'Completed'],
        ['Timesheets, October', '3,410', 'Jo Park, Nov 1', 'Completed'],
        ['Customers and sites', '--', 'Robin Ash, now', 'In progress'],
      ].map(([n, r, w, s]) => [
        `<strong>${n}</strong>`,
        r,
        w,
        status(s),
        s === 'Completed' ? btn('Download', { size: 'sm', ic: 'download' }) : '',
      ]),
    )}`,
  })
}

// ---- Plan & billing (Northgate's own Brackwell subscription) ----
const pbTabs = (active) =>
  tabs(
    [
      ['Plan', '/app/billing/'],
      ['Usage', '/app/billing/usage/'],
      ['Payment method', '/app/billing/payment/'],
      ['Billing history', '/app/billing/history/'],
    ],
    active,
  )
const pbHead = (active) =>
  `${pageHead({ title: 'Plan & billing', sub: 'Brackwell Growth · 12 technician seats · renews Dec 1' })}${pbTabs(active)}`

function plan(ctx) {
  return app({
    title: 'Plan & billing',
    nav: 'Plan & billing',
    body: `${pbHead('Plan')}<div class="grid g-main">${card({ title: 'Growth plan', actions: badge('Current', 'green'), body: `<div class="row between wrap"><div><div class="stat value" style="padding:0">${money(ctx.prod ? 708 : 780)}<span class="muted" style="font-size:14px;font-weight:500"> / month</span></div><div class="muted small">12 technicians x ${money(ctx.prod ? 59 : 65)}. Office seats are free.</div></div>${btn('Change plan', { kind: 'primary', href: '/app/billing/change/' })}</div><div class="mt"><div class="row between small"><span>Technician seats</span><span class="num">12 of 15</span></div><div class="progress mt-s"><i style="width:80%"></i></div></div>` })}
    ${card({ title: 'Next invoice', body: `<dl class="kv"><dt>Date</dt><dd>Dec 1</dd><dt>Amount</dt><dd>${money(ctx.prod ? 708 : 780)}</dd><dt>Card</dt><dd>Ending 4412</dd></dl>` })}</div>`,
  })
}

function changePlan(ctx) {
  const overlay = `<div class="scrim"><div class="modal wide" role="dialog" aria-label="Change plan"><div class="card-h"><h2>Change plan</h2>${btn('', { kind: 'ghost', ic: 'x' })}</div><div class="card-b grid g3">${[
    ['Starter', ctx.prod ? 29 : 35, 'Up to 5 technicians'],
    ['Growth', ctx.prod ? 59 : 65, 'Unlimited technicians, routes, inventory'],
    ['Enterprise', null, 'SSO, custom roles, audit export'],
  ]
    .map(
      ([n, p, d], i) =>
        `<div class="radio-card ${i === 2 ? 'on' : ''}" style="flex-direction:column"><strong>${n}</strong><span class="muted small">${d}</span><span style="font-size:20px;font-weight:800">${p ? `${money(p)}<span class="muted small"> / tech</span>` : 'Custom'}</span>${i === 1 ? badge('Current', 'green') : ''}</div>`,
    )
    .join(
      '',
    )}</div><div class="card-b" style="padding-top:0"><div class="alert info">${icon('circle-question-mark')}<div>Enterprise is priced per company. We will reply within one business day.</div></div></div><div class="card-f">${btn('Cancel', { kind: 'ghost' })}${btn('Contact sales', { kind: 'primary' })}</div></div></div>`
  return app({ title: 'Change plan', nav: 'Plan & billing', body: pbHead('Plan'), overlay })
}

function usage() {
  return app({
    title: 'Usage',
    nav: 'Plan & billing',
    body: `${pbHead('Usage')}<div class="grid g3">${stat('Technician seats', '12 of 15')}${stat('Text messages', '1,840', 'of 3,000 included')}${stat('Storage', '38 GB', 'of 100 GB')}</div>${card({ title: 'Text messages per day', body: barChart([48, 62, 55, 71, 66, 30, 12, 58, 64, 70, 69, 74, 28, 10], { height: 170, color: '#0f766e' }) })}`,
  })
}

function paymentMethod() {
  return app({
    title: 'Payment method',
    nav: 'Plan & billing',
    body: `${pbHead('Payment method')}<div class="grid g2">${card({ title: 'Card on file', body: `<div class="row"><span class="badge plain" style="height:32px;padding:0 10px">${icon('credit-card')}VISA</span><div class="grow"><strong>Ending 4412</strong><div class="muted small">Expires 08/28 · Robin Ash</div></div>${btn('Replace', { size: 'sm' })}</div>` })}${card({ title: 'Billing contact', body: `${field('Email for receipts', 'billing@northgate.example')}<div class="mt">${field('Company tax ID', 'Not set', { help: 'Shown on your receipts' })}</div>` })}</div>`,
  })
}

function billingHistory() {
  return app({
    title: 'Billing history',
    nav: 'Plan & billing',
    body: `${pbHead('Billing history')}${table(
      [{ label: 'Date' }, { label: 'Description' }, { label: 'Amount', cls: 'right' }, { label: 'Status' }, { label: '' }],
      ['Nov 1', 'Oct 1', 'Sep 1', 'Aug 1', 'Jul 1'].map((d, i) => [
        d,
        `Growth plan, ${12 - (i > 2 ? 2 : 0)} seats`,
        `<span class="num">${money(i > 2 ? 650 : 780)}</span>`,
        status('Paid'),
        btn('Receipt', { size: 'sm', ic: 'download' }),
      ]),
    )}`,
  })
}

export const pages = [
  { id: 'invoices', path: '/app/invoices/', title: 'Invoices', group: B, render: invoices },
  { id: 'invoices-overdue', path: '/app/invoices/overdue/', title: 'Invoices: overdue', group: B, render: overdue },
  { id: 'invoice-new', path: '/app/invoices/new/', title: 'New invoice', group: B, render: invoiceNew },
  { id: 'invoice-sent', path: '/app/invoices/sent/', title: 'Invoice sent', group: B, note: 'Toast shown', render: invoiceSent },
  { id: 'invoice', path: '/app/invoices/inv-20616/', title: 'Invoice', group: B, render: invoiceDetail },
  { id: 'estimates', path: '/app/invoices/estimates/', title: 'Estimates', group: B, render: estimates },
  { id: 'estimate', path: '/app/invoices/estimates/est-313/', title: 'Estimate', group: B, render: estimate },
  { id: 'payments', path: '/app/invoices/payments/', title: 'Payments', group: B, render: payments },
  { id: 'price-book', path: '/app/invoices/price-book/', title: 'Price book', group: B, render: priceBook },
  { id: 'reports', path: '/app/reports/', title: 'Reports', group: R, render: reports },
  { id: 'report-revenue', path: '/app/reports/revenue/', title: 'Revenue report', group: R, render: revenue },
  { id: 'report-utilization', path: '/app/reports/utilization/', title: 'Utilization report', group: R, render: utilization },
  { id: 'report-first-fix', path: '/app/reports/first-time-fix/', title: 'First-time fix report', group: R, render: firstFix },
  { id: 'report-sla', path: '/app/reports/sla/', title: 'SLA compliance report', group: R, render: sla },
  { id: 'report-custom', path: '/app/reports/custom/', title: 'Custom report', group: R, render: customReport },
  { id: 'report-export', path: '/app/reports/export/', title: 'Exports', group: R, render: exportPage },
  { id: 'plan', path: '/app/billing/', title: 'Plan', group: PB, render: plan },
  { id: 'plan-change', path: '/app/billing/change/', title: 'Change plan', group: PB, note: 'Dialog open', render: changePlan },
  { id: 'plan-usage', path: '/app/billing/usage/', title: 'Usage', group: PB, render: usage },
  { id: 'plan-payment', path: '/app/billing/payment/', title: 'Payment method', group: PB, render: paymentMethod },
  { id: 'plan-history', path: '/app/billing/history/', title: 'Billing history', group: PB, render: billingHistory },
]
