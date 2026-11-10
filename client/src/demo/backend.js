// The public demo's in-browser backend lives in backend/ (index.js wires
// the parts together); this keeps the import path everyone uses.
export { AGENT_INFO, DemoError, createDemoBackend } from './backend/index.js'
