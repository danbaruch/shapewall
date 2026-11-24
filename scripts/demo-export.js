// Builds the public live demo (shapewall.com/demo/) as a static export.
//
//   --app brackwell (default): Brackwell, a big fictional field operations
//     app, about 150 screens (scripts/demo-brackwell.js), and a second board
//     in the same project, Lumen Notes (scripts/demo-lumen-board.js). The
//     public demo.
//   --app lumen: Lumen Notes, the small notes site (scripts/demo-lumen.js).
//     The fixture the end-to-end tests and the docs screenshots use.
//
// Run: node scripts/demo-export.js [outDir] [--app brackwell|lumen] [--publish siteRoot]
// The other arguments go to the app's script as they are.
const APPS = { brackwell: './demo-brackwell.js', lumen: './demo-lumen.js' }

const at = process.argv.indexOf('--app')
const app = at >= 0 ? process.argv[at + 1] : 'brackwell'
if (!APPS[app]) throw new Error(`--app: one of ${Object.keys(APPS).join(', ')}`)
if (at >= 0) process.argv.splice(at, 2)
await import(APPS[app])
