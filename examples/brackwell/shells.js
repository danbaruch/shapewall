// The frames around Brackwell's screens: the marketing site, sign-in pages,
// onboarding, the signed-in app (sidebar, top bar, phone tab bar), the
// customer portal and the technician app.
import { ME } from './data.js'
import { avatar, doc, esc, icon, logoMark } from './ui.js'

const MK_LINKS = [
  ['Product', '/product/'],
  ['Solutions', '/solutions/hvac/'],
  ['Customers', '/customers/'],
  ['Pricing', '/pricing/'],
  ['Changelog', '/changelog/'],
]

export function marketing({ title, active = '', body }) {
  return doc({
    title,
    bodyClass: 'mk',
    body: `<header class="mk-nav">
      <a class="brand" href="/">${logoMark()}Brackwell</a>
      <nav class="links">${MK_LINKS.map(([label, href]) => `<a href="${href}" class="${label === active ? 'on' : ''}">${label}</a>`).join('')}</nav>
      <div class="cta"><a class="btn ghost" href="/signin/">Sign in</a><a class="btn primary" href="/signup/" data-testid="nav-cta">Start free trial</a><span class="btn icon ghost menu-btn">${icon('menu')}</span></div>
    </header>
    <main>${body}</main>
    <footer class="mk-foot"><div class="wrap"><div class="cols">
      <div class="stack tight"><span class="row" style="color:#fff;font-weight:800">${logoMark()}Brackwell</span><p>Field operations software for service teams: jobs, crews, parts and invoices in one place.</p></div>
      <div><h4>Product</h4><a href="/product/">Overview</a><a href="/features/scheduling/">Scheduling</a><a href="/features/dispatch/">Dispatch</a><a href="/features/mobile/">Mobile app</a></div>
      <div><h4>Solutions</h4><a href="/solutions/hvac/">HVAC</a><a href="/solutions/facilities/">Facilities</a><a href="/customers/">Customers</a></div>
      <div><h4>Company</h4><a href="/changelog/">Changelog</a><a href="/contact/">Contact sales</a><a href="/security/">Security</a></div>
      <div><h4>Get started</h4><a href="/signup/">Free trial</a><a href="/signin/">Sign in</a><a href="/pricing/">Pricing</a></div>
    </div><p class="small" style="margin-top:28px">Brackwell is a fictional product made for the Shapewall demo.</p></div></footer>`,
  })
}

export function auth({
  title,
  body,
  quote = 'We went from whiteboards and group texts to one schedule everybody trusts.',
  who = 'Operations lead, a regional HVAC company',
}) {
  return doc({
    title,
    body: `<div class="auth"><section class="pane"><a class="row" href="/" style="color:var(--ink);font-weight:800;font-size:17px">${logoMark()}Brackwell</a><div class="box">${body}</div></section>
    <aside class="art"><svg class="glow" viewBox="0 0 600 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><circle cx="480" cy="140" r="260" fill="#ea6a1f" opacity=".18"/><circle cx="80" cy="520" r="200" fill="#2563eb" opacity=".16"/><g stroke="#ffffff" opacity=".07">${Array.from({ length: 16 }, (_, i) => `<line x1="0" y1="${i * 50}" x2="600" y2="${i * 50 + 120}"/>`).join('')}</g></svg>
    <blockquote>"${esc(quote)}"</blockquote><p style="position:relative;color:#9fb0c2">${esc(who)}</p></aside></div>`,
  })
}

export function centered({ title, body, top = true }) {
  return doc({
    title,
    body: `${top ? `<header class="ob-top"><a class="row" href="/" style="color:var(--ink);font-weight:800">${logoMark()}Brackwell</a></header>` : ''}<div class="center-page"><section class="card center-card">${body}</section></div>`,
  })
}

export function onboarding({ title, step, body }) {
  return doc({
    title,
    body: `<div class="ob"><header class="ob-top"><span class="row" style="font-weight:800">${logoMark()}Brackwell</span><div class="steps grow" style="max-width:320px;margin-left:auto">${[
      1, 2, 3, 4, 5,
    ]
      .map((n) => `<i class="${n <= step ? 'on' : ''}"></i>`)
      .join('')}</div><span class="muted small" data-testid="ob-step">Step ${step} of 5</span></header>
      <div class="ob-body"><section class="card ob-card">${body}</section></div></div>`,
  })
}

const NAV = [
  ['Home', '/app/', 'house'],
  ['Work orders', '/app/work-orders/', 'clipboard-list', 31],
  ['Schedule', '/app/schedule/', 'calendar-days'],
  ['Dispatch', '/app/dispatch/', 'map'],
  ['Projects', '/app/projects/', 'folder-kanban'],
  ['Customers', '/app/customers/', 'building'],
  ['Inventory', '/app/inventory/', 'package'],
  ['Team', '/app/team/', 'users'],
  ['Invoices', '/app/invoices/', 'receipt'],
  ['Reports', '/app/reports/', 'chart-column'],
]
const TABS = [
  ['Home', '/app/', 'house'],
  ['Jobs', '/app/work-orders/', 'clipboard-list'],
  ['Schedule', '/app/schedule/', 'calendar-days'],
  ['Dispatch', '/app/dispatch/', 'map'],
  ['More', '/app/settings/', 'menu'],
]

// The signed-in app. `nav`: the sidebar entry that is current; `overlay`: a
// dialog, drawer or toast over the page.
export function app({ title, nav, body, overlay = '', notify = true }) {
  const link = ([label, href, ic, count]) =>
    `<a href="${href}" class="${label === nav ? 'on' : ''}">${icon(ic)}${esc(label)}${count ? `<span class="count">${count}</span>` : ''}</a>`
  return doc({
    title,
    body: `<div class="app">
    <aside class="side"><div class="brand">${logoMark()}Brackwell</div>
      <div class="ws">${avatar('Northgate Mechanical', 'sm')}<span class="grow">Northgate Mechanical</span>${icon('chevron-down')}</div>
      ${NAV.map(link).join('')}
      <div class="sec">Workspace</div>
      ${link(['Settings', '/app/settings/', 'settings'])}
      ${link(['Plan & billing', '/app/billing/', 'credit-card'])}
      <div class="foot">${avatar(ME.name, 'sm')}<span class="grow">${esc(ME.name)}<br /><span style="color:#6f8398">${esc(ME.role)}</span></span></div>
    </aside>
    <div class="main">
      <header class="top"><span class="btn icon ghost menu-btn">${icon('menu')}</span><span class="m-logo">${logoMark()}</span>
        <div class="search">${icon('search')}Search jobs, customers, parts<span class="kbd">/</span></div><span class="spacer"></span>
        <a class="btn sm hide-sm" href="/app/work-orders/new/">${icon('plus')}New</a>
        <a class="bell" href="/app/notifications/" aria-label="Notifications">${icon('bell')}${notify ? '<span class="dot"></span>' : ''}</a>${avatar(ME.name)}</header>
      <main class="content">${body}</main>
    </div></div>
    <nav class="tabbar">${TABS.map(([label, href, ic]) => `<a href="${href}" class="${label === nav || (label === 'Jobs' && nav === 'Work orders') ? 'on' : ''}">${icon(ic)}${label}</a>`).join('')}</nav>${overlay}`,
  })
}

export function portal({ title, body }) {
  return doc({
    title,
    body: `<div class="portal"><header class="portal-top"><span class="pb"></span><strong>Northgate Mechanical</strong><span class="muted small">Customer portal</span><span style="margin-left:auto" class="row small muted">${avatar('Amara Bell', 'sm')}<span class="hide-sm">Amara Bell, Crestline Dental Group</span></span></header>
    <main class="portal-body">${body}</main><p class="powered">Powered by Brackwell</p></div>`,
  })
}

const TECH_TABS = [
  ['Today', 'calendar-days'],
  ['Jobs', 'clipboard-list'],
  ['Parts', 'package'],
  ['Me', 'users'],
]
export function tech({ title, top, body, tab = 'Today', cta = '', offline = false }) {
  return doc({
    title,
    body: `<div class="tech"><div class="phone">${offline ? `<div class="offline">${icon('wifi-off')}Offline: changes sync when you are back online</div>` : ''}<header class="tech-top">${top}</header><main class="tech-body">${body}</main>${cta ? `<div class="cta-fixed">${cta}</div>` : ''}
    <nav class="tech-tabs">${TECH_TABS.map(([label, ic]) => `<span class="${label === tab ? 'on' : ''}">${icon(ic)}${label}</span>`).join('')}</nav></div></div>`,
  })
}

export function system({ title, body }) {
  return doc({ title, body: `<div class="sys">${body}</div>` })
}
