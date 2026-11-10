// A small Markdown renderer for chat replies. It builds React elements (never
// HTML strings), so model output cannot inject markup or script. Covers what
// models write: paragraphs, headings, lists, quotes, fenced code, tables,
// rules, and inline code, bold, italics, strikethrough and links. An open
// code fence (mid-stream) renders as code until it closes.
//
// Inside the chat panel (RefsContext), references to the board become chips
// (refs.js): [[comment:12]]-style tokens, "#12", a page's path, and an exact
// page title or journey name in code or bold, only for things the board has.
// Code blocks get a language label and a Copy button (CodeBlock.jsx).

import { Fragment, useMemo } from 'react'
import CodeBlock from './CodeBlock'
import { RefChip, useRefs } from './RefChip'
import { plainToken, resolveName, resolvePath, resolveToken } from './refs'

function safeHref(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\[\[(comment|page|journey|check):([A-Za-z0-9][A-Za-z0-9:_./-]{0,119})\]\]|(?<![\w&#/])#(\d{1,9})\b|(?<![\w/.:~-])(\/[A-Za-z0-9](?:[\w\-./]*[\w/])?)/g

// `refs`: the board's reference index (refs.js buildRefIndex), or null.
export function renderInline(text, keyPrefix = 'i', refs = null) {
  const out = []
  let last = 0
  let index = 0
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const key = `${keyPrefix}-${index++}`
    const named = (value) => (refs ? resolveName(refs, value) : null)
    if (match[2] !== undefined) {
      const ref = named(match[2])
      out.push(
        ref ? (
          <RefChip key={key} item={ref} className="font-mono">
            {match[2]}
          </RefChip>
        ) : (
          <code key={key} className="rounded bg-surface-2 px-1 py-px font-mono text-[0.9em]">
            {match[2]}
          </code>
        ),
      )
    } else if (match[3] !== undefined || match[4] !== undefined) {
      const ref = named(match[3] ?? match[4])
      out.push(
        ref ? (
          <RefChip key={key} item={ref}>
            {match[3] ?? match[4]}
          </RefChip>
        ) : (
          <strong key={key}>{renderInline(match[3] ?? match[4], key, refs)}</strong>
        ),
      )
    } else if (match[5] !== undefined) {
      out.push(<del key={key}>{renderInline(match[5], key, refs)}</del>)
    } else if (match[6] !== undefined || match[7] !== undefined) {
      out.push(<em key={key}>{renderInline(match[6] ?? match[7], key, refs)}</em>)
    } else if (match[8] !== undefined) {
      const href = safeHref(match[9])
      out.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2">
            {renderInline(match[8], key)}
          </a>
        ) : (
          <Fragment key={key}>{match[0]}</Fragment>
        ),
      )
    } else if (match[10] !== undefined) {
      const href = safeHref(match[10])
      out.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener" className="break-all text-accent underline underline-offset-2">
            {match[10]}
          </a>
        ) : (
          match[10]
        ),
      )
    } else if (match[11] !== undefined) {
      // A token from the agent: a chip when the board has it, else plain text.
      const ref = resolveToken(refs, match[11], match[12])
      out.push(ref ? <RefChip key={key} item={ref} /> : plainToken(match[11], match[12]))
    } else if (match[13] !== undefined) {
      const ref = resolveToken(refs, 'comment', match[13])
      out.push(ref ? <RefChip key={key} item={ref} /> : match[0])
    } else if (match[14] !== undefined) {
      const ref = resolvePath(refs, match[14])
      out.push(
        ref ? (
          <RefChip key={key} item={ref} className="font-mono">
            {match[14]}
          </RefChip>
        ) : (
          match[0]
        ),
      )
    }
    last = match.index + match[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line)
const isTableRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim())

// Splits Markdown into blocks: { type, ... }.
export function parseBlocks(source) {
  const lines = String(source || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = /^\s*(```|~~~)\s*([\w+.-]*)/.exec(line)
    if (fence) {
      const body = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i += 1
      blocks.push({ type: 'code', lang: fence[2], text: body.join('\n') })
      continue
    }
    if (!line.trim()) {
      i += 1
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].replace(/\s+#+\s*$/, '') })
      i += 1
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'rule' })
      i += 1
      continue
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      const head = cells(line)
      const rows = []
      i += 2
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]))
      blocks.push({ type: 'table', head, rows })
      continue
    }
    if (/^\s*>/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push({ type: 'quote', blocks: parseBlocks(body.join('\n')) })
      continue
    }
    const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line)
    if (item) {
      const ordered = /\d/.test(item[2])
      const items = []
      const indent = item[1].length
      while (i < lines.length) {
        const next = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i])
        if (next && next[1].length <= indent + 1 && /\d/.test(next[2]) === ordered) {
          items.push([next[3]])
          i += 1
        } else if (lines[i].trim() && items.length && (/^\s{2,}/.test(lines[i]) || next)) {
          // Continuation lines and nested lists belong to the last item.
          items.at(-1).push(lines[i].replace(/^\s{2,4}/, ''))
          i += 1
        } else break
      }
      blocks.push({
        type: 'list',
        ordered,
        start: ordered ? parseInt(item[2], 10) : 1,
        items: items.map((body) => parseBlocks(body.join('\n'))),
      })
      continue
    }
    const body = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d{1,9}[.)])\s)/.test(lines[i]) &&
      !(isTableRow(lines[i]) && isTableRule(lines[i + 1] || ''))
    ) {
      body.push(lines[i++])
    }
    if (!body.length) body.push(lines[i++])
    blocks.push({ type: 'paragraph', text: body.join('\n') })
  }
  return blocks
}

const HEADINGS = { 1: 'text-base', 2: 'text-[15px]', 3: 'text-sm', 4: 'text-sm', 5: 'text-[13px]', 6: 'text-[13px]' }

function Block({ block, id }) {
  const context = useRefs()
  const refs = context?.index || null
  switch (block.type) {
    case 'code':
      return <CodeBlock lang={block.lang} text={block.text} touch={Boolean(context?.touch)} />
    case 'heading': {
      const Tag = `h${Math.min(block.level + 2, 6)}`
      return <Tag className={`${HEADINGS[block.level]} font-semibold text-fg`}>{renderInline(block.text, id, refs)}</Tag>
    }
    case 'rule':
      return <hr className="border-line" />
    case 'quote':
      return (
        <blockquote className="space-y-2 border-l-2 border-line pl-3 text-muted">
          {block.blocks.map((child, index) => (
            <Block key={index} block={child} id={`${id}-${index}`} />
          ))}
        </blockquote>
      )
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag
          className={block.ordered ? 'list-decimal space-y-1 pl-5' : 'list-disc space-y-1 pl-5'}
          start={block.ordered && block.start !== 1 ? block.start : undefined}
        >
          {block.items.map((children, index) => (
            <li key={index} className="space-y-1.5 pl-0.5">
              {children.map((child, childIndex) =>
                child.type === 'paragraph' ? (
                  <p key={childIndex} className="whitespace-pre-wrap">
                    {renderInline(child.text, `${id}-${index}-${childIndex}`, refs)}
                  </p>
                ) : (
                  <Block key={childIndex} block={child} id={`${id}-${index}-${childIndex}`} />
                ),
              )}
            </li>
          ))}
        </Tag>
      )
    }
    case 'table':
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr>
                {block.head.map((cell, index) => (
                  <th key={index} className="border border-line bg-surface-2 px-2 py-1 text-left font-semibold">
                    {renderInline(cell, `${id}-h${index}`, refs)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td key={index} className="border border-line px-2 py-1 align-top">
                      {renderInline(cell, `${id}-${rowIndex}-${index}`, refs)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    default:
      return <p className="whitespace-pre-wrap">{renderInline(block.text, id, refs)}</p>
  }
}

export default function Markdown({ text, className }) {
  const blocks = useMemo(() => parseBlocks(text), [text])
  return (
    <div className={className} data-sw-markdown="true">
      {blocks.map((block, index) => (
        <Block key={index} block={block} id={`b${index}`} />
      ))}
    </div>
  )
}

// Plain text for reading aloud: no code, no markup. With lines, each block
// (paragraph, list item, heading) stays on its own line, so the natural voice
// can pause between them even when they have no full stop.
export function speakableText(text, { lines = false } = {}) {
  const plain = String(text || '')
    .replace(/```[\s\S]*?(```|$)/g, ' (code) ')
    // Board references (refs.js): "comment 12", or the page's id.
    .replace(/\[\[comment:(\d{1,9})\]\]/g, 'comment $1')
    .replace(/\[\[(?:page|journey|check):([^\]\s]{1,120})\]\]/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/https?:\/\/\S+/g, 'link')
  if (!lines) return plain.replace(/\s+/g, ' ').trim()
  return plain
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}
