// The public demo's in-browser backend telling the board what the visitor did, for the "Try this" card (board/TryThis.jsx):
// a step is ticked off when its action completes, not when its tool opens. A window event, so the board needs no import
// of the demo backend; outside a browser (the backend's tests) it is a no-op.
export const DEMO_AGENT_ASKED = 'shapewall:demo-agent-asked'

export function announceDemoAgentAsked() {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  window.dispatchEvent(new Event(DEMO_AGENT_ASKED))
}
