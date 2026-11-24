// A tiny, dependency-free highlighter for chat code blocks: comments,
// strings, numbers, keywords and markup tags, plus added and removed lines
// in a diff. It never builds HTML: it splits the text into typed pieces
// that the code block renders as React elements. Good enough to read a
// snippet at a glance, not a parser; unknown languages still get strings,
// numbers and comments.

const KEYWORDS = new Set(
  (
    'abstract and as async await break case catch class const continue def default defer del do elif else enum except export extends ' +
    'false finally fn for from func function go if impl import in instanceof interface is lambda let loop match mod mut new nil none ' +
    'not null of or package pass private protected pub public raise return self static struct super switch then this throw true try ' +
    'type typeof undefined use var void where while with yield fi done esac echo local readonly select insert update delete create ' +
    'table into values set drop alter and important'
  ).split(' '),
)

const HASH_COMMENTS = new Set([
  'sh',
  'bash',
  'zsh',
  'shell',
  'console',
  'py',
  'python',
  'rb',
  'ruby',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'dockerfile',
  'make',
  'makefile',
  'r',
  'perl',
  'pl',
  'nginx',
  'caddyfile',
])
const MARKUP = new Set(['html', 'htm', 'xml', 'svg', 'vue', 'svelte', 'jsx', 'tsx', 'astro'])
const DIFF = new Set(['diff', 'patch'])
const SQL = new Set(['sql', 'psql', 'sqlite', 'mysql'])
export const LANG_NAMES = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TSX',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  sh: 'Shell',
  bash: 'Bash',
  zsh: 'Zsh',
  shell: 'Shell',
  console: 'Terminal',
  py: 'Python',
  python: 'Python',
  rb: 'Ruby',
  ruby: 'Ruby',
  go: 'Go',
  rs: 'Rust',
  rust: 'Rust',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  md: 'Markdown',
  markdown: 'Markdown',
  sql: 'SQL',
  diff: 'Diff',
  patch: 'Diff',
  xml: 'XML',
  svg: 'SVG',
  vue: 'Vue',
  svelte: 'Svelte',
  php: 'PHP',
  java: 'Java',
  kt: 'Kotlin',
  kotlin: 'Kotlin',
  swift: 'Swift',
  c: 'C',
  cpp: 'C++',
  cs: 'C#',
  dockerfile: 'Dockerfile',
  txt: 'Text',
  text: 'Text',
  plaintext: 'Text',
}

export const langName = (lang) => {
  const key = String(lang || '').toLowerCase()
  if (!key) return 'Code'
  return LANG_NAMES[key] || key.slice(0, 24)
}

const MAX_HIGHLIGHT = 40000

// [{ type: 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'tag' | 'add' | 'del' | 'meta', text }]
export function highlight(code, lang) {
  const text = String(code || '')
  const key = String(lang || '').toLowerCase()
  if (!text || text.length > MAX_HIGHLIGHT || ['txt', 'text', 'plaintext'].includes(key)) return [{ type: 'plain', text }]
  if (DIFF.has(key)) {
    return text.split('\n').map((line) => ({
      line: true,
      type: /^\+(?!\+\+)/.test(line)
        ? 'add'
        : /^-(?!--)/.test(line)
          ? 'del'
          : /^(@@|\+\+\+|---|diff |index )/.test(line)
            ? 'meta'
            : 'plain',
      text: line,
    }))
  }
  const hash = HASH_COMMENTS.has(key)
  const sql = SQL.has(key)
  const parts = [
    String.raw`\/\*[\s\S]*?(?:\*\/|$)`,
    String.raw`<!--[\s\S]*?(?:-->|$)`,
    hash ? String.raw`(?<![\w$&])#(?![!{]).*` : String.raw`(?<![:\w])\/\/.*`,
    sql ? String.raw`--.*` : null,
    String.raw`"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|` + '`(?:[^`\\\\]|\\\\.)*`?',
    MARKUP.has(key) ? String.raw`<\/?[A-Za-z][\w:.-]*|\/?>` : null,
    String.raw`\b(?:0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b|#[\da-fA-F]{3,8}\b`,
    String.raw`[A-Za-z_$][\w$]*`,
  ].filter(Boolean)
  const re = new RegExp(parts.map((part) => `(${part})`).join('|'), 'g')
  const types = [
    'comment',
    'comment',
    'comment',
    ...(sql ? ['comment'] : []),
    'string',
    ...(MARKUP.has(key) ? ['tag'] : []),
    'number',
    'word',
  ]
  const out = []
  let last = 0
  const push = (type, value) => {
    if (!value) return
    const prev = out.at(-1)
    if (prev && prev.type === type) prev.text += value
    else out.push({ type, text: value })
  }
  for (const match of text.matchAll(re)) {
    if (!match[0]) continue
    push('plain', text.slice(last, match.index))
    const group = match.slice(1).findIndex((value) => value !== undefined)
    let type = types[group]
    if (type === 'word') type = KEYWORDS.has(sql ? match[0].toLowerCase() : match[0]) ? 'keyword' : 'plain'
    push(type, match[0])
    last = match.index + match[0].length
  }
  push('plain', text.slice(last))
  return out
}
