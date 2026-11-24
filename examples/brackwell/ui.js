// Brackwell's building blocks: the HTML every screen is made of (shells,
// tables, cards, charts, maps). Plain strings, no framework: each screen is a
// function of the shared data (data.js) and the site's state (build.js).
import { ICONS } from './icons.js'

export const esc = (value) =>
  String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])

export const icon = (name, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`

export const money = (value, cents = false) =>
  '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })

// The whole document. Root-absolute links (/styles.css): the published copies rewrite them.
export function doc({ title, body, bodyClass = '' }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)} · Brackwell</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body${bodyClass ? ` class="${bodyClass}"` : ''}>
${body}
  </body>
</html>
`
}

export const logoMark = () =>
  `<span class="logo-mark"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5H6v14h3"/><path d="M15 5h3v14h-3"/><path d="M12 9v6"/></svg></span>`

const COLORS = ['#ea6a1f', '#2563eb', '#0f766e', '#6d28d9', '#be185d', '#15803d', '#b45309', '#0e7490', '#4338ca', '#9f1239']
export function avatar(name, size = '') {
  const initials = String(name)
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
  let hash = 0
  for (const char of String(name)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `<span class="av ${size}" style="background:${COLORS[hash % COLORS.length]}" title="${esc(name)}">${esc(initials)}</span>`
}
export const avatars = (names) => `<span class="avs">${names.map((name) => avatar(name, 'sm')).join('')}</span>`

export const badge = (text, tone = '') => `<span class="badge ${tone}">${esc(text)}</span>`
const STATUS_TONE = {
  New: 'blue',
  Scheduled: 'violet',
  Assigned: 'violet',
  'En route': 'teal',
  'In progress': 'amber',
  'On hold': 'red',
  Completed: 'green',
  Invoiced: 'plain',
  Paid: 'green',
  Sent: 'blue',
  Draft: 'plain',
  Overdue: 'red',
  'Partially paid': 'amber',
  Approved: 'green',
  Declined: 'red',
  Pending: 'amber',
  Active: 'green',
  Invited: 'blue',
  Suspended: 'red',
  'On track': 'green',
  'At risk': 'amber',
  'Off track': 'red',
  Planning: 'blue',
  Received: 'green',
  Ordered: 'blue',
  'In stock': 'green',
  'Low stock': 'amber',
  'Out of stock': 'red',
  Connected: 'green',
  'Not connected': 'plain',
  Online: 'green',
  Offline: 'plain',
  'On a job': 'amber',
  Submitted: 'blue',
  Rejected: 'red',
  Open: 'blue',
  Closed: 'plain',
}
export const status = (text) => badge(text, STATUS_TONE[text] ?? '')
export const prio = (level) =>
  `<span class="prio p${level}" title="${['Low', 'Normal', 'High', 'Urgent'][level]} priority"><i></i><i></i><i></i></span>`

export const btn = (label, { kind = '', href = null, ic = null, size = '', attrs = '' } = {}) => {
  const inner = `${ic ? icon(ic) : ''}${label ? esc(label) : ''}`
  const cls = `btn ${kind} ${size}${!label ? ' icon' : ''}`.trim()
  return href ? `<a class="${cls}" href="${href}"${attrs}>${inner}</a>` : `<button class="${cls}" type="button"${attrs}>${inner}</button>`
}

export const card = ({ title = null, actions = '', body = '', foot = '', pad = true, cls = '' }) =>
  `<section class="card ${cls}">${title ? `<div class="card-h"><h2>${esc(title)}</h2>${actions}</div>` : ''}${pad ? `<div class="card-b">${body}</div>` : body}${foot ? `<div class="card-f">${foot}</div>` : ''}</section>`

export const stat = (label, value, delta = '', tone = 'up') =>
  `<section class="card stat"><div class="label">${esc(label)}</div><div class="value">${value}</div>${delta ? `<div class="delta ${tone}">${esc(delta)}</div>` : ''}</section>`

// columns: [{ label, cls }]; rows: arrays of cell HTML (already escaped).
export function table(columns, rows, { pager = null, select = false, selected = [] } = {}) {
  const head = `${select ? '<th style="width:28px"><span class="cb"></span></th>' : ''}${columns
    .map((col) => `<th class="${col.cls || ''}">${esc(col.label)}</th>`)
    .join('')}`
  const body = rows
    .map(
      (row, index) =>
        `<tr${selected.includes(index) ? ' class="sel"' : ''}>${select ? `<td><span class="cb${selected.includes(index) ? ' on' : ''}"></span></td>` : ''}${row
          .map((cell, col) => `<td class="${columns[col]?.cls || ''}">${cell}</td>`)
          .join('')}</tr>`,
    )
    .join('')
  return `<div class="card table-wrap"><table class="t"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${
    pager
      ? `<div class="pager"><span>${esc(pager)}</span><span class="row">${btn('Previous', { size: 'sm' })}${btn('Next', { size: 'sm' })}</span></div>`
      : ''
  }</div>`
}

export const field = (label, value = '', { help = '', kind = 'input', state = '', placeholder = '' } = {}) =>
  `<div class="field"><label>${esc(label)}</label><div class="${kind} ${state}">${
    value ? esc(value) : `<span class="faint">${esc(placeholder)}</span>`
  }${kind === 'select' ? icon('chevron-down') : ''}</div>${help ? `<div class="help ${state === 'err' ? 'err' : ''}">${esc(help)}</div>` : ''}</div>`

export const toggleRow = (title, sub, on = true) =>
  `<div class="row between" style="padding:12px 0;border-bottom:1px solid var(--line-2)"><div class="grow"><div style="font-weight:600">${esc(title)}</div><div class="muted small">${esc(sub)}</div></div><span class="toggle${on ? ' on' : ''}"></span></div>`

export const tabs = (items, active) =>
  `<nav class="tabs">${items
    .map(
      ([label, href, n]) =>
        `<a href="${href}" class="${label === active ? 'on' : ''}">${esc(label)}${n !== undefined ? `<span class="n">${n}</span>` : ''}</a>`,
    )
    .join('')}</nav>`

export const crumbs = (items) =>
  `<div class="crumbs">${items.map(([label, href], i) => (i ? icon('chevron-right') : '') + (href ? `<a href="${href}" class="muted">${esc(label)}</a>` : `<span>${esc(label)}</span>`)).join('')}</div>`

export const pageHead = ({ title, sub = '', acts = '', crumbs: trail = null }) =>
  `${trail ? crumbs(trail) : ''}<div class="ph"><div class="t"><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${acts ? `<div class="acts">${acts}</div>` : ''}</div>`

export const emptyState = ({ title, text, acts = '', art = 'inbox' }) =>
  `<div class="empty">${emptyArt(art)}<h2>${esc(title)}</h2><p>${esc(text)}</p>${acts ? `<div class="row">${acts}</div>` : ''}</div>`

function emptyArt(name) {
  return `<svg class="art" viewBox="0 0 120 90" aria-hidden="true"><rect x="14" y="16" width="92" height="62" rx="10" fill="#f1f4f8" stroke="#dbe2ea"/><rect x="26" y="30" width="44" height="7" rx="3.5" fill="#dbe2ea"/><rect x="26" y="44" width="64" height="6" rx="3" fill="#e6ebf1"/><rect x="26" y="56" width="52" height="6" rx="3" fill="#e6ebf1"/><circle cx="92" cy="22" r="14" fill="#fdeee4" stroke="#f6c3a0"/><g transform="translate(84 14) scale(.67)" fill="none" stroke="#c4530f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</g></svg>`
}

export const skeletonRows = (n = 6) =>
  `<div class="card"><div class="card-b stack">${Array.from({ length: n }, (_, i) => `<div class="row" style="gap:14px"><span class="sk" style="width:28px;height:28px;border-radius:50%"></span><span class="sk ${['w60', 'w80', 'w30'][i % 3]}"></span><span class="sk w30"></span></div>`).join('')}</div></div>`

// ---- Charts (inline SVG) ----
export function barChart(values, { labels = [], color = '#ea6a1f', height = 180, second = null, secondColor = '#cbd5e1' } = {}) {
  const width = 640
  const max = Math.max(...values, ...(second || [])) * 1.15
  const n = values.length
  const slot = (width - 40) / n
  const barW = Math.min(28, slot * (second ? 0.32 : 0.55))
  const y = (v) => height - 24 - (v / max) * (height - 40)
  let out = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Bar chart">`
  for (let g = 0; g <= 4; g++) {
    const gy = 16 + ((height - 40) / 4) * g
    out += `<line x1="36" x2="${width}" y1="${gy}" y2="${gy}" stroke="#eef2f6"/>`
  }
  values.forEach((v, i) => {
    const x = 40 + slot * i + slot / 2 - (second ? barW : barW / 2)
    out += `<rect x="${x}" y="${y(v)}" width="${barW}" height="${height - 24 - y(v)}" rx="4" fill="${color}"/>`
    if (second)
      out += `<rect x="${x + barW + 2}" y="${y(second[i])}" width="${barW}" height="${height - 24 - y(second[i])}" rx="4" fill="${secondColor}"/>`
    if (labels[i])
      out += `<text x="${40 + slot * i + slot / 2}" y="${height - 6}" font-size="11" text-anchor="middle" fill="#94a3b8">${esc(labels[i])}</text>`
  })
  return out + '</svg>'
}

export function lineChart(series, { labels = [], height = 200, colors = ['#ea6a1f', '#2563eb', '#94a3b8'], area = true } = {}) {
  const width = 640
  const all = series.flat()
  const max = Math.max(...all) * 1.1
  const min = Math.min(0, ...all)
  const n = series[0].length
  const x = (i) => 40 + ((width - 50) / (n - 1)) * i
  const y = (v) => height - 24 - ((v - min) / (max - min)) * (height - 40)
  let out = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Line chart">`
  for (let g = 0; g <= 4; g++) {
    const gy = 16 + ((height - 40) / 4) * g
    out += `<line x1="36" x2="${width}" y1="${gy}" y2="${gy}" stroke="#eef2f6"/>`
  }
  series.forEach((values, s) => {
    const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    if (area && s === 0)
      out += `<path d="M${pts.join(' L')} L${x(n - 1)},${height - 24} L${x(0)},${height - 24} Z" fill="${colors[0]}" opacity=".10"/>`
    out += `<polyline points="${pts.join(' ')}" fill="none" stroke="${colors[s]}" stroke-width="${s ? 2 : 2.5}"${s ? ' stroke-dasharray="5 4"' : ''} stroke-linejoin="round"/>`
  })
  labels.forEach((label, i) => {
    if (label) out += `<text x="${x(i)}" y="${height - 6}" font-size="11" text-anchor="middle" fill="#94a3b8">${esc(label)}</text>`
  })
  return out + '</svg>'
}

export function donut(parts, { size = 140 } = {}) {
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  const r = 52
  const c = 2 * Math.PI * r
  let offset = 0
  let out = `<svg viewBox="0 0 140 140" width="${size}" height="${size}" role="img" aria-label="Donut chart"><circle cx="70" cy="70" r="${r}" fill="none" stroke="#eef2f6" stroke-width="16"/>`
  for (const part of parts) {
    const len = (part.value / total) * c
    out += `<circle cx="70" cy="70" r="${r}" fill="none" stroke="${part.color}" stroke-width="16" stroke-dasharray="${len.toFixed(1)} ${(c - len).toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(1)}" transform="rotate(-90 70 70)"/>`
    offset += len
  }
  return out + '</svg>'
}

export const legend = (items) =>
  `<div class="legend">${items.map(([label, color]) => `<span><i style="background:${color}"></i>${esc(label)}</span>`).join('')}</div>`

export const spark = (values, color = '#ea6a1f') => {
  const max = Math.max(...values)
  const min = Math.min(...values)
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / (max - min || 1)) * 24}`).join(' ')
  return `<svg viewBox="0 0 100 30" width="100" height="30" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/></svg>`
}

// ---- A made-up city map (streets, a river, parks), with pins in percent ----
export function map({ pins = [], height = 420, route = null } = {}) {
  const roads = [
    'M0 120 C 200 110, 420 160, 1000 130',
    'M0 330 C 300 300, 600 360, 1000 320',
    'M180 0 C 170 200, 230 400, 210 600',
    'M520 0 C 540 180, 500 420, 540 600',
    'M800 0 C 780 220, 830 380, 810 600',
    'M0 480 L 1000 455',
  ]
  const minor = Array.from({ length: 14 }, (_, i) => `M${i * 75 + 20} 0 L ${i * 75 + 40} 600`).concat(
    Array.from({ length: 9 }, (_, i) => `M0 ${i * 70 + 25} L 1000 ${i * 70 + 35}`),
  )
  let base = `<svg class="base" viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="1000" height="600" fill="#eef1ea"/>`
  base += `<path d="M640 0 C 600 120, 700 200, 650 320 S 560 520, 620 600 L 700 600 C 650 520, 740 380, 720 300 S 680 110, 710 0 Z" fill="#cfe0ef"/>`
  base += `<rect x="260" y="180" width="150" height="100" rx="14" fill="#d6e8d0"/><rect x="60" y="380" width="110" height="80" rx="12" fill="#d6e8d0"/><rect x="850" y="60" width="120" height="90" rx="12" fill="#d6e8d0"/>`
  base += minor.map((d) => `<path d="${d}" stroke="#ffffff" stroke-width="5" fill="none" opacity=".9"/>`).join('')
  base += roads
    .map(
      (d) =>
        `<path d="${d}" stroke="#ffffff" stroke-width="14" fill="none"/><path d="${d}" stroke="#f4d58d" stroke-width="5" fill="none"/>`,
    )
    .join('')
  if (route)
    base += `<polyline points="${route.map(([x, y]) => `${x * 10},${y * 6}`).join(' ')}" fill="none" stroke="#2563eb" stroke-width="6" stroke-linejoin="round" stroke-linecap="round" opacity=".85"/>`
  base += '</svg>'
  const marks = pins
    .map(
      (pin) =>
        `<div class="pin${pin.kind ? ` is-${pin.kind}` : ''}" style="left:${pin.x}%;top:${pin.y}%"><b><span>${esc(pin.label || '')}</span></b>${pin.tag ? `<span class="tag">${esc(pin.tag)}</span>` : ''}</div>`,
    )
    .join('')
  return `<div class="map" style="height:${height}px">${base}${marks}</div>`
}

// A made-up job-site photo (shapes, no text).
export function photo(seed = 0) {
  const tones = [
    ['#c9d2dc', '#8a99a8', '#5b6b7b'],
    ['#d8cfc4', '#a48d74', '#6f5a45'],
    ['#cfd9cf', '#8aa08a', '#566b56'],
    ['#d6d2e2', '#9b93b6', '#625a80'],
  ][seed % 4]
  return `<div class="photo"><svg viewBox="0 0 160 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="160" height="120" fill="${tones[0]}"/><rect x="${20 + (seed % 3) * 10}" y="30" width="70" height="70" rx="4" fill="${tones[1]}"/><circle cx="${55 + (seed % 3) * 10}" cy="65" r="18" fill="${tones[2]}"/><rect x="100" y="20" width="44" height="86" rx="3" fill="${tones[1]}" opacity=".7"/><rect x="108" y="32" width="28" height="6" rx="3" fill="${tones[2]}"/><rect x="108" y="46" width="20" height="6" rx="3" fill="${tones[2]}"/></svg></div>`
}
