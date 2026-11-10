// Live HTML snapshots. In the same browser page as the screenshot, the
// rendered DOM (so client-rendered content is included) is cloned, its
// stylesheets are collected in cascade order (responsive @media rules kept)
// and form values are frozen. Images are re-encoded inside the page from the
// decoded pixels (canvas, WebP at quality 0.8, at most twice their displayed
// width), so they are complete and small; only when that is impossible
// (cross-origin pixels) the browser's downloaded body is used, after checking
// it is complete. Fonts come from the downloaded bodies with the same check.
// Identical images are stored once. The result goes through the strict
// sanitizer (sanitize.js) and is written as <name>.<viewport>.html.

import crypto from 'node:crypto'
import fs from 'node:fs'
import { BlockList, isIP } from 'node:net'
import { parse, serialize } from 'parse5'
import { placeholderSvg, sanitizeCss, sanitizeDocument } from './sanitize.js'
import { writeFileAtomic } from '../store.js'
import { ELEMENT_MAP_EXPRESSION, ELEMENT_MAP_LIMITS, cleanElementMap } from './element-map.js'

const IMAGE_BUDGET = 3 * 1024 * 1024 // data: characters for all distinct images on a page
const IMAGE_MAX_EACH = 640 * 1024 // one image after re-encoding
const BODY_MAX_EACH = 1536 * 1024 // a downloaded body we would inline as is
const FONT_BUDGET = 1536 * 1024 // all fonts; above it pages fall back to system fonts
const FONT_MAX_EACH = 400 * 1024
const HTML_MAX = 8 * 1024 * 1024 // the page snapshot as returned from the browser
export const FILE_MAX = 5 * 1024 * 1024 // the final written document
const CSS_MAX = 6 * 1024 * 1024 // all stylesheet text of one page
const CSS_SHEET_MAX = 2 * 1024 * 1024 // one cross-origin stylesheet fetched by body
const CSS_IMAGES_MAX = 60 // background images re-encoded per page
const FRAME_RULES = 'html,body{overflow:hidden!important;scroll-behavior:auto!important}'
const TRANSPARENT_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const BASE64_IMAGE_RE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/

// Runs inside the captured page (Runtime.evaluate, awaited). Must be
// self-contained: it is sent as source text. It does not change the live page.
export async function snapshotPage(limits) {
  const doc = document
  const base = doc.baseURI
  const absolute = (value) => {
    try {
      return new URL(value, base).href
    } catch (error) {
      return ''
    }
  }

  // Rules whose selectors match nothing on this page are dropped (app CSS
  // bundles are mostly other pages). Pseudo-classes and pseudo-elements are
  // ignored for the test, so :hover and ::before rules of present elements stay.
  // An escaped colon is part of a class name (Tailwind's .lg\:translate-x-0),
  // not a pseudo-class, so it is left alone.
  const matches = (selectorText) =>
    selectorText.split(',').some((part) => {
      const plain = part.replace(/(?<!\\)::?[a-zA-Z-]+(\([^)]*\))?/g, '').trim() || '*'
      try {
        return Boolean(doc.querySelector(plain))
      } catch (error) {
        return true
      }
    })
  const ruleText = (rule) => {
    if (rule.type === 1) return matches(rule.selectorText) ? rule.cssText : ''
    if (
      rule.cssRules &&
      (rule.type === 4 ||
        rule.type === 12 ||
        (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) ||
        (typeof CSSContainerRule !== 'undefined' && rule instanceof CSSContainerRule))
    ) {
      const inner = Array.from(rule.cssRules).map(ruleText).filter(Boolean).join('\n')
      if (!inner) return ''
      const head = rule.cssText.slice(0, rule.cssText.indexOf('{')).trim()
      return `${head} {\n${inner}\n}`
    }
    return rule.cssText
  }

  // Stylesheets in cascade order; @import sheets come before the rest of
  // their parent, as they apply. Cross-origin sheets are fetched by Node.
  const chunks = []
  const pushSheet = (sheet, depth, inheritedMedia) => {
    if (!sheet || depth > 6 || sheet.disabled) return
    const mediaText = [inheritedMedia, sheet.media && sheet.media.mediaText].filter((text) => text && text !== 'all').join(' and ')
    const sheetBase = sheet.href || base
    let rules = null
    try {
      rules = sheet.cssRules
    } catch (error) {
      rules = null
    }
    if (!rules) {
      chunks.push({ href: sheet.href, base: sheetBase, text: null, media: mediaText })
      return
    }
    let text = ''
    for (const rule of rules) {
      if (rule.type === 3 && rule.styleSheet) {
        pushSheet(
          rule.styleSheet,
          depth + 1,
          [mediaText, rule.media && rule.media.mediaText].filter((part) => part && part !== 'all').join(' and '),
        )
        continue
      }
      const kept = ruleText(rule)
      if (kept) text += `${kept}\n`
    }
    chunks.push({ href: sheet.href, base: sheetBase, text, media: mediaText })
  }
  for (const sheet of Array.from(doc.styleSheets)) pushSheet(sheet, 0, '')
  for (const sheet of Array.from(doc.adoptedStyleSheets || [])) pushSheet(sheet, 0, '')
  const cssLength = chunks.reduce((sum, chunk) => sum + (chunk.text ? chunk.text.length : 0), 0)
  if (cssLength > limits.css) return { tooLarge: `the page CSS is ${Math.round(cssLength / 1048576)} MB, over the cap` }

  // Re-encode decoded pixels: complete by construction, at most `width`
  // pixels wide. Cross-origin pixels taint the canvas and return null.
  const encode = (image, width) => {
    const naturalWidth = image.naturalWidth || image.width
    const naturalHeight = image.naturalHeight || image.height
    if (!naturalWidth || !naturalHeight) return null
    let targetWidth = Math.max(1, Math.min(naturalWidth, Math.ceil(width)))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const targetHeight = Math.max(1, Math.round((targetWidth * naturalHeight) / naturalWidth))
      const canvas = doc.createElement('canvas')
      canvas.width = targetWidth
      canvas.height = targetHeight
      try {
        canvas.getContext('2d').drawImage(image, 0, 0, targetWidth, targetHeight)
        let url = canvas.toDataURL('image/webp', limits.quality)
        if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/png')
        if (url.length <= limits.imageEach) return url
      } catch (error) {
        return null
      }
      targetWidth = Math.max(1, Math.round(targetWidth / 2))
    }
    return null
  }

  const clone = doc.documentElement.cloneNode(true)
  const pairs = (selector) => {
    const live = Array.from(doc.documentElement.querySelectorAll(selector))
    const copy = Array.from(clone.querySelectorAll(selector))
    return live.length === copy.length ? live.map((element, index) => [element, copy[index]]) : []
  }

  // Freeze what the user would see in form controls.
  for (const [live, copy] of pairs('input, textarea, select')) {
    const tag = live.tagName.toLowerCase()
    if (tag === 'textarea') copy.textContent = live.value
    else if (tag === 'select') {
      Array.from(copy.options).forEach((option, index) => {
        if (live.options[index] && live.options[index].selected) option.setAttribute('selected', '')
        else option.removeAttribute('selected')
      })
    } else if (live.type === 'checkbox' || live.type === 'radio') {
      if (live.checked) copy.setAttribute('checked', '')
      else copy.removeAttribute('checked')
    } else if (live.type === 'hidden' || live.type === 'password') {
      // Tokens and secrets: the Node sanitizer drops these too.
      copy.removeAttribute('value')
    } else if (live.type !== 'file') {
      copy.setAttribute('value', live.value)
    }
  }

  // Images: re-encoded at twice the displayed width; the source URL stays
  // only when the pixels are not readable here (Node then checks the body).
  for (const [live, copy] of pairs('img')) {
    const rect = live.getBoundingClientRect()
    ;['srcset', 'sizes', 'loading', 'decoding', 'fetchpriority'].forEach((name) => copy.removeAttribute(name))
    copy.setAttribute('data-sw-w', String(Math.round(rect.width)))
    copy.setAttribute('data-sw-h', String(Math.round(rect.height)))
    const source = live.currentSrc || live.src || ''
    if (!source || !rect.width || !rect.height) {
      copy.removeAttribute('src')
      continue
    }
    const encoded = live.complete ? encode(live, rect.width * 2) : null
    copy.setAttribute('src', encoded || absolute(source))
  }
  clone.querySelectorAll('picture source').forEach((node) => node.remove())

  // Canvas and video become still images (or sized blanks).
  const still = (live, copy, dataUrl) => {
    const rect = live.getBoundingClientRect()
    const img = doc.createElement('img')
    if (copy.getAttribute('class')) img.setAttribute('class', copy.getAttribute('class'))
    img.setAttribute(
      'style',
      `${copy.getAttribute('style') || ''};width:${Math.round(rect.width)}px;height:${Math.round(rect.height)}px;object-fit:cover`,
    )
    img.setAttribute('data-sw-w', String(Math.round(rect.width)))
    img.setAttribute('data-sw-h', String(Math.round(rect.height)))
    if (dataUrl) img.setAttribute('src', dataUrl)
    copy.replaceWith(img)
  }
  for (const [live, copy] of pairs('canvas')) {
    const rect = live.getBoundingClientRect()
    let dataUrl = null
    try {
      dataUrl = encode(live, rect.width * 2)
    } catch (error) {
      dataUrl = null
    }
    still(live, copy, dataUrl)
  }
  for (const [live, copy] of pairs('video')) still(live, copy, live.poster ? absolute(live.poster) : '')

  // Background images from same-origin stylesheets, re-encoded the same way
  // (at most the viewport width; their displayed size is unknown here).
  const cssImages = {}
  const wanted = []
  for (const chunk of chunks) {
    if (!chunk.text) continue
    const fontBlocks = []
    const fontRe = /@font-face\s*\{[^}]*\}/gi
    let block
    while ((block = fontRe.exec(chunk.text))) fontBlocks.push([block.index, block.index + block[0].length])
    const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi
    let match
    while ((match = urlRe.exec(chunk.text)) && wanted.length < limits.cssImages) {
      const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim()
      if (!raw || raw.startsWith('data:') || raw.startsWith('#')) continue
      if (fontBlocks.some(([start, end]) => match.index >= start && match.index < end)) continue
      let url = ''
      try {
        url = new URL(raw, chunk.base).href.split('#')[0]
      } catch (error) {
        url = ''
      }
      if (url && !wanted.includes(url)) wanted.push(url)
    }
  }
  for (const url of wanted) {
    try {
      const image = new Image()
      image.src = url
      await Promise.race([image.decode(), new Promise((resolve, reject) => setTimeout(() => reject(new Error('slow')), 3000))])
      const encoded = encode(image, Math.min(innerWidth, 1600))
      if (encoded) cssImages[url] = encoded
    } catch (error) {
      /* not loadable here: Node may use the body */
    }
  }

  // Nothing that runs, loads or redirects; styles are rebuilt from `chunks`.
  clone
    .querySelectorAll('script, noscript, iframe, frame, object, embed, base, link, template, style, meta[http-equiv], audio')
    .forEach((node) => node.remove())
  for (const element of Array.from(clone.querySelectorAll('*'))) {
    for (const attr of Array.from(element.attributes)) {
      if (/^on/i.test(attr.name)) element.removeAttribute(attr.name)
    }
  }
  // Refuse oversized pages here, before anything crosses the DevTools pipe.
  const html = `<!DOCTYPE html>${clone.outerHTML}`
  if (html.length > limits.html) return { tooLarge: `the page HTML is ${Math.round(html.length / 1048576)} MB, over the cap` }
  return { html, chunks, base, cssImages, title: doc.title }
}

const SNAPSHOT_LIMITS = { html: HTML_MAX, css: CSS_MAX, quality: 0.8, imageEach: IMAGE_MAX_EACH, cssImages: CSS_IMAGES_MAX }
export const SNAPSHOT_EXPRESSION = `(${snapshotPage.toString()})(${JSON.stringify(SNAPSHOT_LIMITS)})`

function wrapMedia(css, media) {
  return media ? `@media ${media} {\n${css}\n}` : css
}

function stripHash(url) {
  const index = url.indexOf('#')
  return index >= 0 ? url.slice(0, index) : url
}

// ---- Completeness checks ------------------------------------------------------
// A body or data URI is inlined only if it is the whole file: the format's
// signature, and an end marker or a length field that matches.

export function imageIsComplete(buffer, mime) {
  if (!buffer || buffer.length < 8) return false
  const type = String(mime || '').toLowerCase()
  const startsWith = (bytes, offset = 0) => bytes.every((byte, index) => buffer[offset + index] === byte)
  if (type.includes('png'))
    return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && buffer.subarray(-12).includes(Buffer.from('IEND'))
  if (type.includes('jpeg') || type.includes('jpg')) {
    if (!startsWith([0xff, 0xd8, 0xff])) return false
    let end = buffer.length
    while (end > 2 && buffer[end - 1] === 0x00) end -= 1
    return buffer[end - 2] === 0xff && buffer[end - 1] === 0xd9
  }
  if (type.includes('gif')) return buffer.subarray(0, 4).toString('latin1') === 'GIF8' && buffer[buffer.length - 1] === 0x3b
  if (type.includes('webp'))
    return (
      buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
      buffer.subarray(8, 12).toString('latin1') === 'WEBP' &&
      buffer.readUInt32LE(4) + 8 <= buffer.length
    )
  if (type.includes('svg')) {
    const text = buffer.toString('utf8')
    return /<svg[\s>]/i.test(text) && /<\/svg>\s*$/i.test(text.trim())
  }
  if (type.includes('avif')) return buffer.subarray(4, 8).toString('latin1') === 'ftyp'
  return false
}

export function fontIsComplete(buffer) {
  if (!buffer || buffer.length < 12) return false
  const tag = buffer.subarray(0, 4).toString('latin1')
  if (tag === 'wOF2' || tag === 'wOFF') return buffer.readUInt32BE(8) === buffer.length
  return tag === 'OTTO' || tag === 'true' || buffer.readUInt32BE(0) === 0x00010000
}

function dataUriBuffer(dataUri) {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUri)
  if (!match) return null
  try {
    return { mime: match[1], buffer: match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8') }
  } catch (_) {
    return null
  }
}

export function dataUriIsComplete(dataUri) {
  const parsed = dataUriBuffer(dataUri)
  return Boolean(parsed) && imageIsComplete(parsed.buffer, parsed.mime)
}

// Loopback, private, link-local, CGNAT and unspecified addresses.
const INTERNAL_ADDRESSES = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
])
  INTERNAL_ADDRESSES.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
])
  INTERNAL_ADDRESSES.addSubnet(network, prefix, 'ipv6')

// The IPv4 address inside an IPv4-mapped IPv6 address (::ffff:a.b.c.d, which
// URL parsing writes as ::ffff:xxxx:yyyy), or null.
function mappedIPv4(address) {
  let canonical
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  } catch {
    return null
  }
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical)
  if (!match) return null
  const high = parseInt(match[1], 16)
  const low = parseInt(match[2], 16)
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

// A URL hostname (IPv6 in brackets) that is loopback, private, link-local,
// CGNAT or an internal name. By name only: nothing is resolved. Trailing dots
// (`localhost.`) are ignored and IPv4-mapped IPv6 counts as its IPv4 address.
export function internalHostname(hostname) {
  let host = String(hostname).toLowerCase().replace(/\.+$/, '')
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  const family = isIP(host)
  if (family === 6) {
    const v4 = mappedIPv4(host)
    return v4 ? INTERNAL_ADDRESSES.check(v4, 'ipv4') : INTERNAL_ADDRESSES.check(host, 'ipv6')
  }
  if (family === 4) return INTERNAL_ADDRESSES.check(host, 'ipv4')
  return host === 'localhost' || /\.(internal|local|localhost|lan|home\.arpa|ts\.net)$/.test(host)
}

// ---- Links --------------------------------------------------------------------
// Links in the snapshot point at the capture base (often a local dev server).
// With a public URL configured they are rewritten to it; without one they stay
// as they are unless the capture base is itself a private host (links never
// navigate on the board anyway). Links to loopback, private, link-local, CGNAT
// and internal names are dropped, so no internal host leaks into a board you
// share.
export function createLinkRewriter({ from, to } = {}) {
  let source = null
  let target = null
  try {
    source = from ? new URL(from) : null
  } catch {
    source = null
  }
  try {
    target = to ? new URL(to) : null
  } catch {
    target = null
  }
  const prefix = source ? source.pathname.replace(/\/+$/, '') : ''
  const internal = (url) => internalHostname(url.hostname)
  return (href) => {
    let url
    try {
      url = new URL(href)
    } catch {
      return href
    }
    if (!/^https?:$/.test(url.protocol)) return href
    if (source && url.origin === source.origin) {
      if (!target) return internal(url) ? null : href
      let pathname = url.pathname
      if (prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`))) pathname = pathname.slice(prefix.length) || '/'
      return `${target.origin}${target.pathname.replace(/\/+$/, '')}${pathname}${url.search}${url.hash}`
    }
    return internal(url) ? null : href
  }
}

// ---- Build --------------------------------------------------------------------

function walk(node, visit) {
  visit(node)
  for (const child of node.childNodes || []) walk(child, visit)
  if (node.content) walk(node.content, visit)
}

function attr(node, name) {
  return (node.attrs || []).find((item) => item.name === name)?.value
}

function setAttr(node, name, value) {
  const existing = (node.attrs || []).find((item) => item.name === name)
  if (existing) existing.value = value
  else node.attrs.push({ name, value })
}

// Builds the sanitized document. `getBody(url, maxBytes)` returns
// { buffer, mimeType, expectedLength } for a response the page loaded, or null.
export async function buildLiveHtml(snapshot, { getBody, links } = {}) {
  const pageBase = snapshot.base
  const cssImages = snapshot.cssImages || {}
  const chunks = []
  let cssTotal = 0
  for (const chunk of snapshot.chunks || []) {
    let text = chunk.text
    if (text == null && chunk.href) {
      const body = await getBody(stripHash(chunk.href), CSS_SHEET_MAX).catch(() => null)
      text =
        body && body.buffer.length <= CSS_SHEET_MAX && (!body.expectedLength || body.expectedLength === body.buffer.length)
          ? body.buffer.toString('utf8')
          : ''
    }
    cssTotal += (text || '').length
    if (cssTotal > CSS_MAX) throw new Error('the page CSS is over the cap')
    chunks.push({ base: chunk.base || pageBase, text: text || '', media: chunk.media || '' })
  }
  const stats = { images: 0, imageBytes: 0, imagesDropped: 0, imagesRejected: 0, imagesShared: 0, fonts: 0, fontBytes: 0, fontsDropped: 0 }

  // Pass 1: the document's images (already re-encoded data: URIs, or URLs
  // the page could not read) and every remote URL the CSS references.
  const tree = parse(String(snapshot.html || ''))
  const imgNodes = []
  walk(tree, (node) => {
    if (node.tagName === 'img') imgNodes.push(node)
  })
  const wanted = []
  const seen = new Set()
  const collect = (url, kind) => {
    const key = stripHash(url)
    if (!seen.has(key)) {
      seen.add(key)
      wanted.push({ url: key, kind })
    }
    return null
  }
  for (const chunk of chunks) sanitizeCss(chunk.text, { base: chunk.base, resolveUrl: collect })
  for (const node of imgNodes) {
    const src = attr(node, 'src') || ''
    if (src && !src.startsWith('data:')) {
      try {
        collect(new URL(src, pageBase).href, 'image')
      } catch (_) {
        /* placeholder later */
      }
    }
  }

  // Pass 2: everything the page could not re-encode comes from the bodies,
  // only when complete. Re-encoded data from the page is checked too.
  const inlined = new Map()
  for (const item of wanted) {
    if (item.kind === 'image' && cssImages[item.url]) {
      if (dataUriIsComplete(cssImages[item.url])) inlined.set(item.url, cssImages[item.url])
      else stats.imagesRejected += 1
      continue
    }
    const body = await getBody(item.url, item.kind === 'font' ? FONT_MAX_EACH : BODY_MAX_EACH).catch(() => null)
    const lengthOk = body && (!body.expectedLength || body.expectedLength === body.buffer.length)
    const mime = String(body?.mimeType || '')
      .split(';')[0]
      .trim()
      .toLowerCase()
    if (item.kind === 'font') {
      if (!lengthOk || !fontIsComplete(body.buffer)) {
        stats.fontsDropped += 1
        continue
      }
      const fontMime = /^(font\/|application\/(font-|x-font-|vnd\.ms-fontobject|octet-stream))/.test(mime) ? mime : 'font/woff2'
      const fontUri = `data:${fontMime};base64,${body.buffer.toString('base64')}`
      if (fontUri.length > FONT_MAX_EACH * 1.37 || stats.fontBytes + fontUri.length > FONT_BUDGET * 1.37) {
        stats.fontsDropped += 1
        continue
      }
      stats.fonts += 1
      stats.fontBytes += fontUri.length
      inlined.set(item.url, fontUri)
      continue
    }
    if (!body || !mime.startsWith('image/')) {
      stats.imagesDropped += 1
      continue
    }
    if (!lengthOk || !imageIsComplete(body.buffer, mime)) {
      stats.imagesRejected += 1
      continue
    }
    inlined.set(item.url, `data:${mime};base64,${body.buffer.toString('base64')}`)
  }

  // Pass 3: the budget counts each distinct image once (identical images are
  // stored once below). Over budget, the largest go first.
  const distinct = new Map() // data URI -> size
  for (const node of imgNodes) {
    let src = attr(node, 'src') || ''
    if (src && !src.startsWith('data:')) {
      try {
        src = inlined.get(stripHash(new URL(src, pageBase).href)) || ''
      } catch (_) {
        src = ''
      }
      setAttr(node, 'src', src)
    }
    if (src.startsWith('data:') && src !== TRANSPARENT_GIF) {
      if (!dataUriIsComplete(src)) {
        stats.imagesRejected += 1
        setAttr(node, 'src', '')
        continue
      }
      distinct.set(src, src.length)
    }
  }
  for (const value of inlined.values()) if (value.startsWith('data:image/')) distinct.set(value, value.length)
  let total = [...distinct.values()].reduce((sum, size) => sum + size, 0)
  const dropped = new Set()
  for (const [value, size] of [...distinct.entries()].sort((a, b) => b[1] - a[1])) {
    if (total <= IMAGE_BUDGET) break
    dropped.add(value)
    total -= size
    stats.imagesDropped += 1
  }
  for (const node of imgNodes) {
    const src = attr(node, 'src') || ''
    if (!src || dropped.has(src)) setAttr(node, 'src', placeholderSvg(attr(node, 'data-sw-w'), attr(node, 'data-sw-h')))
  }
  for (const [url, value] of [...inlined]) if (dropped.has(value)) inlined.delete(url)
  stats.images = distinct.size - dropped.size
  stats.imageBytes = total
  const lookup = (url) => inlined.get(stripHash(url)) || null

  // Pass 4: one combined stylesheet, then the strict sanitize of the whole document.
  const css = chunks
    .map((chunk) => wrapMedia(sanitizeCss(chunk.text, { base: chunk.base, resolveUrl: lookup }), chunk.media))
    .concat(FRAME_RULES)
    .join('\n')
    .replace(/<\/(style)/gi, '<\\/$1')
  const prepared = serialize(tree)
  // Function replacements: page CSS may contain $& or $' and must stay literal.
  const withStyle = prepared.includes('</head>')
    ? prepared.replace('</head>', () => `<style>${css}</style></head>`)
    : prepared.replace(/<html[^>]*>/i, (open) => `${open}<head><style>${css}</style></head>`)
  const sanitized = sanitizeDocument(withStyle, {
    base: pageBase,
    resolveUrl: lookup,
    rewriteHref: links ? createLinkRewriter(links) : null,
  })
  const html = shareRepeatedImages(sanitized, stats)
  return { html, stats }
}

// Pass 5: an image used more than once is stored once, as a CSS rule
// (`content: url(...)` on the img, which keeps its intrinsic size), and each
// use points at it with a class. Applied after the sanitizer, to its output.
function shareRepeatedImages(html, stats) {
  const tree = parse(html)
  const uses = new Map()
  walk(tree, (node) => {
    if (node.tagName !== 'img') return
    const src = attr(node, 'src') || ''
    // Only plain base64 URIs are moved into CSS: their alphabet cannot close
    // the string, the url() or the style element.
    if (BASE64_IMAGE_RE.test(src) && src.length > 2048) uses.set(src, (uses.get(src) || 0) + 1)
  })
  const shared = new Map()
  for (const [src, count] of uses) if (count > 1) shared.set(src, `sw-img-${shared.size + 1}`)
  if (!shared.size) return html
  let head = null
  walk(tree, (node) => {
    if (node.tagName === 'head' && !head) head = node
    if (node.tagName !== 'img') return
    const className = shared.get(attr(node, 'src') || '')
    if (!className) return
    setAttr(node, 'src', TRANSPARENT_GIF)
    const existing = attr(node, 'class')
    setAttr(node, 'class', existing ? `${existing} ${className}` : className)
    stats.imagesShared += 1
  })
  const rules = [...shared].map(([src, className]) => `img.${className}{content:url("${src}")}`).join('\n')
  if (head) {
    const style = {
      nodeName: 'style',
      tagName: 'style',
      attrs: [],
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      childNodes: [],
      parentNode: head,
    }
    style.childNodes.push({ nodeName: '#text', value: rules, parentNode: style })
    head.childNodes.push(style)
  }
  return serialize(tree)
}

// The fourth lock: the document carries its own CSP, so even a copy opened
// outside Shapewall (a static export, a file on disk) cannot run script or
// load anything remote.
export const LIVE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"
export function withCspMeta(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${LIVE_CSP}">`
  return /<head>/i.test(html) ? html.replace(/<head>/i, () => `<head>${meta}`) : `${meta}${html}`
}

// Did this response, or any redirect hop that led to it, come from an
// internal host? At most 20 hops (browsers stop there too).
export async function responseTouchesInternal(response, isInternal) {
  try {
    if (await isInternal(response.url())) return true
    let request = response.request?.() || null
    for (let hops = 0; request && hops < 21; hops += 1) {
      if (await isInternal(request.url())) return true
      request = request.redirectedFrom?.() || null
    }
  } catch {
    // A response we cannot place is not inlined.
    return true
  }
  return false
}

// Snapshot a Playwright page and write the sanitized document. `responses`
// maps URL (without hash) -> Playwright Response, recorded while the page
// loaded. `isCancelled()` is true once the shot has timed out; then nothing is
// written. `isInternal(url)` is the private-host guard's answer (requests.js):
// a response that came from an internal host, or through a redirect chain
// that touched one, is never inlined (the browser does not route redirect
// hops, so the guard cannot stop those itself).
export async function writeLiveHtml({ page, responses, file, links, isCancelled = () => false, size = null, isInternal = null }) {
  const value = await page.evaluate(SNAPSHOT_EXPRESSION)
  if (value?.tooLarge) throw new Error(value.tooLarge)
  if (!value?.html) throw new Error('the page could not be snapshotted')
  const getBody = async (url, maxBytes) => {
    const response = responses.get(stripHash(url))
    // Only whole 200 responses.
    if (!response || isCancelled() || response.status() !== 200) return null
    if (isInternal && (await responseTouchesInternal(response, isInternal))) return null
    const headers = await response.allHeaders().catch(() => ({}))
    const declared = headers['content-length'] ? Number(headers['content-length']) : null
    if (maxBytes && Number.isFinite(declared) && declared > maxBytes) return null
    let timer = null
    let buffer
    try {
      buffer = await Promise.race([
        response.body().catch(() => null),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 5000)
        }),
      ])
    } finally {
      // One timer per asset: not left running 5 s after the body came.
      clearTimeout(timer)
    }
    if (!buffer || (maxBytes && buffer.length > maxBytes)) return null
    // Content-Length describes the body only when it was not compressed.
    const encoding = String(headers['content-encoding'] || '')
      .trim()
      .toLowerCase()
    const expectedLength = (!encoding || encoding === 'identity') && Number.isFinite(declared) ? declared : null
    const mimeType = String(headers['content-type'] || '')
      .split(';')[0]
      .trim()
    return { buffer, mimeType, expectedLength }
  }
  const built = await buildLiveHtml(value, { getBody, links })
  const html = withCspMeta(built.html)
  const bytes = Buffer.byteLength(html)
  if (bytes > FILE_MAX) throw new Error(`live HTML is ${(bytes / 1048576).toFixed(1)} MB, over the ${FILE_MAX / 1048576} MB cap`)
  if (isCancelled()) throw new Error('the shot timed out before the live HTML was written')
  // The element map comes from the document as written so far; then its
  // controls are made inert for the board (see INERT_RULES).
  const mapFile = elementMapFile(file)
  let elements = null
  if (mapFile) {
    try {
      const map = await buildElementMapFor({
        browser: page.context().browser(),
        html,
        size: size ? { width: size.width, height: size.height } : page.viewportSize(),
        isCancelled,
      })
      const text = JSON.stringify(map)
      if (text.length > ELEMENT_MAP_LIMITS.bytes) throw new Error('the element map is over its cap')
      elements = { map, text }
    } catch (error) {
      elements = { error: String(error?.message || error).split('\n')[0] }
    }
  }
  const written = elements?.map ? withInertControls(html) : html
  if (isCancelled()) throw new Error('the shot timed out before the live HTML was written')
  writeFileAtomic(file, written)
  if (mapFile) {
    if (elements?.map) writeFileAtomic(mapFile, elements.text)
    // A map from an older capture must not sit beside the new document.
    else fs.rmSync(mapFile, { force: true })
  }
  return {
    bytes: Buffer.byteLength(written),
    sha256: crypto.createHash('sha256').update(written).digest('hex'),
    stats: built.stats,
    elements: elements?.map
      ? { status: 'ok', count: elements.map.elements.length, ...(elements.map.truncated ? { truncated: true } : {}) }
      : elements
        ? { status: 'failed', error: elements.error.slice(0, 200) }
        : null,
  }
}

// ---- Element maps ---------------------------------------------------------------
// The map (element-map.js) is measured on the written document rendered the
// way the board renders it: a plain page (no mobile emulation: the board's
// frame is an iframe of the capture's native size), device scale 1, nothing
// else loaded. The document allows no script (its CSP); the measuring runs
// through the DevTools protocol.

export const elementMapFile = (htmlFile) =>
  String(htmlFile).endsWith('.html') ? String(htmlFile).replace(/\.html$/, '.elements.json') : null

const MAP_TIMEOUT_MS = 20000

export async function buildElementMapFor({ browser, html, size, isCancelled = () => false }) {
  if (!browser) throw new Error('no browser for the element map')
  if (!size?.width || !size?.height) throw new Error('no viewport size for the element map')
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    // Nothing leaves the page: the document is self-contained.
    offline: true,
  })
  let timer = null
  try {
    const work = (async () => {
      const page = await context.newPage()
      await page.setContent(html, { waitUntil: 'load', timeout: MAP_TIMEOUT_MS })
      // Fonts and images (all data: URIs) decoded, as on the board once loaded.
      await page.evaluate(async () => {
        await Promise.all(Array.from(document.images).map((image) => (image.decode ? image.decode().catch(() => {}) : null)))
        if (document.fonts?.ready) await document.fonts.ready
      })
      if (isCancelled()) throw new Error('cancelled')
      return cleanElementMap(await page.evaluate(ELEMENT_MAP_EXPRESSION))
    })()
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('the element map timed out')), MAP_TIMEOUT_MS + 5000)
    })
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
    await context.close().catch(() => {})
  }
}

// With an element map the board never touches the frame's DOM, so it can
// no longer stop a click on a link (which would navigate the frame) or a
// summary (which would change the layout under the map) while text is being
// selected. These controls take no pointer events instead; the text still
// selects. Only in documents that have a map: without one the local board
// reads the DOM and needs them hit-testable.
export const INERT_RULES =
  'a[href],area[href],button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem]{pointer-events:none!important}'
export function withInertControls(html) {
  const style = `<style>${INERT_RULES}</style>`
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => `${style}</head>`) : `${style}${html}`
}
