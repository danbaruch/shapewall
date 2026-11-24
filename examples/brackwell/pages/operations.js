// The rest of operations: projects, customers and their sites and
// equipment, inventory and purchasing, and the team.
import { CUSTOMERS, PARTS, PROJECTS, PURCHASE_ORDERS, TECHS, WORK_ORDERS } from '../data.js'
import { app } from '../shells.js'
import {
  avatar,
  avatars,
  badge,
  barChart,
  btn,
  card,
  donut,
  emptyState,
  esc,
  field,
  icon,
  legend,
  map,
  money,
  pageHead,
  photo,
  stat,
  status,
  table,
  tabs,
} from '../ui.js'

const P = 'Projects'
const C = 'Customers & sites'
const I = 'Inventory'
const T = 'Team'

// ---- Projects ----
function projects() {
  return app({
    title: 'Projects',
    nav: 'Projects',
    body: `${pageHead({ title: 'Projects', sub: '6 active · $505,000 under contract', acts: btn('New project', { kind: 'primary', ic: 'plus', href: '/app/projects/new/' }) })}
    <div class="grid g3" data-testid="project-cards">${PROJECTS.map(
      (p) =>
        `<a class="card card-b stack" href="/app/projects/meridian-chiller/" style="color:inherit"><div class="row between">${status(p.state)}<span class="muted small">Due ${p.due}</span></div><div><strong style="font-size:15px">${esc(p.name)}</strong><div class="muted small">${esc(p.customer)}</div></div><div class="progress ${p.state === 'Off track' ? '' : 'green'}"><i style="width:${p.pct}%"></i></div><div class="row between small"><span>${p.pct}% done</span><span class="muted num">${money(p.spent)} of ${money(p.budget)}</span></div><div class="row">${avatars([p.lead, ...TECHS.slice(0, 2).map((t) => t.name)])}<span class="muted small">Lead: ${esc(p.lead)}</span></div></a>`,
    ).join('')}</div>`,
  })
}

const PROJ = PROJECTS[0]
const projHead = (active) =>
  `${pageHead({
    title: PROJ.name,
    sub: `${esc(PROJ.customer)} · ${status(PROJ.state)} · due ${PROJ.due}`,
    crumbs: [
      ['Projects', '/app/projects/'],
      ['Meridian chiller retrofit', null],
    ],
    acts: `${btn('Share', { ic: 'users' })}${btn('Add task', { kind: 'primary', ic: 'plus' })}`,
  })}${tabs(
    [
      ['Overview', '/app/projects/meridian-chiller/'],
      ['Tasks', '/app/projects/meridian-chiller/tasks/', 24],
      ['Timeline', '/app/projects/meridian-chiller/timeline/'],
      ['Budget', '/app/projects/meridian-chiller/budget/'],
      ['Files', '/app/projects/meridian-chiller/files/', 18],
    ],
    active,
  )}`

function projOverview() {
  return app({
    title: 'Project overview',
    nav: 'Projects',
    body: `${projHead('Overview')}<div class="grid g4">${stat('Progress', '64%', 'On plan')}${stat('Budget used', '60%', money(109400))}${stat('Open tasks', '9')}${stat('Change orders', '2', '+$8,400', 'down')}</div>
    <div class="grid g-main">${card({
      title: 'Milestones',
      pad: false,
      body: `<ul class="list">${[
        ['Survey and design', 'Done', 'Oct 2'],
        ['Equipment ordered', 'Done', 'Oct 20'],
        ['Old chiller removed', 'Done', 'Nov 13'],
        ['New chiller set by crane', 'Scheduled', 'Dec 6'],
        ['Startup and balancing', 'Planning', 'Jan 18'],
        ['Handover and training', 'Planning', 'Feb 14'],
      ]
        .map(
          ([t, s, d]) =>
            `<li>${icon(s === 'Done' ? 'circle-check' : 'clock')}<span class="grow">${t}</span><span class="muted small">${d}</span>${s === 'Done' ? badge('Done', 'green') : status(s)}</li>`,
        )
        .join('')}</ul>`,
    })}
    ${card({ title: 'Team', pad: false, body: `<ul class="list">${['Sofia Lindqvist', 'Ravi Deshpande', 'Theo Brandt', 'Jo Park'].map((n, i) => `<li>${avatar(n, 'sm')}<span class="grow">${n}</span><span class="muted small">${['Lead', 'Controls', 'HVAC', 'Project admin'][i]}</span></li>`).join('')}</ul>` })}</div>`,
  })
}

function projTasks() {
  const groups = [
    ['Crane day', ['Confirm crane permit with city', 'Close street parking, Dec 6', 'Rig and set chiller', 'Connect condenser water']],
    ['Controls', ['Map BACnet points', 'Program sequences', 'Trend logs for 2 weeks']],
  ]
  return app({
    title: 'Project tasks',
    nav: 'Projects',
    body: `${projHead('Tasks')}${groups
      .map(([g, list], gi) =>
        card({
          title: g,
          actions: badge(`${list.length} tasks`, 'plain'),
          pad: false,
          body: `<ul class="list">${list.map((t, i) => `<li><span class="cb ${gi === 0 && i === 0 ? 'on' : ''}"></span><span class="grow">${t}</span><span class="hide-sm">${avatar(TECHS[(i + gi * 3) % TECHS.length].name, 'sm')}</span><span class="muted small">Dec ${2 + i * 2}</span></li>`).join('')}</ul>`,
        }),
      )
      .join('')}`,
  })
}

function projTimeline() {
  const rows = [
    ['Survey and design', 0, 14, '#15803d'],
    ['Equipment lead time', 10, 30, '#15803d'],
    ['Demolition', 36, 10, '#15803d'],
    ['Crane and set', 52, 6, '#ea6a1f'],
    ['Piping and electrical', 56, 18, '#2563eb'],
    ['Controls', 62, 18, '#6d28d9'],
    ['Startup', 78, 8, '#2563eb'],
    ['Handover', 90, 8, '#94a3b8'],
  ]
  return app({
    title: 'Project timeline',
    nav: 'Projects',
    body: `${projHead('Timeline')}<div class="card" style="overflow-x:auto"><div class="gantt" style="min-width:680px"><div class="lbl muted small" style="font-weight:600">Phase</div><div class="trk" style="display:flex">${['Oct', 'Nov', 'Dec', 'Jan', 'Feb'].map((m) => `<span class="muted small" style="flex:1;padding:9px 6px">${m}</span>`).join('')}</div>${rows
      .map(
        ([l, s, w, c]) =>
          `<div class="lbl">${l}</div><div class="trk"><span class="bar" style="left:${s}%;width:${w}%;background:${c}"></span></div>`,
      )
      .join('')}</div></div>`,
  })
}

function projBudget() {
  return app({
    title: 'Project budget',
    nav: 'Projects',
    body: `${projHead('Budget')}<div class="grid g-main">${card({
      title: 'Spend by month',
      body:
        barChart([12, 18, 41, 38], { labels: ['Oct', 'Nov', 'Dec', 'Jan'], second: [14, 20, 36, 40], secondColor: '#e2e8f0' }) +
        legend([
          ['Actual', '#ea6a1f'],
          ['Planned', '#e2e8f0'],
        ]),
    })}
    ${card({
      title: 'By category',
      body: `<div class="row" style="gap:20px">${donut([
        { value: 62, color: '#ea6a1f' },
        { value: 24, color: '#2563eb' },
        { value: 9, color: '#15803d' },
        { value: 5, color: '#94a3b8' },
      ])}${legend([
        ['Equipment', '#ea6a1f'],
        ['Labor', '#2563eb'],
        ['Crane', '#15803d'],
        ['Other', '#94a3b8'],
      ])}</div>`,
    })}</div>
    ${table(
      [
        { label: 'Line' },
        { label: 'Budget', cls: 'right' },
        { label: 'Actual', cls: 'right' },
        { label: 'Variance', cls: 'right hide-sm' },
      ],
      [
        ['Chiller, 300 ton', 118000, 118000],
        ['Labor', 38000, 21900],
        ['Crane and rigging', 9500, 9500],
        ['Controls', 12500, 2400],
        ['Contingency', 4000, 0],
      ].map(([l, b, a]) => [
        l,
        `<span class="num">${money(b)}</span>`,
        `<span class="num">${money(a)}</span>`,
        `<span class="num ${a > b ? 'down' : 'up'}">${money(b - a)}</span>`,
      ]),
    )}`,
  })
}

function projFiles() {
  return app({
    title: 'Project files',
    nav: 'Projects',
    body: `${projHead('Files')}${table(
      [{ label: 'Name' }, { label: 'Added by', cls: 'hide-sm' }, { label: 'Size', cls: 'hide-sm' }, { label: 'Date' }],
      [
        ['Chiller submittal.pdf', 'Sofia Lindqvist', '4.2 MB', 'Oct 9'],
        ['Crane lift plan.pdf', 'Jo Park', '1.1 MB', 'Nov 20'],
        ['Mechanical room photos', 'Theo Brandt', '38 photos', 'Nov 13'],
        ['Controls points list.xlsx', 'Ravi Deshpande', '220 KB', 'Nov 18'],
        ['Change order 2.pdf', 'Robin Ash', '180 KB', 'Nov 19'],
      ].map(([n, by, s, d]) => [
        `<span class="row">${icon(n.includes('photos') ? 'image' : 'file-text')}<strong>${n}</strong></span>`,
        by,
        s,
        d,
      ]),
    )}`,
  })
}

function projNew() {
  return app({
    title: 'New project',
    nav: 'Projects',
    body: `${pageHead({
      title: 'New project',
      crumbs: [
        ['Projects', '/app/projects/'],
        ['New', null],
      ],
    })}<form class="card card-b stack" style="max-width:720px" action="/app/projects/meridian-chiller/" method="post">${field('Project name', '', { placeholder: 'e.g. Tower B boiler replacement' })}<div class="grid g2">${field('Customer', '', { kind: 'select', placeholder: 'Pick a customer' })}${field('Project lead', 'Sofia Lindqvist', { kind: 'select' })}</div><div class="grid g2">${field('Start', 'Dec 1', { kind: 'select' })}${field('Target finish', '', { kind: 'select', placeholder: 'Pick a date' })}</div>${field('Budget', '', { placeholder: '$0' })}<div class="field"><label>Start from</label><div class="grid g3">${['Blank', 'Equipment replacement', 'Lighting retrofit'].map((t, i) => `<div class="radio-card ${i === 1 ? 'on' : ''}"><div><strong>${t}</strong><div class="muted small">${['No tasks', '6 phases, 24 tasks', '4 phases, 15 tasks'][i]}</div></div></div>`).join('')}</div></div><div class="row" style="justify-content:flex-end">${btn('Cancel', { kind: 'ghost', href: '/app/projects/' })}<button class="btn primary" type="submit">Create project</button></div></form>`,
  })
}

function projEmpty() {
  return app({
    title: 'Projects: none yet',
    nav: 'Projects',
    body: `${pageHead({ title: 'Projects' })}${card({ body: emptyState({ title: 'Plan bigger jobs as projects', text: 'Projects group tasks, crews, budget and files for installs and retrofits that take weeks.', acts: btn('New project', { kind: 'primary', ic: 'plus', href: '/app/projects/new/' }), art: 'folder-kanban' }) })}`,
  })
}

// ---- Customers & sites ----
function customers() {
  return app({
    title: 'Customers',
    nav: 'Customers',
    body: `${pageHead({ title: 'Customers', sub: '12 customers · 39 sites', acts: `${btn('Import', { ic: 'upload' })}${btn('New customer', { kind: 'primary', ic: 'plus', href: '/app/customers/new/' })}` })}<div class="toolbar"><div class="search-in">${icon('search')}Search customers</div><span class="chip">${icon('funnel')}Type</span></div>
    ${table(
      [
        { label: 'Customer' },
        { label: 'Type', cls: 'hide-sm' },
        { label: 'Sites', cls: 'hide-sm' },
        { label: 'Open jobs' },
        { label: 'Lifetime value', cls: 'right hide-sm' },
      ],
      CUSTOMERS.map((c) => [
        `<a href="/app/customers/crestline/" class="row" style="color:var(--ink)">${avatar(c.name, 'sm')}<strong>${esc(c.name)}</strong></a>`,
        badge(c.type, 'plain'),
        c.sites,
        c.open ? badge(`${c.open} open`, 'blue') : '<span class="faint">None</span>',
        `<span class="num">${money(c.value)}</span>`,
      ]),
      { pager: '12 customers' },
    )}`,
  })
}

const custHead = (active, ctx) =>
  `${pageHead({
    title: 'Crestline Dental Group',
    sub: 'Healthcare · Customer since 2021 · Amara Bell, office manager',
    crumbs: [
      ['Customers', '/app/customers/'],
      ['Crestline Dental Group', null],
    ],
    acts: `${btn('Edit', { ic: 'pen-line', href: '/app/customers/crestline/edit/' })}${btn('New job', { kind: 'primary', ic: 'plus', href: '/app/work-orders/new/' })}`,
  })}${tabs(
    [
      ['Overview', '/app/customers/crestline/'],
      ['Sites', '/app/customers/crestline/sites/', 4],
      ['Work orders', '/app/work-orders/', ctx?.round >= 3 ? 3 : undefined],
      ['Equipment', '/app/customers/crestline/equipment/', 11],
      ['Contacts', '/app/customers/crestline/contacts/', 5],
    ],
    active,
  )}`

function customer(ctx) {
  return app({
    title: 'Customer',
    nav: 'Customers',
    body: `${custHead('Overview', ctx)}<div class="grid g4">${stat('Lifetime value', money(48200))}${stat('Open jobs', '3')}${stat('Avg response', '2 h 40 m', 'Within SLA')}${stat('Balance', money(1284.5, true), 'Due Dec 4', 'down')}</div>
    <div class="grid g-main">${card({
      title: 'Recent work',
      pad: false,
      body: `<ul class="list">${WORK_ORDERS.slice(0, 5)
        .map(
          (j) =>
            `<li><span class="mono muted">${j.id}</span><span class="grow">${esc(j.title)}</span><span class="muted small hide-sm">${j.due}</span>${status(j.state)}</li>`,
        )
        .join('')}</ul>`,
    })}
    ${card({ title: 'Service agreement', body: `<dl class="kv"><dt>Plan</dt><dd>Gold, quarterly PM</dd><dt>Response</dt><dd>4 hours</dd><dt>Renews</dt><dd>Mar 1</dd><dt>Billing</dt><dd>Net 15, by email</dd></dl>` })}</div>`,
  })
}

function customerEdit() {
  return app({
    title: 'Edit customer',
    nav: 'Customers',
    body: `${pageHead({
      title: 'Edit Crestline Dental Group',
      crumbs: [
        ['Customers', '/app/customers/'],
        ['Crestline Dental Group', '/app/customers/crestline/'],
        ['Edit', null],
      ],
    })}<form class="card card-b stack" style="max-width:760px" action="/app/customers/crestline/" method="post">${field('Name', 'Crestline Dental Group')}<div class="grid g2">${field('Type', 'Healthcare', { kind: 'select' })}${field('Payment terms', 'Net 15', { kind: 'select' })}</div><div class="grid g2">${field('Billing email', 'billing@crestline.example')}${field('Phone', '(555) 013-8820')}</div>${field('Billing address', '1180 Beacon Way, Port Alder')}${field('Notes', 'Prefers morning visits. Patients present: quiet tools after 9.', { kind: 'textarea' })}<div class="row" style="justify-content:flex-end">${btn('Cancel', { kind: 'ghost', href: '/app/customers/crestline/' })}<button class="btn primary" type="submit">Save customer</button></div></form>`,
  })
}

function customerNew() {
  return app({
    title: 'New customer',
    nav: 'Customers',
    body: `${pageHead({
      title: 'New customer',
      crumbs: [
        ['Customers', '/app/customers/'],
        ['New', null],
      ],
    })}<form class="card card-b stack" style="max-width:760px" action="/app/customers/crestline/" method="post">${field('Name', '', { placeholder: 'Company or person' })}<div class="grid g2">${field('Type', '', { kind: 'select', placeholder: 'Pick a type' })}${field('Payment terms', 'Net 30', { kind: 'select' })}</div>${field('Email', 'amara@', { state: 'err', help: 'Enter a full email address, like name@company.example' })}${field('First site address', '', { placeholder: 'Street, city' })}<div class="row" style="justify-content:flex-end">${btn('Cancel', { kind: 'ghost', href: '/app/customers/' })}<button class="btn primary" type="submit">Create customer</button></div></form>`,
  })
}

function sites(ctx) {
  return app({
    title: 'Customer sites',
    nav: 'Customers',
    body: `${custHead('Sites', ctx)}<div class="grid g-main">${map({
      height: 420,
      pins: [
        { x: 30, y: 40, label: '1' },
        { x: 58, y: 30, label: '2' },
        { x: 70, y: 70, label: '3' },
        { x: 20, y: 72, label: '4' },
      ],
    })}
    ${card({ title: '4 sites', pad: false, body: `<ul class="list">${['North office', 'Harbor clinic', 'Signal Hill', 'Lab and storage'].map((s, i) => `<li><span class="badge brand plain">${i + 1}</span><div class="grow"><a href="/app/customers/crestline/sites/north/"><strong>${s}</strong></a><div class="muted small">${[1180, 42, 907, 2210][i]} ${['Beacon Way', 'Wharf St', 'Signal Hill Dr', 'Kiln St'][i]}</div></div><span class="muted small">${[4, 2, 3, 2][i]} units</span></li>`).join('')}</ul>` })}</div>`,
  })
}

function site() {
  return app({
    title: 'Site',
    nav: 'Customers',
    body: `${pageHead({
      title: 'North office',
      sub: '1180 Beacon Way, Port Alder · Crestline Dental Group',
      crumbs: [
        ['Customers', '/app/customers/'],
        ['Crestline Dental Group', '/app/customers/crestline/'],
        ['North office', null],
      ],
      acts: btn('New job here', { kind: 'primary', ic: 'plus' }),
    })}
    <div class="grid g-main"><div class="stack">${card({ title: 'Access', body: '<dl class="kv"><dt>Hours</dt><dd>Mon to Fri, 7:00 to 18:00</dd><dt>Entry</dt><dd>Gate code at reception</dd><dt>Roof</dt><dd>East stairwell, key in lockbox 3</dd><dt>Parking</dt><dd>Two spaces behind the building</dd></dl>' })}${card({ title: 'Equipment at this site', pad: false, body: `<ul class="list">${['RTU-1, 5 ton', 'RTU-2, 7.5 ton', 'Water heater, 50 gal', 'Compressor, dental air'].map((e, i) => `<li>${icon(['fan', 'fan', 'droplets', 'gauge'][i])}<a class="grow" href="/app/customers/crestline/equipment/rtu-2/">${e}</a>${i === 1 ? badge('Open job', 'amber') : badge('OK', 'green')}</li>`).join('')}</ul>` })}</div>
    <div class="stack">${map({ height: 220, pins: [{ x: 50, y: 55, label: '' }] })}${card({ title: 'Photos', body: `<div class="grid g2">${photo(0)}${photo(2)}</div>` })}</div></div>`,
  })
}

function equipment(ctx) {
  return app({
    title: 'Equipment',
    nav: 'Customers',
    body: `${custHead('Equipment', ctx)}${table(
      [
        { label: 'Unit' },
        { label: 'Site', cls: 'hide-sm' },
        { label: 'Make and model', cls: 'hide-sm' },
        { label: 'Installed', cls: 'hide-sm' },
        { label: 'Next PM' },
      ],
      [
        ['RTU-1, 5 ton', 'North office', 'Aerovane AV-60', '2017', 'Dec 2'],
        ['RTU-2, 7.5 ton', 'North office', 'Aerovane AV-90', '2017', 'Dec 2'],
        ['Split system', 'Harbor clinic', 'Coolridge CS-24', '2020', 'Jan 14'],
        ['Water heater, 50 gal', 'North office', 'Thermabrook 50G', '2019', 'Mar 3'],
        ['Dental air compressor', 'North office', 'Puremed DA-2', '2021', 'Dec 18'],
        ['Walk-in cooler', 'Lab and storage', 'Polarstone WC-8', '2016', 'Dec 9'],
      ].map(([u, s, m, y, pm]) => [
        `<a href="/app/customers/crestline/equipment/rtu-2/"><strong>${u}</strong></a>`,
        s,
        `<span class="muted">${m}</span>`,
        y,
        pm,
      ]),
    )}`,
  })
}

function equipmentDetail() {
  return app({
    title: 'Equipment detail',
    nav: 'Customers',
    body: `${pageHead({
      title: 'RTU-2, 7.5 ton',
      sub: 'Aerovane AV-90 · Serial AV9-17-44821 · North office',
      crumbs: [
        ['Customers', '/app/customers/'],
        ['Crestline Dental Group', '/app/customers/crestline/'],
        ['RTU-2', null],
      ],
      acts: btn('Schedule PM', { kind: 'primary', ic: 'calendar-clock' }),
    })}
    <div class="grid g-main">${card({
      title: 'Service history',
      body: `<ul class="timeline">${[
        ['wrench', 'Repair: capacitor and contactor', 'Today, Dana Whitlock'],
        ['circle-check', 'PM: filters, belts, coil check', 'Aug 14, Theo Brandt'],
        ['circle-check', 'PM: filters, refrigerant check', 'May 2, Theo Brandt'],
        ['wrench', 'Repair: condenser fan motor', 'Feb 19, Sofia Lindqvist'],
      ]
        .map(
          ([ic, t, s]) =>
            `<li><span class="dot">${icon(ic)}</span><div><strong>${t}</strong><div class="muted small">${s}</div></div></li>`,
        )
        .join('')}</ul>`,
    })}
    <div class="stack">${card({ title: 'Specs', body: '<dl class="kv"><dt>Refrigerant</dt><dd>R-410A, 14.2 lb</dd><dt>Voltage</dt><dd>208/230 V, 3 phase</dd><dt>Filters</dt><dd>4 x 20x25x2</dd><dt>Warranty</dt><dd>Expired 2022</dd></dl>' })}${photo(3)}</div></div>`,
  })
}

function contacts(ctx) {
  return app({
    title: 'Customer contacts',
    nav: 'Customers',
    body: `${custHead('Contacts', ctx)}<div class="grid g3">${[
      ['Amara Bell', 'Office manager', 'Primary, approves estimates'],
      ['Dr. Leo Hart', 'Owner', 'Signs agreements'],
      ['Nina Cole', 'Front desk, Harbor clinic', 'Lets technicians in'],
      ['Paul Ibsen', 'Accounts payable', 'Gets invoices'],
      ['Vera Stone', 'Front desk, North office', 'Lets technicians in'],
    ]
      .map(
        ([n, r, note]) =>
          `<section class="card card-b stack tight"><div class="row">${avatar(n)}<div><strong>${n}</strong><div class="muted small">${r}</div></div></div><p class="muted small">${note}</p><div class="row">${btn('', { ic: 'phone', size: 'sm' })}${btn('', { ic: 'mail', size: 'sm' })}</div></section>`,
      )
      .join('')}</div>`,
  })
}

// ---- Inventory ----
const invTabs = (active) =>
  tabs(
    [
      ['Parts', '/app/inventory/'],
      ['Low stock', '/app/inventory/low-stock/', 4],
      ['Purchase orders', '/app/inventory/purchase-orders/', 6],
      ['Warehouses', '/app/inventory/warehouses/', 3],
    ],
    active,
  )
const invHead = (active) =>
  `${pageHead({ title: 'Inventory', sub: '14 parts · 3 warehouses · 9 vans', acts: `${btn('Count stock', { ic: 'list-checks' })}${btn('New purchase order', { kind: 'primary', ic: 'plus', href: '/app/inventory/purchase-orders/new/' })}` })}${invTabs(active)}`
const partRow = (p) => [
  `<a href="/app/inventory/cap-4505/" style="color:var(--ink)"><strong>${esc(p.name)}</strong></a><div class="muted small mono">${p.sku}</div>`,
  `<span class="muted">${p.cat}</span>`,
  `<span class="num">${p.stock}</span>`,
  `<span class="num muted">${p.min}</span>`,
  `<span class="num">${money(p.cost, true)}</span>`,
  status(p.state),
]
const PART_COLS = [
  { label: 'Part' },
  { label: 'Category', cls: 'hide-sm' },
  { label: 'On hand' },
  { label: 'Reorder at', cls: 'hide-sm' },
  { label: 'Unit cost', cls: 'hide-sm' },
  { label: 'Status' },
]

const inventory = () =>
  app({ title: 'Inventory', nav: 'Inventory', body: `${invHead('Parts')}${table(PART_COLS, PARTS.map(partRow), { pager: '14 parts' })}` })

function lowStock() {
  const low = PARTS.filter((p) => p.state !== 'In stock')
  return app({
    title: 'Inventory: low stock',
    nav: 'Inventory',
    body: `${invHead('Low stock')}<div class="alert warn">${icon('triangle-alert')}<div class="grow"><strong>4 parts are below their reorder point.</strong> 2 jobs this week need them.</div>${btn('Reorder all', { size: 'sm', kind: 'primary' })}</div>${table(PART_COLS, low.map(partRow))}`,
  })
}

function partDetail() {
  const p = PARTS[1]
  return app({
    title: 'Part',
    nav: 'Inventory',
    body: `${pageHead({
      title: p.name,
      sub: `<span class="mono">${p.sku}</span> · ${p.cat} · ${status(p.state)}`,
      crumbs: [
        ['Inventory', '/app/inventory/'],
        [p.sku, null],
      ],
      acts: `${btn('Adjust stock', { ic: 'pen-line' })}${btn('Reorder', { kind: 'primary', ic: 'truck', href: '/app/inventory/purchase-orders/new/' })}`,
    })}
    <div class="grid g4">${stat('On hand', p.stock, 'Reorder at 24', 'down')}${stat('Used, 30 days', '31')}${stat('Unit cost', money(p.cost, true))}${stat('On order', '24', 'PO-1182, Nov 26')}</div>
    <div class="grid g2">${card({
      title: 'Where it is',
      pad: false,
      body: `<ul class="list">${[
        ['Main warehouse', 3],
        ['Van 2, Dana', 2],
        ['Van 4, Theo', 1],
        ['Van 9, Sofia', 1],
      ]
        .map(
          ([w, n]) =>
            `<li>${icon(w.startsWith('Van') ? 'truck' : 'warehouse')}<span class="grow">${w}</span><strong class="num">${n}</strong></li>`,
        )
        .join('')}</ul>`,
    })}${card({ title: 'Used per week', body: barChart([6, 8, 5, 9, 7, 10, 8, 12], { labels: ['', 'Oct', '', '', '', 'Nov', '', ''], height: 160 }) })}</div>`,
  })
}

function purchaseOrders() {
  return app({
    title: 'Purchase orders',
    nav: 'Inventory',
    body: `${invHead('Purchase orders')}${table(
      [
        { label: 'PO' },
        { label: 'Vendor' },
        { label: 'Items', cls: 'hide-sm' },
        { label: 'Total', cls: 'right' },
        { label: 'Status' },
        { label: 'Expected', cls: 'hide-sm' },
      ],
      PURCHASE_ORDERS.map((po) => [
        `<a class="mono" href="/app/inventory/purchase-orders/po-1182/">${po.id}</a>`,
        esc(po.vendor),
        po.items,
        `<span class="num">${money(po.total, true)}</span>`,
        status(po.state),
        po.eta,
      ]),
    )}`,
  })
}

function poDetail() {
  return app({
    title: 'Purchase order',
    nav: 'Inventory',
    body: `${pageHead({
      title: 'PO-1182',
      sub: `Coastline HVAC Supply · ${status('Ordered')} · expected Nov 26`,
      crumbs: [
        ['Inventory', '/app/inventory/'],
        ['Purchase orders', '/app/inventory/purchase-orders/'],
        ['PO-1182', null],
      ],
      acts: `${btn('Download PDF', { ic: 'download' })}${btn('Receive items', { kind: 'primary', ic: 'package' })}`,
    })}
    <div class="grid g-main">${table(
      [{ label: 'Part' }, { label: 'Qty', cls: 'right' }, { label: 'Unit', cls: 'right hide-sm' }, { label: 'Total', cls: 'right' }],
      [
        ['Run capacitor 45/5 MFD', 24, 18.9],
        ['V-belt A42', 20, 11.2],
        ['TXV valve R-410A 3 ton', 4, 142],
        ['Condensate pump 24 V', 6, 96],
        ['Pleated filter 20x25x2', 60, 8.4],
        ['ECM blower motor 1/2 HP', 1, 386],
      ].map(([n, q, u]) => [n, q, `<span class="num">${money(u, true)}</span>`, `<span class="num">${money(q * u, true)}</span>`]),
    )}${card({ title: 'Approval', body: `<ul class="timeline"><li><span class="dot">${avatar('Mei Lin', 'sm')}</span><div><strong>Created by Mei Lin</strong><div class="muted small">Nov 19</div></div></li><li><span class="dot">${avatar('Robin Ash', 'sm')}</span><div><strong>Approved by Robin Ash</strong><div class="muted small">Over $2,000 needs an admin. Nov 20</div></div></li><li><span class="dot">${icon('truck')}</span><div><strong>Sent to vendor</strong><div class="muted small">Nov 20</div></div></li></ul>` })}</div>`,
  })
}

function poNew() {
  return app({
    title: 'New purchase order',
    nav: 'Inventory',
    body: `${pageHead({
      title: 'New purchase order',
      crumbs: [
        ['Inventory', '/app/inventory/'],
        ['New purchase order', null],
      ],
    })}<form class="card card-b stack" action="/app/inventory/purchase-orders/po-1182/" method="post"><div class="grid g3">${field('Vendor', 'Coastline HVAC Supply', { kind: 'select' })}${field('Deliver to', 'Main warehouse', { kind: 'select' })}${field('Needed by', 'Nov 26', { kind: 'select' })}</div>
    <table class="t"><thead><tr><th>Part</th><th class="right">Qty</th><th class="right hide-sm">Unit</th><th class="right">Total</th></tr></thead><tbody>${[
      ['Run capacitor 45/5 MFD', 24, 18.9],
      ['T8 ballast, 4 lamp', 10, 34.5],
      ['V-belt A42', 20, 11.2],
    ]
      .map(
        ([n, q, u]) =>
          `<tr><td>${n}</td><td class="right">${q}</td><td class="right num hide-sm">${money(u, true)}</td><td class="right num">${money(q * u, true)}</td></tr>`,
      )
      .join(
        '',
      )}</tbody></table><a class="small row" href="#">${icon('plus')}Add a part</a><div class="alert info">${icon('sparkles')}<div>Suggested from low stock: 3 parts added. Total ${money(1022.6, true)}, under the $2,000 approval limit.</div></div><div class="row" style="justify-content:flex-end">${btn('Save draft', { kind: 'ghost' })}<button class="btn primary" type="submit">Send to vendor</button></div></form>`,
  })
}

function warehouses() {
  return app({
    title: 'Warehouses',
    nav: 'Inventory',
    body: `${invHead('Warehouses')}<div class="grid g3">${[
      ['Main warehouse', '42 Tannery Row', 1284, 92],
      ['Harbor depot', '7 Ferry Rd', 412, 64],
      ['North cage', '310 Kiln St', 188, 38],
    ]
      .map(
        ([n, a, units, pct]) =>
          `<section class="card card-b stack"><div class="row">${icon('warehouse')}<strong>${n}</strong></div><span class="muted small">${a}, Port Alder</span><div class="row between small"><span>${units} units</span><span class="muted">${pct}% full</span></div><div class="progress blue"><i style="width:${pct}%"></i></div></section>`,
      )
      .join('')}</div>${card({
      title: 'Vans',
      pad: false,
      body: `<ul class="list">${TECHS.slice(0, 6)
        .map(
          (t, i) =>
            `<li>${icon('truck')}<span class="grow">Van ${i + 2}, ${esc(t.name)}</span><span class="muted small">${[86, 74, 91, 55, 80, 69][i]} parts</span>${i === 3 ? badge('Restock', 'amber') : badge('OK', 'green')}</li>`,
        )
        .join('')}</ul>`,
    })}`,
  })
}

// ---- Team ----
const teamTabs = (active) =>
  tabs(
    [
      ['Technicians', '/app/team/', 12],
      ['Skills', '/app/team/skills/'],
      ['Timesheets', '/app/team/timesheets/', 3],
      ['Certifications', '/app/team/certifications/'],
    ],
    active,
  )
const teamHead = (active) =>
  `${pageHead({ title: 'Team', sub: '12 technicians in 3 crews', acts: btn('Invite technician', { kind: 'primary', ic: 'user-plus', href: '/app/team/invite/' }) })}${teamTabs(active)}`

function team() {
  return app({
    title: 'Team',
    nav: 'Team',
    body: `${teamHead('Technicians')}${table(
      [
        { label: 'Technician' },
        { label: 'Trade', cls: 'hide-sm' },
        { label: 'Crew', cls: 'hide-sm' },
        { label: 'Now' },
        { label: 'Utilization', cls: 'hide-sm' },
        { label: 'Rating', cls: 'hide-sm' },
      ],
      TECHS.map((t) => [
        `<a href="/app/team/dana-whitlock/" class="row" style="color:var(--ink)">${avatar(t.name, 'sm')}<strong>${esc(t.name)}</strong></a>`,
        t.trade,
        t.crew,
        status(t.state),
        `<div class="row" style="min-width:120px"><div class="progress grow"><i style="width:${t.util}%"></i></div><span class="num small">${t.util}%</span></div>`,
        `<span class="row small">${icon('star')}${t.rating}</span>`,
      ]),
    )}`,
  })
}

function techProfile() {
  const t = TECHS[0]
  return app({
    title: 'Technician profile',
    nav: 'Team',
    body: `${pageHead({
      title: t.name,
      sub: `${t.trade} · ${t.crew} · with Northgate since 2019`,
      crumbs: [
        ['Team', '/app/team/'],
        [t.name, null],
      ],
      acts: `${btn('Message', { ic: 'message-square' })}${btn('Edit', { kind: 'primary', ic: 'pen-line' })}`,
    })}
    <div class="grid g-side"><section class="card card-b stack" style="align-items:center;text-align:center">${avatar(t.name, 'lg')}<strong>${t.name}</strong>${status(t.state)}<div class="muted small">dana@northgate.example<br />(555) 014-7731</div></section>
    <div class="stack"><div class="grid g4">${stat('Jobs, 30 days', '96')}${stat('First-time fix', '93%')}${stat('Utilization', `${t.util}%`)}${stat('Rating', t.rating)}</div>${card({ title: 'Skills', body: `<div class="row wrap">${['HVAC repair', 'Rooftop units', 'Refrigerant (certified)', 'Boilers', 'Controls basics'].map((s) => badge(s, 'plain')).join('')}</div>` })}${card(
      {
        title: 'Recent jobs',
        pad: false,
        body: `<ul class="list">${WORK_ORDERS.slice(0, 4)
          .map((j) => `<li><span class="mono muted">${j.id}</span><span class="grow">${esc(j.title)}</span>${status(j.state)}</li>`)
          .join('')}</ul>`,
      },
    )}</div></div>`,
  })
}

function skills() {
  const skillsList = ['HVAC', 'Electrical', 'Plumbing', 'Refrigeration', 'Controls', 'Fire safety']
  return app({
    title: 'Skills matrix',
    nav: 'Team',
    body: `${teamHead('Skills')}<div class="card" style="overflow-x:auto"><table class="t matrix"><thead><tr><th>Technician</th>${skillsList.map((s) => `<th>${s}</th>`).join('')}</tr></thead><tbody>${TECHS.slice(
      0,
      10,
    )
      .map(
        (t, r) =>
          `<tr><td class="strong">${esc(t.name)}</td>${skillsList.map((s, c) => `<td><span class="dot-lvl ${s === t.trade ? 'l3' : (r + c) % 4 === 0 ? 'l2' : (r * c) % 3 === 1 ? 'l1' : ''}"></span></td>`).join('')}</tr>`,
      )
      .join('')}</tbody></table></div>${legend([
      ['Expert', '#ea6a1f'],
      ['Can lead', '#f8b48a'],
      ['Learning', '#fde4d2'],
    ])}`,
  })
}

function timesheets() {
  return app({
    title: 'Timesheets',
    nav: 'Team',
    body: `${teamHead('Timesheets')}<div class="toolbar"><span class="chip on">Week of Nov 16</span><span class="grow"></span>${btn('Approve 3', { kind: 'primary', ic: 'check' })}</div>${table(
      [
        { label: 'Technician' },
        { label: 'Regular', cls: 'right' },
        { label: 'Overtime', cls: 'right hide-sm' },
        { label: 'Drive', cls: 'right hide-sm' },
        { label: 'Status' },
      ],
      TECHS.slice(0, 8).map((t, i) => [
        `<a class="row" href="/app/team/timesheets/lena-varga/" style="color:var(--ink)">${avatar(t.name, 'sm')}<strong>${esc(t.name)}</strong></a>`,
        `<span class="num">${38 + (i % 3)}.0 h</span>`,
        `<span class="num">${[0, 2.5, 6, 0, 1, 0, 4, 0][i]} h</span>`,
        `<span class="num">${[6, 8, 5, 7, 9, 4, 6, 8][i]}.5 h</span>`,
        status(['Approved', 'Submitted', 'Submitted', 'Approved', 'Submitted', 'Approved', 'Rejected', 'Approved'][i]),
      ]),
      { select: true, selected: [1, 2, 4] },
    )}`,
  })
}

function timesheetDetail() {
  return app({
    title: 'Timesheet',
    nav: 'Team',
    body: `${pageHead({
      title: 'Lena Varga, week of Nov 16',
      sub: `${status('Submitted')} · 40.0 h regular · 6.0 h overtime`,
      crumbs: [
        ['Team', '/app/team/'],
        ['Timesheets', '/app/team/timesheets/'],
        ['Lena Varga', null],
      ],
      acts: `${btn('Reject', { kind: 'danger' })}${btn('Approve', { kind: 'primary', ic: 'check' })}`,
    })}
    ${table(
      [
        { label: 'Day' },
        { label: 'Jobs', cls: 'hide-sm' },
        { label: 'Clock in' },
        { label: 'Clock out' },
        { label: 'Hours', cls: 'right' },
      ],
      [
        ['Mon 16', 4, '7:02', '16:10', 9.1],
        ['Tue 17', 5, '6:58', '17:45', 10.8],
        ['Wed 18', 3, '7:10', '15:30', 8.3],
        ['Thu 19', 5, '7:00', '18:20', 11.3],
        ['Fri 20', 4, '7:05', '13:50', 6.8],
      ].map(([d, j, a, b, h]) => [d, j, a, b, `<span class="num ${h > 10 ? 'down' : ''}">${h} h</span>`]),
    )}<div class="alert warn">${icon('triangle-alert')}<div>Thursday is over 11 hours. Overtime rules apply after 10 hours a day.</div></div>`,
  })
}

function certifications() {
  return app({
    title: 'Certifications',
    nav: 'Team',
    body: `${teamHead('Certifications')}${table(
      [{ label: 'Technician' }, { label: 'Certification' }, { label: 'Expires', cls: 'hide-sm' }, { label: 'Status' }],
      [
        ['Dana Whitlock', 'Refrigerant handling, universal', 'Never', 'Active'],
        ['Marcus Okafor', 'Journeyman electrician', 'Jan 31', 'Active'],
        ['Priya Raman', 'Fire alarm inspector', 'Dec 8', 'Pending'],
        ['Lena Varga', 'Backflow tester', 'Nov 30', 'Pending'],
        ['Kofi Mensah', 'Lift operator', 'Oct 12', 'Suspended'],
      ].map(([n, c, e, s]) => [
        `<span class="row">${avatar(n, 'sm')}${n}</span>`,
        c,
        e,
        s === 'Pending' ? badge('Expires soon', 'amber') : s === 'Suspended' ? badge('Expired', 'red') : status(s),
      ]),
    )}`,
  })
}

function invite() {
  const overlay = `<div class="scrim"><div class="modal" role="dialog" aria-label="Invite technician"><div class="card-h"><h2>Invite a technician</h2>${btn('', { kind: 'ghost', ic: 'x' })}</div><div class="card-b stack">${field('Name', 'Jamie Ruiz')}${field('Mobile number', '(555) 014-5562', { help: 'We text a link to install the app and sign in.' })}<div class="grid g2">${field('Trade', 'Plumbing', { kind: 'select' })}${field('Crew', 'River crew', { kind: 'select' })}</div></div><div class="card-f">${btn('Cancel', { kind: 'ghost' })}${btn('Send invite', { kind: 'primary', ic: 'send' })}</div></div></div>`
  return app({
    title: 'Invite technician',
    nav: 'Team',
    body:
      teamHead('Technicians') +
      table(
        [{ label: 'Technician' }],
        TECHS.slice(0, 5).map((t) => [esc(t.name)]),
      ),
    overlay,
  })
}

export const pages = [
  { id: 'projects', path: '/app/projects/', title: 'Projects', group: P, render: projects },
  { id: 'projects-empty', path: '/app/projects/empty/', title: 'Projects: none yet', group: P, note: 'Empty state', render: projEmpty },
  { id: 'project-new', path: '/app/projects/new/', title: 'New project', group: P, render: projNew },
  { id: 'project', path: '/app/projects/meridian-chiller/', title: 'Project overview', group: P, render: projOverview },
  { id: 'project-tasks', path: '/app/projects/meridian-chiller/tasks/', title: 'Project tasks', group: P, render: projTasks },
  { id: 'project-timeline', path: '/app/projects/meridian-chiller/timeline/', title: 'Project timeline', group: P, render: projTimeline },
  { id: 'project-budget', path: '/app/projects/meridian-chiller/budget/', title: 'Project budget', group: P, render: projBudget },
  { id: 'project-files', path: '/app/projects/meridian-chiller/files/', title: 'Project files', group: P, render: projFiles },
  { id: 'customers-list', path: '/app/customers/', title: 'Customers', group: C, render: customers },
  { id: 'customer', path: '/app/customers/crestline/', title: 'Customer', group: C, render: customer },
  { id: 'customer-edit', path: '/app/customers/crestline/edit/', title: 'Edit customer', group: C, render: customerEdit },
  { id: 'customer-new', path: '/app/customers/new/', title: 'New customer', group: C, note: 'Validation error', render: customerNew },
  { id: 'sites', path: '/app/customers/crestline/sites/', title: 'Customer sites', group: C, render: sites },
  { id: 'site', path: '/app/customers/crestline/sites/north/', title: 'Site', group: C, render: site },
  { id: 'equipment', path: '/app/customers/crestline/equipment/', title: 'Equipment', group: C, render: equipment },
  {
    id: 'equipment-detail',
    path: '/app/customers/crestline/equipment/rtu-2/',
    title: 'Equipment detail',
    group: C,
    render: equipmentDetail,
  },
  { id: 'contacts', path: '/app/customers/crestline/contacts/', title: 'Customer contacts', group: C, render: contacts },
  { id: 'inventory', path: '/app/inventory/', title: 'Parts', group: I, render: inventory },
  { id: 'low-stock', path: '/app/inventory/low-stock/', title: 'Low stock', group: I, render: lowStock },
  { id: 'part', path: '/app/inventory/cap-4505/', title: 'Part', group: I, render: partDetail },
  { id: 'purchase-orders', path: '/app/inventory/purchase-orders/', title: 'Purchase orders', group: I, render: purchaseOrders },
  { id: 'po-new', path: '/app/inventory/purchase-orders/new/', title: 'New purchase order', group: I, render: poNew },
  { id: 'po', path: '/app/inventory/purchase-orders/po-1182/', title: 'Purchase order', group: I, render: poDetail },
  { id: 'warehouses', path: '/app/inventory/warehouses/', title: 'Warehouses and vans', group: I, render: warehouses },
  { id: 'team', path: '/app/team/', title: 'Technicians', group: T, render: team },
  { id: 'tech-profile', path: '/app/team/dana-whitlock/', title: 'Technician profile', group: T, render: techProfile },
  { id: 'skills', path: '/app/team/skills/', title: 'Skills matrix', group: T, render: skills },
  { id: 'timesheets', path: '/app/team/timesheets/', title: 'Timesheets', group: T, render: timesheets },
  { id: 'timesheet', path: '/app/team/timesheets/lena-varga/', title: 'Timesheet', group: T, render: timesheetDetail },
  { id: 'certifications', path: '/app/team/certifications/', title: 'Certifications', group: T, render: certifications },
  { id: 'team-invite', path: '/app/team/invite/', title: 'Invite technician', group: T, note: 'Dialog open', render: invite },
]
