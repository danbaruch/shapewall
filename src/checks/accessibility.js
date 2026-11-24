import axe from 'axe-core'

export const AXE_VERSION = axe.version
export const ACCESSIBILITY_MAX_ELEMENTS = 10000
const KNOWN_RULES = new Set(
  axe
    .getRules()
    .map((rule) => rule.ruleId)
    .filter((id) => /^[a-z][a-z0-9-]{0,55}$/.test(id)),
)
const LIMIT = 60
const RULE_TITLES = {
  'button-name': 'Button accessible name is missing',
  'link-name': 'Link accessible name is missing',
  label: 'Form control accessible label is missing',
  'image-alt': 'Image alternative text needs review',
  'color-contrast': 'Text contrast needs review',
  'html-has-lang': 'Document language is missing',
  'document-title': 'Document title is missing',
  'target-size': 'Control target size or spacing needs review',
  'aria-allowed-attr': 'ARIA attribute is not supported on this element',
  'aria-valid-attr-value': 'ARIA attribute value is invalid',
  'aria-roles': 'ARIA role is invalid',
  'aria-required-children': 'Required ARIA child structure is missing',
  'aria-required-parent': 'Required ARIA parent structure is missing',
}
const count = (value) => (Number.isInteger(value) && value >= 0 ? Math.min(value, 100000) : 0)

export function accessibilityFindings(result) {
  if (
    !Array.isArray(result?.violations) ||
    result.violations.length > 120 ||
    ['incompleteRules', 'passedRules', 'scannedElements'].some(
      (key) => !Number.isInteger(result[key]) || result[key] < 0 || result[key] > 100000,
    ) ||
    result.violations.some((rule) => !KNOWN_RULES.has(rule.id) || !Number.isInteger(rule.count) || rule.count < 0 || rule.count > 100000)
  )
    throw new Error('The accessibility engine returned an unsupported result shape.')
  const violations = (Array.isArray(result?.violations) ? result.violations : []).filter((rule) => KNOWN_RULES.has(rule.id))
  const findings = violations.slice(0, LIMIT).map((rule) => ({
    id: `axe-${rule.id}`,
    category: 'accessibility',
    severity: ['critical', 'serious'].includes(rule.impact) ? 'warning' : 'advisory',
    title: RULE_TITLES[rule.id] || `Accessibility rule ${rule.id} needs review`,
    observation: `Rule ${rule.id} reported ${count(rule.count)} affected elements.`,
    impact: 'Some users may be unable to perceive or operate this page. Automated checks do not establish accessibility compliance.',
    nextAction:
      'Review this engine rule on the original page, fix the affected controls and verify with keyboard and assistive technology.',
  }))
  if (count(result?.incompleteRules))
    findings.push({
      id: 'axe-needs-review',
      category: 'accessibility',
      severity: 'advisory',
      title: 'Accessibility checks need manual review',
      observation: `${count(result.incompleteRules)} rules could not reach a definite result.`,
      impact: 'An unknown automated result is not a passing accessibility check.',
      nextAction: 'Review the original page with keyboard and assistive technology.',
    })
  if (violations.length > LIMIT)
    findings.push({
      id: 'axe-findings-limited',
      category: 'accessibility',
      severity: 'advisory',
      title: 'Accessibility finding limit reached',
      observation: 'Additional automated rule findings exceeded the report limit.',
      impact: 'This bounded report does not contain every finding.',
      nextAction: 'Run the accessibility engine on the original page to inspect the remaining rules.',
    })
  return {
    findings,
    metrics: {
      violationRules: violations.length,
      violationNodes: violations.reduce((n, rule) => n + count(rule.count), 0),
      incompleteRules: count(result?.incompleteRules),
      passedRules: count(result?.passedRules),
      scannedElements: count(result?.scannedElements),
    },
    partial: violations.length > LIMIT || count(result?.incompleteRules) > 0,
  }
}

export async function inspectAccessibility(page) {
  const session = await page.context().newCDPSession(page)
  try {
    const { frameTree } = await session.send('Page.getFrameTree')
    const { executionContextId } = await session.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: 'shapewall-accessibility',
      grantUniveralAccess: false,
    })
    const evaluate = async (expression) => {
      const result = await session.send('Runtime.evaluate', {
        expression,
        contextId: executionContextId,
        awaitPromise: true,
        returnByValue: true,
        timeout: 20000,
      })
      if (result.exceptionDetails || result.result?.subtype === 'error')
        throw new Error('Accessibility engine could not evaluate this state.')
      return result.result.value
    }
    const size = await evaluate(`(() => {
    let count = 0;
    const roots = [document];
    while (roots.length) {
      const walker = document.createTreeWalker(roots.pop(), NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        if (++count > 10000) return count;
        if (walker.currentNode.shadowRoot) roots.push(walker.currentNode.shadowRoot);
      }
    }
    return count;
  })()`)
    if (size > ACCESSIBILITY_MAX_ELEMENTS) return { unsupported: true }
    // The pinned engine is local package code, never a downloaded page script.
    await evaluate(axe.source)
    const result = await evaluate(`(async () => {
    const results = await axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'] },
      iframes: false, selectors: false, ancestry: false, xpath: false, elementRef: false,
      resultTypes: ['violations'], preload: false,
    });
    return {
      violations: results.violations.slice(0,120).map(rule => ({id:rule.id,impact:rule.impact,count:rule.nodes.length})),
      incompleteRules: results.incomplete.length, passedRules: results.passes.length,
    };
  })()`)
    return { ...result, scannedElements: size }
  } finally {
    await session.detach().catch(() => {})
  }
}
