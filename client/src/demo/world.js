// Which fictional product the public demo is about: the export says so
// (data/info.json demoApp, scripts/demo-export.js --app), and the workspace,
// projects, chats, agent feedback and search previews follow. "brackwell"
// is the public demo (a field operations app with about 150 screens);
// "lumen" (Lumen Notes, a small notes app) is the test fixture and the
// default when an export does not say.
//
// `boards`: the main project's boards, the one that opens first first. `id`
// is the board's id in the demo (what a pushed board's config id would be),
// `folder` where its data is in the export (data/boards/<folder>...),
// `title` the name the board switcher shows (the export's when left out) and
// `app` which fictional app its screens are (its search previews, checks.js).
// `website`: a second project made from part of the first board (Lumen only).

const LUMEN = {
  id: 'lumen',
  workspace: 'Lumen',
  project: { name: 'Lumen Notes', slug: 'lumen-notes' },
  boards: [{ id: 'demo', folder: 'demo', app: 'lumen' }],
  website: { name: 'Lumen Marketing', slug: 'lumen-marketing', title: 'Lumen marketing', groups: ['Marketing', 'Content'] },
  source: '/home/robin/code/lumen-notes',
  seo: { site: 'https://lumen-notes.example', brand: 'Lumen Notes' },
}

const BRACKWELL = {
  id: 'brackwell',
  // Neutral names: the project holds two apps (Brackwell and Lumen Notes), so the board's project label above the board
  // name must not read as if Lumen Notes were part of Brackwell.
  workspace: 'Demo workspace',
  project: { name: 'Demo project', slug: 'brackwell' },
  // One project, two boards: the Brackwell app (146 screens, opens first) and
  // Lumen Notes, a second app with its own captures (scripts/demo-lumen-board.js
  // adds it to the export).
  boards: [
    { id: 'brackwell', folder: 'demo', title: 'Brackwell', app: 'brackwell' },
    { id: 'lumen-notes', folder: 'lumen', title: 'Lumen Notes', app: 'lumen' },
  ],
  website: null,
  source: '/home/robin/code/brackwell',
  seo: { site: 'https://brackwell.example', brand: 'Brackwell' },
}

export const DEMO_WORLDS = { lumen: LUMEN, brackwell: BRACKWELL }
let current = LUMEN

// Set once, before the state is seeded (install.js), from data/info.json.
export function setDemoWorld(id) {
  current = DEMO_WORLDS[id] || LUMEN
  return current
}
export const demoWorld = () => current
// Which fictional app a board shows ("brackwell" or "lumen"): the board's
// own, else the world's.
export const boardApp = (boardId) => current.boards.find((board) => board.id === boardId)?.app || current.id
