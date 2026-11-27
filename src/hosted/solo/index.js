// The solo profile's surfaces (shapewall serve --engine hosted, 1.5.0,
// experimental): the hosted engine run for one project, one owner, on
// loopback. createHostedApp({ solo }) calls mountSolo(app, deps) once, and
// only when `solo` is set; a team server never mounts anything from here.
//
// Every solo-only surface lives in its own file under src/hosted/solo/ and
// is mounted from this function, so a new one never needs src/hosted/app.js:
//
//   app        the Express app. mountSolo runs after the auth routes and the
//              board routes, before the device, token and console APIs and
//              the pages, so a route here answers before /api's session
//              check and the page fallback.
//   deps.boardApi  a router inside the members' board API
//              (/w/:ws/p/:pid/api, session and workspace role already
//              checked, req.t, req.project and req.role set) that answers
//              before that API's catch-all. Never on share or public routes.
//   deps       the rest of the shared state (db, dataDir, auth, events, ...).
//
// mountSolo returns { close() } (optional): app.locals.close() awaits it, so
// a surface that subscribes to the event bus or holds a lease lets go.
//
// With `solo.signIn === 'local'` (what `serve --engine hosted` always
// passes) the engine is the owner's: signin.js makes the owner, workspace
// and project on the first start and signs the browser in by the terminal's
// one-time link, and config.js keeps the project's boards on the bound
// config file (G1, G2). The surfaces after it get the owner's workspace and
// project (solo.workspaceId, solo.projectId, solo.boardUrl).
//
// machine-tokens.js makes the owner's command-line token at every start
// (cli.token in the data folder; G15) and the board's own agent's (R2).
//
// Mounted so far: signin.js and config.js (G1, G2), info.js (`solo` and
// `soloFeatures` on the board's /info, G16), events.js (events.jsonl and
// notifications, G8), update.js (self-update, G10), capture.js (in-process
// capture from the board and recapture_pages on /mcp, G3), journeys.js
// (journey editing, G5), batch.js (batch fixes on the chat, G14a). A surface the board turns on (client/src/board/solo.js)
// sets its flag in `features`.
import { mountSoloBatch } from './batch.js'
import { mountSoloCapture } from './capture.js'
import { createSoloBoards } from './config.js'
import { mountSoloEvents } from './events.js'
import { mountSoloInfo } from './info.js'
import { mountSoloJourneys } from './journeys.js'
import { ensureSoloOwner, mountSoloSignIn } from './signin.js'
import { mountSoloUpdate } from './update.js'
import { mintMachineToken, retireMachineTokens } from './machine-tokens.js'
import { engineProof } from '../../engine-target.js'

function mountOwner(app, deps, closers) {
  const solo = deps.solo
  if (!solo.configPath) throw new Error('solo: local sign-in needs the project config path (solo.configPath)')
  const owner = ensureSoloOwner(deps.db, {
    dataDir: deps.dataDir,
    ownerName: solo.ownerName,
    projectName: solo.projectName || solo.config?.title,
    configPath: solo.configPath,
    boardIds: (solo.config?.boards || []).map((board) => board.id),
    now: deps.now,
  })
  if (owner.created) deps.log(`Solo engine: made the owner account, its workspace and the project (${owner.projectId}).`)
  const signIn = mountSoloSignIn(app, { ...deps, gate: deps.localGate, owner })
  closers.push(() => signIn.close())
  const boards = createSoloBoards({ db: deps.db, ids: owner, configPath: solo.configPath, now: deps.now, log: deps.log })
  boards.sync({ force: true })
  // Before every other solo board route: the boards follow the file.
  deps.boardApi?.use((req, res, next) => {
    if (req.project?.id === owner.projectId) boards.sync()
    next()
  })
  const boardUrl = solo.boardUrl || `${deps.publicOrigin}/w/${owner.workspaceId}/p/${owner.projectId}/`
  // The owner's command line in the project folder (G15): a token of its own, new each start, gone at stop.
  // `watch` takes work, so it is an agent with a token of its own (machine-tokens.js).
  const tokenFiles = {}
  if (solo.machineTokens !== false) {
    closers.push(() => retireMachineTokens(deps.db, { dataDir: deps.dataDir, owner }))
    for (const which of ['cli', 'watch'])
      tokenFiles[which] = mintMachineToken(deps.db, { dataDir: deps.dataDir, owner, which, now: deps.now }).file
    // The board's own agent (R2): its token, its name and look from this machine's agent settings (G13).
    if (solo.localAgent)
      tokenFiles.agent = mintMachineToken(deps.db, {
        dataDir: deps.dataDir,
        owner,
        which: 'agent',
        now: deps.now,
        agent: solo.localAgent,
      }).file
  }
  // The proof a command line asks for before it sends a token (engine-target.js verifyEngine): an HMAC of its
  // challenge under this start's key, which only serve.json (0600) and this process hold. No session, no token.
  if (typeof solo.proofKey === 'string')
    app.post('/solo/whoami', (req, res) => {
      const challenge = String(req.headers['x-shapewall-challenge'] || '')
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(challenge)) return res.status(400).json({ error: { code: 'bad_challenge' } })
      res.set('Cache-Control', 'no-store').json({ proof: engineProof(solo.proofKey, challenge) })
    })
  app.locals.solo = { owner, boardUrl, boards, tokenFiles }
  return { ...deps, solo: { ...solo, workspaceId: owner.workspaceId, projectId: owner.projectId, boardUrl } }
}

export function mountSolo(app, deps) {
  const closers = []
  const features = {}
  const soloDeps = deps.solo?.signIn === 'local' ? mountOwner(app, deps, closers) : deps
  mountSoloInfo(soloDeps, features)
  const events = mountSoloEvents(app, soloDeps)
  if (events) closers.push(() => events.close())
  // In-process capture and recapture_pages on /mcp (G3): sets features.capture.
  const capture = mountSoloCapture(app, soloDeps, features)
  if (capture) closers.push(() => capture.close())
  // Journey editing on the board (G5): sets features.journeys.
  mountSoloJourneys(app, soloDeps, features)
  // Batch fixes on the chat (G14a): sets features.batchFixes.
  const batch = mountSoloBatch(soloDeps, features)
  if (batch) closers.push(() => batch.close())
  const update = mountSoloUpdate(app, soloDeps)
  if (update) {
    features.appUpdates = true
    closers.push(() => update.close())
  }
  return {
    async close() {
      for (const close of closers.reverse()) await close()
    },
  }
}
