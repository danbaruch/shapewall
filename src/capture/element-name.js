// What a person would call an element: a short kind and, when it helps, a
// short name ("Card · Free", "Heading · Simple pricing", "Button · Start
// free", "Navigation · Main", "Paragraph"). The hover label, the composer's
// "Commenting on ...", a thread's "Pinned to ..." and the comment chips all
// say it the same way. A container is named by its own heading or label,
// never by the text of everything inside it.
//
// Pure: no DOM, no Node. The element map (element-map.js), the DOM fallback
// (client/src/board/anchors.js) and stored anchors each gather the facts and
// call elementName().

export const NAME_MAX = 28
// A text block (a paragraph, a list item) is named by its words only when
// they are this short; past that its kind says enough.
export const SHORT_TEXT = 40
export const NAME_SEPARATOR = ' · '

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
// Tags whose words run inline in a block: a hover on them means the block.
export const INLINE_TAGS = new Set([
  'span',
  'small',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'mark',
  'code',
  'kbd',
  'time',
  'abbr',
  'sub',
  'sup',
  'cite',
  'q',
  'del',
  'ins',
  'br',
  'wbr',
  'font',
])

// ARIA roles first: an explicit role says what the author meant.
const ROLE_KINDS = {
  button: 'Button',
  link: 'Link',
  tab: 'Tab',
  menuitem: 'Menu item',
  menuitemcheckbox: 'Menu item',
  menuitemradio: 'Menu item',
  option: 'Option',
  checkbox: 'Checkbox',
  radio: 'Radio button',
  switch: 'Switch',
  textbox: 'Input',
  searchbox: 'Search field',
  combobox: 'Select',
  listbox: 'List',
  slider: 'Slider',
  navigation: 'Navigation',
  banner: 'Header',
  contentinfo: 'Footer',
  main: 'Main',
  complementary: 'Sidebar',
  region: 'Section',
  search: 'Search',
  form: 'Form',
  dialog: 'Dialog',
  alertdialog: 'Dialog',
  alert: 'Alert',
  status: 'Status',
  img: 'Image',
  heading: 'Heading',
  list: 'List',
  listitem: 'List item',
  tablist: 'Tabs',
  tabpanel: 'Tab panel',
  menu: 'Menu',
  menubar: 'Menu',
  table: 'Table',
  grid: 'Table',
  row: 'Row',
  cell: 'Cell',
  gridcell: 'Cell',
  article: 'Article',
  figure: 'Figure',
  tooltip: 'Tooltip',
  progressbar: 'Progress bar',
}

const TAG_KINDS = {
  a: 'Link',
  button: 'Button',
  summary: 'Button',
  details: 'Accordion',
  img: 'Image',
  picture: 'Image',
  svg: 'Icon',
  video: 'Video',
  audio: 'Audio',
  canvas: 'Canvas',
  iframe: 'Embed',
  textarea: 'Text area',
  select: 'Select',
  option: 'Option',
  label: 'Label',
  p: 'Paragraph',
  blockquote: 'Quote',
  pre: 'Code',
  li: 'List item',
  ul: 'List',
  ol: 'List',
  dl: 'List',
  dt: 'Term',
  dd: 'Text',
  table: 'Table',
  thead: 'Table',
  tbody: 'Table',
  tr: 'Row',
  td: 'Cell',
  th: 'Column header',
  form: 'Form',
  fieldset: 'Group',
  legend: 'Label',
  nav: 'Navigation',
  header: 'Header',
  footer: 'Footer',
  main: 'Main',
  aside: 'Sidebar',
  section: 'Section',
  article: 'Article',
  figure: 'Figure',
  figcaption: 'Caption',
  dialog: 'Dialog',
  hr: 'Divider',
  progress: 'Progress bar',
}

const INPUT_KINDS = {
  checkbox: 'Checkbox',
  radio: 'Radio button',
  submit: 'Button',
  button: 'Button',
  reset: 'Button',
  image: 'Button',
  range: 'Slider',
  file: 'File input',
  search: 'Search field',
  color: 'Color input',
}

// Kinds named by their own words (a button's label, a heading's text).
const WORDY = new Set(['Heading', 'Button', 'Link', 'Tab', 'Menu item', 'Option', 'Label', 'Term', 'Column header', 'Caption'])
// Kinds named only when their words are short (a paragraph is not its text).
const TEXTY = new Set(['Paragraph', 'Text', 'List item', 'Cell', 'Quote', 'Row', 'Status', 'Alert', 'Tooltip'])
// Containers: named by their own heading or label, never by what is inside.
const CONTAINERS = new Set([
  'Group',
  'Card',
  'Section',
  'Article',
  'Main',
  'Sidebar',
  'Header',
  'Footer',
  'Navigation',
  'Form',
  'Dialog',
  'List',
  'Table',
  'Figure',
  'Search',
  'Accordion',
  'Tabs',
  'Tab panel',
  'Menu',
])

export const collapse = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()

// Cut at a word boundary, with an ellipsis, so a name never ends mid-word.
export function shorten(text, max = NAME_MAX) {
  const words = collapse(text)
  if (words.length <= max) return words
  const cut = words.slice(0, max)
  // The cut ends on a whole word when a space or a stop comes right after it.
  const space = /[\s,;:.!?]/.test(words[max]) ? max : cut.lastIndexOf(' ')
  const head = (space >= max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:.!?·-]+$/, '')
  return `${head}…`
}

// The kind of an element from its tag, role and (inputs) type. `container`
// facts decide what a plain <div> is: a card or a section when it has its
// own heading, text when it only holds words, else a group.
export function elementKind({ tag = '', role = '', type = '', heading = '', headingLevel = 0, leaf = false, text = '' } = {}) {
  const roleKind = ROLE_KINDS[String(role).trim().split(/\s+/)[0]?.toLowerCase()]
  if (roleKind) return roleKind
  const name = String(tag).toLowerCase()
  if (HEADINGS.has(name)) return 'Heading'
  if (name === 'input') return INPUT_KINDS[String(type).toLowerCase()] || 'Input'
  if (TAG_KINDS[name]) return TAG_KINDS[name]
  if (INLINE_TAGS.has(name)) return 'Text'
  // A <div>, a custom element or anything else.
  if (heading) return headingLevel && headingLevel <= 2 ? 'Section' : 'Card'
  if (leaf && collapse(text)) return 'Text'
  return name ? 'Group' : 'Element'
}

// The facts about one element:
//   tag, role, type        what it is
//   label                  aria-label (or aria-labelledby's words)
//   alt, title             an image's alt, any title attribute
//   placeholder, field     an input's placeholder and its <label>'s words
//   value                  a submit input's value
//   text                   its own words (all of its text, collapsed)
//   heading, headingLevel  a container's own heading (ownHeading())
//   leaf                   it holds words but no block children
// Returns { kind, name, text }: text is "Kind · Name", or the kind alone.
export function elementName(facts = {}) {
  const kind = elementKind(facts)
  const label = collapse(facts.label)
  const field = collapse(facts.field)
  const alt = collapse(facts.alt)
  const placeholder = collapse(facts.placeholder)
  const title = collapse(facts.title)
  const words = collapse(facts.text)
  const heading = collapse(facts.heading)
  let name = ''
  if (label) name = label
  else if (kind === 'Image' || kind === 'Icon') name = alt || title
  else if (kind === 'Input' || kind === 'Text area' || kind === 'Select' || kind === 'Search field' || kind === 'Checkbox' || kind === 'Radio button' || kind === 'Switch' || kind === 'Slider' || kind === 'File input')
    name = field || placeholder || title || (kind === 'Checkbox' || kind === 'Radio button' || kind === 'Switch' ? words : '')
  else if (CONTAINERS.has(kind)) name = heading || title
  else if (WORDY.has(kind)) name = words || collapse(facts.value) || alt || title
  else if (TEXTY.has(kind)) name = words.length <= SHORT_TEXT ? words : ''
  else name = words.length <= SHORT_TEXT ? words : title
  const short = name ? shorten(name) : ''
  return { kind, name: short, text: short ? `${kind}${NAME_SEPARATOR}${short}` : kind }
}

// A container's own heading, from the headings inside it in document order
// ([{ level, text }]): the highest-level one, when it is the first heading
// and the only one at its level. Three cards' <h3>s name no grid; one card's
// <h3> names that card; a section's <h1> beats the cards under it.
export function ownHeading(headings) {
  const list = (headings || []).filter((item) => item && item.level >= 1 && item.level <= 6 && collapse(item.text))
  if (!list.length) return null
  const top = Math.min(...list.map((item) => item.level))
  const atTop = list.filter((item) => item.level === top)
  if (atTop.length !== 1 || list[0] !== atTop[0]) return null
  return { level: top, text: collapse(atTop[0].text) }
}

export const headingLevel = (tag) => (HEADINGS.has(String(tag)) ? Number(String(tag).slice(1)) : 0)

// A stored anchor ({ selector, text }) named without the page: the last
// selector step gives the tag (and an aria-label when the step has one), the
// stored text names wordy elements. A container's stored text is everything
// inside it, so it names nothing.
export function anchorName(anchor) {
  if (!anchor) return null
  const step = String(anchor.selector || '')
    .split(' > ')
    .pop()
  const tag = /^([a-z][a-z0-9-]*)/.exec(step)?.[1] || ''
  const label = /\[aria-label="((?:[^"\\]|\\.)*)"\]/.exec(step)?.[1]?.replace(/\\(.)/g, '$1') || ''
  const text = collapse(anchor.text)
  if (!tag) {
    // An #id step: no tag to go on. Its words when short, else the id in words.
    const id = /^#(.+)$/.exec(step)?.[1] || ''
    const words =
      text && text.length <= SHORT_TEXT
        ? text
        : id
            .replace(/\\(.)/g, '$1')
            .replace(/[-_]+/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .trim()
    const short = words ? shorten(words) : ''
    return short ? `Element${NAME_SEPARATOR}${short}` : 'Element'
  }
  const facts = { tag, label, text, leaf: !CONTAINER_TAGS.has(tag) }
  if (tag === 'img') facts.alt = text
  if (tag === 'input' || tag === 'textarea' || tag === 'select') facts.placeholder = text
  return elementName(facts).text
}

const CONTAINER_TAGS = new Set(['div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav', 'form', 'ul', 'ol', 'table', 'figure'])
