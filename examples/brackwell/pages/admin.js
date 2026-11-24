// Workspace settings: general, people and roles, the audit log,
// integrations and API keys, notifications, branding, custom fields,
// templates, single sign-on, data.
import { MEMBERS } from '../data.js'
import { app } from '../shells.js'
import { avatar, badge, btn, card, esc, field, icon, pageHead, status, table, toggleRow } from '../ui.js'

const G = 'Settings & admin'

const SECTIONS = [
  ['General', '/app/settings/'],
  ['Members', '/app/settings/members/'],
  ['Roles', '/app/settings/roles/'],
  ['Audit log', '/app/settings/audit/'],
  ['Integrations', '/app/settings/integrations/'],
  ['API keys', '/app/settings/api-keys/'],
  ['Notifications', '/app/settings/notifications/'],
  ['Branding', '/app/settings/branding/'],
  ['Custom fields', '/app/settings/fields/'],
  ['Job templates', '/app/settings/templates/'],
  ['Single sign-on', '/app/settings/sso/'],
  ['Data and privacy', '/app/settings/data/'],
]

function settings({ title, section, body, sub = '', acts = '', overlay = '' }) {
  return app({
    title,
    nav: 'Settings',
    overlay,
    body: `${pageHead({ title: 'Settings', sub: 'Northgate Mechanical workspace' })}<div class="grid g-side"><nav class="card hide-sm" style="padding:8px;align-self:start">${SECTIONS.map(([label, href]) => `<a href="${href}" class="row" style="padding:8px 10px;border-radius:7px;font-size:13px;font-weight:600;color:${label === section ? 'var(--ink);background:var(--line-2)' : 'var(--muted)'}">${label}</a>`).join('')}</nav>
    <div class="stack"><div class="ph"><div class="t"><h2 style="font-size:18px">${esc(section)}</h2>${sub ? `<p>${sub}</p>` : ''}</div>${acts ? `<div class="acts">${acts}</div>` : ''}</div>${body}</div></div>`,
  })
}

const general = () =>
  settings({
    title: 'Settings',
    section: 'General',
    body: `${card({ title: 'Company', body: `<div class="stack">${field('Company name', 'Northgate Mechanical')}<div class="grid g2">${field('Time zone', 'Central Time', { kind: 'select' })}${field('Currency', 'US dollar', { kind: 'select' })}</div><div class="grid g2">${field('Week starts on', 'Monday', { kind: 'select' })}${field('Job numbers start with', 'WO-')}</div></div>`, foot: btn('Save changes', { kind: 'primary' }) })}
    ${card({ title: 'Working hours', body: `${toggleRow('Same hours every weekday', '7:00 to 17:00, Monday to Friday', true)}${toggleRow('After-hours jobs', 'Bill at the after-hours rate and need an on-call technician', true)}${toggleRow('Weekend scheduling', 'Allow jobs on Saturday and Sunday', false)}` })}`,
  })

function members() {
  return settings({
    title: 'Members',
    section: 'Members',
    sub: '8 people · office seats are free',
    acts: btn('Invite people', { kind: 'primary', ic: 'user-plus', href: '/app/settings/members/invite/' }),
    body: table(
      [{ label: 'Name' }, { label: 'Role' }, { label: 'Status', cls: 'hide-sm' }, { label: 'Last active', cls: 'hide-sm' }, { label: '' }],
      MEMBERS.map(([n, e, r, s, last]) => [
        `<span class="row">${avatar(n, 'sm')}<span><strong>${n}</strong><div class="muted small">${e}</div></span></span>`,
        `<span class="select" style="height:30px;width:130px">${r}${icon('chevron-down')}</span>`,
        status(s),
        `<span class="muted">${last}</span>`,
        btn('', { kind: 'ghost', ic: 'ellipsis', size: 'sm' }),
      ]),
    ),
  })
}

function memberInvite() {
  const overlay = `<div class="scrim"><div class="modal" role="dialog" aria-label="Invite people"><div class="card-h"><h2>Invite people to Northgate Mechanical</h2>${btn('', { kind: 'ghost', ic: 'x' })}</div><div class="card-b stack">${field('Emails', 'alex@northgate.example, nora@northgate.example', { kind: 'textarea', help: 'Separate with commas. They get an email with a link that works for 7 days.' })}${field('Role', 'Dispatcher', { kind: 'select' })}<div class="alert info">${icon('shield-check')}<div><strong>Dispatcher</strong> can schedule and assign jobs, see customers and parts. Cannot see billing or change settings.</div></div></div><div class="card-f">${btn('Cancel', { kind: 'ghost' })}${btn('Send 2 invites', { kind: 'primary', ic: 'send', attrs: ' data-testid="send-invites"' })}</div></div></div>`
  return settings({
    title: 'Invite people',
    section: 'Members',
    body: table(
      [{ label: 'Name' }],
      MEMBERS.slice(0, 5).map(([n]) => [n]),
    ),
    overlay,
  })
}

const ROLES = [
  ['Owner', 1, 'Everything, including billing and deleting the workspace'],
  ['Admin', 1, 'Everything except billing and deleting the workspace'],
  ['Dispatcher', 2, 'Schedule, assign, customers, parts'],
  ['Billing', 1, 'Invoices, estimates, payments, reports'],
  ['Technician', 12, 'Their own jobs in the mobile app'],
  ['Viewer', 1, 'Read only, no customer contact details'],
]
const roles = () =>
  settings({
    title: 'Roles',
    section: 'Roles',
    sub: '6 roles',
    acts: btn('New role', { kind: 'primary', ic: 'plus' }),
    body: table(
      [{ label: 'Role' }, { label: 'People', cls: 'right' }, { label: 'Can', cls: 'hide-sm' }, { label: '' }],
      ROLES.map(([r, n, d]) => [
        `<a href="/app/settings/roles/dispatcher/"><strong>${r}</strong></a>${['Owner', 'Technician'].includes(r) ? ` ${badge('Built in', 'plain')}` : ''}`,
        n,
        `<span class="muted">${d}</span>`,
        btn('Edit', { size: 'sm', href: '/app/settings/roles/dispatcher/' }),
      ]),
    ),
  })

function roleEdit() {
  const perms = [
    ['Work orders', ['View', 'Create', 'Assign', 'Delete'], [1, 1, 1, 0]],
    ['Schedule and dispatch', ['View', 'Edit shifts', 'Approve time off'], [1, 1, 0]],
    ['Customers', ['View', 'Edit', 'See contact details'], [1, 1, 1]],
    ['Inventory', ['View', 'Adjust stock', 'Create POs', 'Approve POs'], [1, 1, 1, 0]],
    ['Invoices', ['View', 'Create', 'Record payments'], [0, 0, 0]],
    ['Settings', ['View', 'Change'], [0, 0]],
  ]
  return settings({
    title: 'Edit role',
    section: 'Roles',
    sub: 'Dispatcher · 2 people',
    acts: btn('Save role', { kind: 'primary' }),
    body: card({
      pad: false,
      body: `<table class="t"><thead><tr><th>Area</th><th>Permissions</th></tr></thead><tbody>${perms.map(([area, list, on]) => `<tr><td class="strong">${area}</td><td><div class="row wrap" style="gap:14px">${list.map((p, i) => `<label class="row small"><span class="cb ${on[i] ? 'on' : ''}"></span>${p}</label>`).join('')}</div></td></tr>`).join('')}</tbody></table>`,
    }),
  })
}

function audit() {
  const rows = [
    ['Robin Ash', 'Changed the role of Lee Chan to Suspended', 'Members', 'Today 9:02', '198.51.100.24'],
    ['Jo Park', 'Invited alex@northgate.example as Viewer', 'Members', 'Today 8:31', '198.51.100.31'],
    ['Robin Ash', 'Approved PO-1182 ($2,384.50)', 'Inventory', 'Nov 20 16:12', '198.51.100.24'],
    ['Sam Ortiz', 'Exported invoices, Q3', 'Data', 'Nov 2 10:40', '203.0.113.9'],
    ['Robin Ash', 'Created API key "Accounting sync"', 'API keys', 'Oct 28 14:05', '198.51.100.24'],
    ['System', 'Turned on two-step codes for all admins', 'Security', 'Oct 20 00:00', '--'],
  ]
  return settings({
    title: 'Audit log',
    section: 'Audit log',
    sub: 'Kept for 1 year',
    acts: btn('Export', { ic: 'download' }),
    body: `<div class="toolbar"><div class="search-in">${icon('search')}Search the log</div><span class="chip">${icon('funnel')}Person</span><span class="chip hide-sm">${icon('funnel')}Area</span></div>${table(
      [{ label: 'Who' }, { label: 'What' }, { label: 'Area', cls: 'hide-sm' }, { label: 'When' }, { label: 'IP', cls: 'hide-sm' }],
      rows.map(([w, what, area, when, ip]) => [
        `<span class="row">${w === 'System' ? icon('bot') : avatar(w, 'sm')}${w}</span>`,
        what,
        badge(area, 'plain'),
        `<span class="muted small">${when}</span>`,
        `<span class="mono muted">${ip}</span>`,
      ]),
    )}`,
  })
}

const INTEGRATIONS = [
  ['Ledgerly', 'Accounting: invoices and payments sync both ways', 'Connected'],
  ['Calendrio', 'Calendars: technicians see jobs in their own calendar', 'Connected'],
  ['Paywell', 'Card payments on invoices and in the field', 'Connected'],
  ['Textline', 'Arrival texts and reminders to customers', 'Not connected'],
  ['Fleetwise', 'Van GPS for the dispatch map', 'Not connected'],
  ['Booksmith', 'Accounting', 'Not connected'],
]
const integrations = () =>
  settings({
    title: 'Integrations',
    section: 'Integrations',
    sub: '3 connected',
    body: `<div class="grid g2">${INTEGRATIONS.map(([n, d, s]) => `<section class="card card-b stack tight"><div class="row">${avatar(n, 'sm')}<strong class="grow">${n}</strong>${status(s)}</div><p class="muted small">${d}</p><div>${s === 'Connected' ? btn('Settings', { size: 'sm', href: '/app/settings/integrations/ledgerly/' }) : btn('Connect', { size: 'sm', kind: 'primary' })}</div></section>`).join('')}</div>`,
  })

const integration = () =>
  settings({
    title: 'Integration: Ledgerly',
    section: 'Integrations',
    sub: `Ledgerly · ${status('Connected')} · last sync 4 minutes ago`,
    acts: btn('Disconnect', { kind: 'danger' }),
    body: `${card({ title: 'What syncs', body: `${toggleRow('Invoices', 'Brackwell to Ledgerly, when sent', true)}${toggleRow('Payments', 'Both ways', true)}${toggleRow('Customers', 'Ledgerly to Brackwell, new ones only', true)}${toggleRow('Items and prices', 'Keep the price book in Ledgerly', false)}` })}${card({ title: 'Recent syncs', pad: false, body: `<ul class="list">${['14 invoices sent', '9 payments received', '1 customer added', 'Failed: INV-20611 has no tax code'].map((t, i) => `<li>${icon(i === 3 ? 'triangle-alert' : 'refresh-cw')}<span class="grow">${t}</span><span class="muted small">${['4 min ago', '4 min ago', '1 hour ago', 'Yesterday'][i]}</span></li>`).join('')}</ul>` })}`,
  })

const apiKeys = () =>
  settings({
    title: 'API keys',
    section: 'API keys',
    sub: 'Keys act as the workspace. Keep them in a secrets manager.',
    acts: btn('New key', { kind: 'primary', ic: 'plus' }),
    body: `${table(
      [{ label: 'Name' }, { label: 'Key' }, { label: 'Scopes', cls: 'hide-sm' }, { label: 'Last used', cls: 'hide-sm' }, { label: '' }],
      [
        ['Accounting sync', 'bw_live_••••9f2a', 'invoices:write, payments:read', '4 min ago'],
        ['Website request form', 'bw_live_••••41cc', 'requests:create', 'Today'],
        ['Old reporting script', 'bw_live_••••07be', 'read', '94 days ago'],
      ].map(([n, k, s, u]) => [
        `<strong>${n}</strong>`,
        `<span class="mono">${k}</span>`,
        `<span class="muted small">${s}</span>`,
        u,
        btn('Revoke', { size: 'sm', kind: 'danger' }),
      ]),
    )}<div class="alert warn">${icon('triangle-alert')}<div>"Old reporting script" has not been used in 94 days. Revoke it if nobody needs it.</div></div>`,
  })

const notificationSettings = () =>
  settings({
    title: 'Notification settings',
    section: 'Notifications',
    body: `${card({ title: 'Email me when', body: `${toggleRow('A job assigned to me changes', 'Status, time or notes', true)}${toggleRow('An invoice is overdue', 'Once, on the day after it is due', true)}${toggleRow('Stock falls below the reorder point', 'A daily summary at 7:00', true)}${toggleRow('Someone mentions me', 'Right away', true)}${toggleRow('Weekly report', 'Monday at 6:00', false)}` })}${card({ title: 'Customers get', body: `${toggleRow('Arrival text', 'When the technician starts driving', true)}${toggleRow('Job summary', 'With photos, after the job is completed', true)}${toggleRow('Review request', 'A day after the visit', false)}` })}`,
  })

const branding = () =>
  settings({
    title: 'Branding',
    section: 'Branding',
    sub: 'How invoices, estimates and the customer portal look',
    body: `<div class="grid g2">${card({ title: 'Brand', body: `<div class="stack"><div class="field"><label>Logo</label><div class="row">${avatar('Northgate Mechanical', 'lg')}${btn('Replace', { size: 'sm', ic: 'upload' })}</div></div><div class="field"><label>Accent color</label><div class="row">${['#1e3a8a', '#ea6a1f', '#15803d', '#6d28d9', '#0e1726'].map((c, i) => `<span style="width:30px;height:30px;border-radius:8px;background:${c};${i === 0 ? 'box-shadow:0 0 0 3px #fff,0 0 0 5px #1e3a8a' : ''}"></span>`).join('')}</div></div>${field('Invoice footer', 'Thank you for choosing Northgate Mechanical.')}</div>` })}
    ${card({ title: 'Preview', body: `<div class="card"><div style="background:#1e3a8a;height:8px;border-radius:10px 10px 0 0"></div><div class="card-b stack tight"><strong>Northgate Mechanical</strong><span class="muted small">Invoice INV-20636</span><span class="sk w80"></span><span class="sk w60"></span><span class="sk w30"></span></div></div>` })}</div>`,
  })

const customFields = () =>
  settings({
    title: 'Custom fields',
    section: 'Custom fields',
    acts: btn('Add field', { kind: 'primary', ic: 'plus' }),
    body: table(
      [{ label: 'Field' }, { label: 'On' }, { label: 'Type', cls: 'hide-sm' }, { label: 'Required', cls: 'hide-sm' }],
      [
        ['Gate code', 'Sites', 'Text', 'No'],
        ['Refrigerant type', 'Equipment', 'List', 'Yes'],
        ['PO number', 'Work orders', 'Text', 'For some customers'],
        ['Van', 'Technicians', 'List', 'Yes'],
      ].map(([f, on, t, r]) => [`<span class="row">${icon('grip-vertical')}<strong>${f}</strong></span>`, badge(on, 'plain'), t, r]),
    ),
  })

const templates = () =>
  settings({
    title: 'Job templates',
    section: 'Job templates',
    acts: btn('New template', { kind: 'primary', ic: 'plus' }),
    body: `<div class="grid g2">${[
      ['HVAC repair', 7, 4],
      ['HVAC preventive maintenance', 12, 6],
      ['Water heater replacement', 9, 5],
      ['Panel upgrade', 11, 8],
      ['Backflow test', 6, 2],
      ['Fire damper inspection', 8, 1],
    ]
      .map(
        ([t, steps, parts]) =>
          `<section class="card card-b stack tight"><div class="row">${icon('list-checks')}<strong class="grow">${t}</strong>${btn('', { kind: 'ghost', ic: 'ellipsis', size: 'sm' })}</div><span class="muted small">${steps} checklist steps · ${parts} typical parts</span></section>`,
      )
      .join('')}</div>`,
  })

const sso = () =>
  settings({
    title: 'Single sign-on',
    section: 'Single sign-on',
    sub: `${badge('Enterprise', 'violet')} SAML 2.0 or OpenID Connect`,
    body: `${card({ title: 'Identity provider', body: `<div class="stack">${field('Sign-in URL', 'https://login.northgate.example/sso/saml')}${field('Entity ID', 'northgate-brackwell')}${field('Certificate', 'Uploaded Oct 20, expires Oct 2028')}${toggleRow('Require SSO for everyone', 'Technicians on phones keep their app sign-in', false)}</div>`, foot: `${btn('Test sign-in')}${btn('Save', { kind: 'primary' })}` })}`,
  })

const data = () =>
  settings({
    title: 'Data and privacy',
    section: 'Data and privacy',
    body: `${card({ title: 'Export everything', body: '<p class="muted">A zip of every job, customer, invoice and photo. It takes a few minutes; we email a link that works for 24 hours.</p>', foot: btn('Request export', { ic: 'download' }) })}${card({ title: 'Retention', body: `${toggleRow('Delete technician locations after 30 days', 'Only the job addresses stay', true)}${toggleRow('Delete photos of closed jobs after 3 years', '', false)}` })}
    <section class="card" style="border-color:#f7c6c0"><div class="card-h"><h2 style="color:var(--red-strong)">Delete workspace</h2></div><div class="card-b row between wrap"><p class="muted">Deletes Northgate Mechanical and all its data after 30 days. Only the owner can do this.</p>${btn('Delete workspace', { kind: 'danger-solid' })}</div></section>`,
  })

export const pages = [
  { id: 'settings', path: '/app/settings/', title: 'Settings: general', group: G, render: general },
  { id: 'members', path: '/app/settings/members/', title: 'Members', group: G, render: members },
  {
    id: 'member-invite',
    path: '/app/settings/members/invite/',
    title: 'Invite people',
    group: G,
    note: 'Dialog open',
    render: memberInvite,
  },
  { id: 'roles', path: '/app/settings/roles/', title: 'Roles', group: G, render: roles },
  { id: 'role-edit', path: '/app/settings/roles/dispatcher/', title: 'Edit role', group: G, render: roleEdit },
  { id: 'audit', path: '/app/settings/audit/', title: 'Audit log', group: G, render: audit },
  { id: 'integrations', path: '/app/settings/integrations/', title: 'Integrations', group: G, render: integrations },
  { id: 'integration', path: '/app/settings/integrations/ledgerly/', title: 'Integration settings', group: G, render: integration },
  { id: 'api-keys', path: '/app/settings/api-keys/', title: 'API keys', group: G, render: apiKeys },
  {
    id: 'notification-settings',
    path: '/app/settings/notifications/',
    title: 'Notification settings',
    group: G,
    render: notificationSettings,
  },
  { id: 'branding', path: '/app/settings/branding/', title: 'Branding', group: G, render: branding },
  { id: 'custom-fields', path: '/app/settings/fields/', title: 'Custom fields', group: G, render: customFields },
  { id: 'job-templates', path: '/app/settings/templates/', title: 'Job templates', group: G, render: templates },
  { id: 'sso-settings', path: '/app/settings/sso/', title: 'Single sign-on', group: G, render: sso },
  { id: 'data-privacy', path: '/app/settings/data/', title: 'Data and privacy', group: G, render: data },
]
