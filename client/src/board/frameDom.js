// Reads of a live frame's document that the page cannot redirect. Live HTML
// is sanitized (no name attributes, no ids that match document methods), but
// the board still calls Document and EventTarget methods through their
// prototypes, so an element named like a method (DOM clobbering) can never
// stand in for it. Same-origin frames from another realm work the same way.

const DOC = typeof Document === 'undefined' ? null : Document.prototype
const getter = (name) => (DOC ? Object.getOwnPropertyDescriptor(DOC, name)?.get : null)
const GET = {
  documentElement: getter('documentElement'),
  body: getter('body'),
  defaultView: getter('defaultView'),
}

const NODE_TYPE = typeof Node === 'undefined' ? null : Object.getOwnPropertyDescriptor(Node.prototype, 'nodeType')?.get

export function isDocument(doc) {
  if (!DOC || !NODE_TYPE || !doc || typeof doc !== 'object') return false
  try {
    return NODE_TYPE.call(doc) === 9
  } catch {
    return false
  }
}

export const frameDom = {
  documentElement: (doc) => (isDocument(doc) ? GET.documentElement.call(doc) : null),
  body: (doc) => (isDocument(doc) ? GET.body.call(doc) : null),
  defaultView: (doc) => (isDocument(doc) ? GET.defaultView.call(doc) : null),
  querySelector: (doc, selector) => DOC.querySelector.call(doc, selector),
  querySelectorAll: (doc, selector) => DOC.querySelectorAll.call(doc, selector),
  elementFromPoint: (doc, x, y) => (isDocument(doc) ? DOC.elementFromPoint.call(doc, x, y) : null),
  addEventListener: (target, ...args) => EventTarget.prototype.addEventListener.call(target, ...args),
  removeEventListener: (target, ...args) => EventTarget.prototype.removeEventListener.call(target, ...args),
}
