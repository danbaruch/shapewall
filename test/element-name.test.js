// What a person calls an element (src/capture/element-name.js): the hover
// label, the composer's "Commenting on", a thread's "Pinned to" and the
// comment chips all use it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anchorName, elementName, ownHeading, shorten } from '../src/capture/element-name.js'

test('elementName: a short kind and, when it helps, a short name', () => {
  const cases = [
    // [facts, expected, why]
    [{ tag: 'div', text: 'Free $0 forever 1 device Unlimited notes', heading: 'Free', headingLevel: 3 }, 'Card · Free', 'a card, by its heading'],
    [{ tag: 'div', text: 'Simple pricing Start free', heading: 'Simple pricing', headingLevel: 1 }, 'Section · Simple pricing', 'a top-level block'],
    [{ tag: 'div', text: 'Lumen Notes Features Pricing Templates Blog Sign in' }, 'Group', 'a wrapper never dumps its text'],
    [{ tag: 'section', text: 'Everything in one calm place Three things', heading: 'Everything in one calm place, always', headingLevel: 2 }, 'Section · Everything in one calm place…', 'cut at a word'],
    [{ tag: 'p', text: 'Start free. Upgrade when your notes outgrow one device. Pay yearly and save 17%.' }, 'Paragraph', 'a long paragraph'],
    [{ tag: 'p', text: 'Yes.' }, 'Paragraph · Yes.', 'a short one'],
    [{ tag: 'h1', text: 'Simple pricing' }, 'Heading · Simple pricing', ''],
    [{ tag: 'h2', text: 'Notes that keep up with how you think, every single day' }, 'Heading · Notes that keep up with how…', ''],
    [{ tag: 'button', text: 'Start free' }, 'Button · Start free', ''],
    [{ tag: 'a', text: 'Reading list' }, 'Link · Reading list', ''],
    [{ tag: 'a', label: 'Open menu', text: 'Menu' }, 'Link · Open menu', 'aria-label first'],
    [{ tag: 'div', role: 'button', text: 'Save' }, 'Button · Save', 'ARIA role beats the tag'],
    [{ tag: 'img', alt: 'A calm desk' }, 'Image · A calm desk', ''],
    [{ tag: 'img', alt: '' }, 'Image', ''],
    [{ tag: 'svg', label: 'Search' }, 'Icon · Search', ''],
    [{ tag: 'nav', label: 'Main', text: 'Features Pricing' }, 'Navigation · Main', ''],
    [{ tag: 'nav', text: 'Features Pricing' }, 'Navigation', ''],
    [{ tag: 'header', text: 'Lumen Notes Features' }, 'Header', ''],
    [{ tag: 'footer', text: 'Lumen Notes is fictional' }, 'Footer', ''],
    [{ tag: 'div', role: 'banner', text: 'x' }, 'Header', 'a landmark role'],
    [{ tag: 'form', heading: 'Sign in', headingLevel: 2, text: 'Sign in Email Password' }, 'Form · Sign in', ''],
    [{ tag: 'form', label: 'Newsletter' }, 'Form · Newsletter', ''],
    [{ tag: 'input', type: 'email', field: 'Email', placeholder: 'you@example.com' }, 'Input · Email', 'its <label> first'],
    [{ tag: 'input', placeholder: 'Search notes' }, 'Input · Search notes', 'then its placeholder'],
    [{ tag: 'input', type: 'checkbox', field: 'Remember me' }, 'Checkbox · Remember me', ''],
    [{ tag: 'input', type: 'submit', value: 'Send' }, 'Button · Send', ''],
    [{ tag: 'textarea', field: 'Message' }, 'Text area · Message', ''],
    [{ tag: 'select', field: 'Plan' }, 'Select · Plan', ''],
    [{ tag: 'li', text: 'Unlimited notes' }, 'List item · Unlimited notes', ''],
    [{ tag: 'ul', text: '1 device Unlimited notes Basic search' }, 'List', ''],
    [{ tag: 'summary', text: 'Can I cancel any time?' }, 'Button · Can I cancel any time?', ''],
    [{ tag: 'details', text: 'Can I cancel any time? Yes.' }, 'Accordion', ''],
    [{ tag: 'div', text: '$0 forever', leaf: true }, 'Text · $0 forever', 'a block that only holds words'],
    [{ tag: 'span', text: 'New: templates' }, 'Text · New: templates', ''],
    [{ tag: 'my-widget', text: 'Things inside' }, 'Group', 'a custom element'],
    [{ tag: 'hr' }, 'Divider', ''],
    [{}, 'Element', 'nothing known'],
  ]
  for (const [facts, want, why] of cases) assert.equal(elementName(facts).text, want, why || want)
  assert.deepEqual(elementName({ tag: 'a', text: 'Pricing' }), { kind: 'Link', name: 'Pricing', text: 'Link · Pricing' })
})

test('shorten: at a word boundary, never mid-word, with an ellipsis', () => {
  assert.equal(shorten('Simple pricing'), 'Simple pricing')
  assert.equal(shorten('Notes that keep up with how you think'), 'Notes that keep up with how…')
  assert.equal(shorten('  spaced   out\nwords '), 'spaced out words')
  assert.equal(shorten('Supercalifragilisticexpialidocious-words', 20), 'Supercalifragilistic…')
  assert.equal(shorten('One, two, three, four, five, six', 18), 'One, two, three…')
})

test('ownHeading: the first, only heading at the highest level inside', () => {
  assert.deepEqual(ownHeading([{ level: 3, text: 'Free' }]), { level: 3, text: 'Free' })
  assert.equal(ownHeading([{ level: 3, text: 'Free' }, { level: 3, text: 'Plus' }]), null, 'a grid of cards')
  assert.deepEqual(ownHeading([{ level: 1, text: 'Pricing' }, { level: 3, text: 'Free' }, { level: 3, text: 'Plus' }]), { level: 1, text: 'Pricing' })
  assert.equal(ownHeading([{ level: 3, text: 'Free' }, { level: 2, text: 'Later' }]), null, 'the top heading is not first')
  assert.equal(ownHeading([]), null)
  assert.equal(ownHeading([{ level: 2, text: '  ' }]), null)
})

test('anchorName: a stored anchor named without the page', () => {
  const cases = [
    [{ selector: 'a[data-testid="plus-cta"]', text: 'Try Plus free' }, 'Link · Try Plus free'],
    [{ selector: 'main:nth-of-type(1) > h1:nth-of-type(1)', text: 'Simple pricing' }, 'Heading · Simple pricing'],
    [{ selector: 'div:nth-of-type(2) > div:nth-of-type(1)', text: 'Free $0 forever 1 device Unlimited notes' }, 'Group'],
    [{ selector: 'section:nth-of-type(1)', text: 'Simple pricing Start free' }, 'Section'],
    [{ selector: 'nav[aria-label="Main"]', text: 'Features Pricing' }, 'Navigation · Main'],
    [{ selector: 'button[aria-label="Open \\"menu\\""]', text: 'Menu' }, 'Button · Open "menu"'],
    [{ selector: 'p:nth-of-type(1)', text: 'Start free. Upgrade when your notes outgrow one device.' }, 'Paragraph'],
    [{ selector: 'img:nth-of-type(1)', text: 'Logo' }, 'Image · Logo'],
    [{ selector: 'input:nth-of-type(1)', text: 'Email' }, 'Input · Email'],
    [{ selector: '#hero-title', text: '' }, 'Element · hero title'],
    [{ selector: '#hero', text: 'Notes' }, 'Element · Notes'],
  ]
  for (const [anchor, want] of cases) assert.equal(anchorName(anchor), want, anchor.selector)
  assert.equal(anchorName(null), null)
})
