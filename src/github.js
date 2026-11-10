// GitHub connect for a self-hosted board: make a GitHub issue from a
// comment, link pull requests to comments (by hand, or found from a
// "shapewall:<id>" marker in the PR description), and resolve a comment when
// its pull request merges. `shapewall github sync` polls; the optional
// webhook (POST /api/github/webhook) does the same as GitHub sends events.
//
// The repository comes from the config (`github.repo`) or
// $SHAPEWALL_GITHUB_REPO. The token comes only from $SHAPEWALL_GITHUB_TOKEN or
// $GITHUB_TOKEN, else (for github.com only) from the GitHub CLI's
// `gh auth token`, and the webhook secret only from
// $SHAPEWALL_GITHUB_WEBHOOK_SECRET: neither is ever written to a file, an
// export, a log line or an API response. Calls use the REST API with fetch.

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { GITHUB_REPO_RE, ID_RE } from './config.js'
import { feedbackContext, feedbackItem, fileKind } from './feedback.js'
import { aroundRect } from './png.js'
import { DEFAULT_BOARD_URL, runningBoardUrl } from './serve-state.js'
import { CommentError, getComment, listComments, readJson, recordGithubPull, setGithubIssue, writeJsonAtomic } from './store.js'
import { absoluteProgram } from './which.js'

// Checked in this order; the first one set wins.
export const TOKEN_VARS = ['SHAPEWALL_GITHUB_TOKEN', 'GITHUB_TOKEN']
export const WEBHOOK_SECRET_VAR = 'SHAPEWALL_GITHUB_WEBHOOK_SECRET'
const DEFAULT_API_URL = 'https://api.github.com'
const REQUEST_TIMEOUT_MS = 20000
const SYNC_PAGES_MAX = 5
const SYNC_PAGE_SIZE = 50
// PRs updated a little before the last sync are read again, for clock skew.
const SYNC_OVERLAP_MS = 10 * 60 * 1000
const REFRESH_MAX = 30

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

// The token, for the request that needs it. Never stored or returned.
// Without a token variable, a signed-in GitHub CLI lends its token, but only
// for github.com itself (never for another API URL, which could be anyone's).
// A token from the environment goes to github.com, or to an API URL the
// person named themselves ($SHAPEWALL_GITHUB_API_URL). An API URL that only a
// config file names gets no token: a cloned repository's config could
// otherwise point it at any host.
function tokenFrom(env, apiUrl = DEFAULT_API_URL, confirmed = true) {
  if (apiUrl !== DEFAULT_API_URL && !confirmed) return null
  for (const name of TOKEN_VARS) {
    const value = typeof env[name] === 'string' ? env[name].trim() : ''
    if (value) return { name, value }
  }
  if (apiUrl !== DEFAULT_API_URL || env.SHAPEWALL_GITHUB_GH === '0') return null
  const value = ghToken(env)
  return value ? { name: GH_TOKEN_SOURCE, value } : null
}

// `gh auth token`, cached for a few minutes per PATH and HOME so the server
// does not start gh on every request. Any error (no gh, signed out) is null.
export const GH_TOKEN_SOURCE = 'gh auth token'
const GH_CACHE_MS = 5 * 60 * 1000
const ghCache = new Map()
export function ghToken(env = process.env, { run = execFileSync, now = Date.now() } = {}) {
  // gh keeps its login under HOME (or GH_CONFIG_DIR); without either there is none to lend.
  if (!env.PATH || !(env.HOME || env.GH_CONFIG_DIR || env.GH_TOKEN)) return null
  const key = [env.PATH, env.HOME || '', env.GH_CONFIG_DIR || '', env.GH_TOKEN ? 'gh-token' : ''].join('\n')
  const hit = ghCache.get(key)
  if (hit && run === execFileSync && now - hit.at < GH_CACHE_MS) return hit.value
  let value = null
  try {
    // From absolute PATH entries only: a relative one would let a gh in the project run.
    const gh = absoluteProgram('gh', env)
    if (!gh) throw new Error('gh is not on PATH')
    const output = run(gh, ['auth', 'token', '--hostname', 'github.com'], {
      env,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const line = String(output || '').trim()
    if (/^[\w-]{10,255}$/.test(line)) value = line
  } catch {
    value = null
  }
  if (run === execFileSync) ghCache.set(key, { at: now, value })
  return value
}

// The API must be https; plain http only on this machine (a test stub or a
// local proxy), so the token never crosses a network in the clear.
function checkApiUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:') return null
    if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return null
    return 'the GitHub API URL must be https (http only on 127.0.0.1 or localhost)'
  } catch {
    return 'the GitHub API URL is not a URL'
  }
}

// What GitHub connect is set to, without secrets: safe to print and to send
// to the board.
export function githubSettings(config, env = process.env) {
  const base = config.github || {}
  const rawRepo = String(env.SHAPEWALL_GITHUB_REPO || base.repo || '').trim()
  const repoError = rawRepo && !GITHUB_REPO_RE.test(rawRepo) ? `"${rawRepo.slice(0, 80)}" is not owner/name` : null
  const repo = rawRepo && !repoError ? rawRepo : null
  const envApiUrl = String(env.SHAPEWALL_GITHUB_API_URL || '').trim()
  const apiUrl = String(envApiUrl || base.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '')
  const apiError = checkApiUrl(apiUrl)
  // Only the environment can confirm an API URL other than github.com.
  const apiConfirmed = apiUrl === DEFAULT_API_URL || Boolean(envApiUrl)
  // Like notifications: the config, else a running `shapewall serve`, else the default port.
  let boardUrl = String(env.SHAPEWALL_BOARD_URL || base.boardUrl || config.boardUrl || runningBoardUrl(config) || DEFAULT_BOARD_URL)
  if (!boardUrl.endsWith('/')) boardUrl += '/'
  const token = tokenFrom(env, apiUrl, apiConfirmed)
  const board = base.board && config.boards.some((item) => item.id === base.board) ? base.board : config.boards[0]?.id || null
  return {
    repo,
    repoError,
    apiUrl,
    apiError,
    apiConfirmed,
    boardUrl,
    labels: Array.isArray(base.labels) ? base.labels : [],
    board,
    tokenVar: token?.name || null,
    webhook: Boolean(String(env[WEBHOOK_SECRET_VAR] || '').trim()),
    // Issues, links and sync need a repo and a token; the webhook needs a repo and the secret.
    ready: Boolean(repo && token && !apiError),
  }
}

function notReady(settings) {
  if (settings.repoError) return `GitHub repo ${settings.repoError}.`
  if (!settings.repo) return 'GitHub is not set up: add "github": { "repo": "owner/name" } to the config.'
  if (!settings.apiConfirmed && !settings.apiError)
    return `The config sets github.apiUrl to ${settings.apiUrl}. To send your GitHub token there, set SHAPEWALL_GITHUB_API_URL to the same URL in your environment.`
  if (!settings.tokenVar) return `No GitHub token: set ${TOKEN_VARS.join(' or ')} in the environment (or sign in with "gh auth login").`
  return `GitHub API URL: ${settings.apiError}.`
}

// One REST call. Errors carry GitHub's message, never the token.
async function githubRequest(settings, env, method, route, { body, fetchImpl = globalThis.fetch } = {}) {
  if (!settings.ready) throw new CommentError(400, 'github_not_configured', notReady(settings))
  const token = tokenFrom(env, settings.apiUrl, settings.apiConfirmed)
  if (!token) throw new CommentError(400, 'github_not_configured', notReady({ ...settings, tokenVar: null }))
  let response
  try {
    response = await fetchImpl(`${settings.apiUrl}${route}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token.value}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'shapewall',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    })
  } catch (error) {
    throw new CommentError(502, 'github_unreachable', `Could not reach GitHub at ${settings.apiUrl} (${error.cause?.code || error.name}).`)
  }
  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (response.ok) return data
  const said = typeof data?.message === 'string' ? data.message.slice(0, 200) : `HTTP ${response.status}`
  if (response.status === 401) {
    throw new CommentError(502, 'github_unauthorized', `GitHub refused the token in ${settings.tokenVar} (${said}).`)
  }
  if (response.status === 404) throw new CommentError(404, 'github_not_found', `GitHub: not found in ${settings.repo} (${said}).`)
  throw new CommentError(502, 'github_error', `GitHub answered ${response.status}: ${said}`)
}

// ---- Issue text -------------------------------------------------------------------

// GitHub turns "@name" into a mention that notifies that account; reviewers'
// @mentions are Shapewall handles, so they are kept from pinging strangers.
function quiet(text) {
  return String(text || '').replace(/@(?=[A-Za-z0-9])/g, '@\u200b')
}

// Inline code that survives backticks inside the value.
function code(value) {
  const text = String(value).replace(/\s+/g, ' ')
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

// A link to the comment on the board: it opens with the comment selected.
export function boardLink(settings, boardId, commentId) {
  const url = new URL(settings.boardUrl)
  url.searchParams.set('board', boardId)
  url.searchParams.set('filter', 'all')
  url.searchParams.set('c', String(commentId))
  return url.toString()
}

function screenshotLink(settings, boardId, item) {
  if (!item.files.screenshot) return null
  // The capture the comment was made on can be an archived version.
  const kind = fileKind(item, item.files.screenshot)
  return new URL(`api/boards/${boardId}/${kind}/${path.basename(item.files.screenshot)}`, settings.boardUrl).toString()
}

// The issue made from one comment (the feedback item shape).
export function issueContent(settings, boardId, item) {
  const where = item.page ? item.page.title : `Variant: ${item.variant?.title || 'removed'}`
  const first = item.body.split('\n')[0].replace(/\s+/g, ' ').trim()
  const title = `${where}: ${first.length > 90 ? `${first.slice(0, 89)}...` : first}`.slice(0, 200)
  const crop = aroundRect(item.position, item.viewport)
  const shot = screenshotLink(settings, boardId, item)
  const lines = [
    ...item.body.split('\n').map((line) => `> ${quiet(line)}`),
    '',
    `-- ${quiet(item.author)}, on Shapewall comment #${item.id}`,
    '',
    item.page
      ? `**Page:** [${item.page.title}](${item.page.url}) (${code(item.page.path)}), ${item.viewport.name} ${item.viewport.width}x${item.viewport.height}`
      : `**Variant:** ${item.variant?.title || 'removed'} (${item.viewport.name} ${item.viewport.width}x${item.viewport.height})`,
  ]
  if (item.element) lines.push(`**Element:** ${code(item.element.selector)}${item.element.text ? ` ("${quiet(item.element.text)}")` : ''}`)
  lines.push(`**Pin:** ${item.position.x}, ${item.position.y} px (${item.position.xPercent}% / ${item.position.yPercent}%)`)
  lines.push(
    `**Screenshot:** ${shot ? `[${item.viewport.name} capture](${shot})` : 'not captured'}; the part around the pin is x ${crop.x}-${crop.x + crop.width}, y ${crop.y}-${crop.y + crop.height}${item.captureVersion ? ` (capture ${item.captureVersion})` : ''}`,
  )
  lines.push(`**On the board:** [comment #${item.id}](${boardLink(settings, boardId, item.id)})`)
  lines.push(
    '',
    `To link a fix, put ${code(`shapewall:${boardId}/${item.id}`)} or ${code(`Fixes shapewall#${item.id}`)} in the pull request description; when it merges, the comment is resolved.`,
    '',
    `<!-- shapewall:${boardId}/${item.id} -->`,
  )
  return { title, body: lines.join('\n') }
}

// ---- Issues -------------------------------------------------------------------------

// Two clicks on the button make one issue.
const pendingIssues = new Map()

// Creates the GitHub issue for a comment, or returns the one it already has.
// Returns { comment, issue, created }.
export async function createIssue(config, { boardId = null, commentId, env = process.env, fetchImpl, now = new Date() }) {
  const settings = githubSettings(config, env)
  const board = boardFor(config, boardId)
  const existing = getComment(config, board.id, commentId)
  if (existing.github.issue) return { comment: existing, issue: existing.github.issue, created: false }
  if (!settings.ready) throw new CommentError(400, 'github_not_configured', notReady(settings))
  const key = `${board.id}/${existing.id}`
  if (pendingIssues.has(key)) return pendingIssues.get(key)
  const run = (async () => {
    const item = feedbackItem(feedbackContext(config, board), existing)
    const { title, body } = issueContent(settings, board.id, item)
    const created = await githubRequest(settings, env, 'POST', `/repos/${settings.repo}/issues`, {
      body: { title, body, ...(settings.labels.length ? { labels: settings.labels } : {}) },
      fetchImpl,
    })
    if (!Number.isSafeInteger(created?.number) || typeof created?.html_url !== 'string') {
      throw new CommentError(502, 'github_error', 'GitHub did not return the new issue.')
    }
    const issue = { number: created.number, url: created.html_url, title: created.title || title, createdAt: now.toISOString() }
    const comment = await setGithubIssue(config, board.id, existing.id, issue, { now })
    return { comment, issue: comment.github.issue, created: true }
  })()
  pendingIssues.set(key, run)
  try {
    return await run
  } finally {
    pendingIssues.delete(key)
  }
}

// ---- Pull requests the starter agent opens -------------------------------------------

// Opens a pull request from a branch already pushed (the starter agent's).
// Returns { number, url }. Comment text in the title and body is quieted, so
// it cannot ping GitHub accounts.
export async function openPullRequest(config, { head, base, title, body, env = process.env, fetchImpl }) {
  const settings = githubSettings(config, env)
  const created = await githubRequest(settings, env, 'POST', `/repos/${settings.repo}/pulls`, {
    body: { head, base, title: quiet(title).slice(0, 200), body: quiet(body), draft: false },
    fetchImpl,
  })
  if (!Number.isSafeInteger(created?.number) || typeof created?.html_url !== 'string') {
    throw new CommentError(502, 'github_error', 'GitHub did not return the new pull request.')
  }
  return { number: created.number, url: created.html_url }
}

function boardFor(config, boardId) {
  if (!boardId) return config.boards[0]
  const board = config.boards.find((item) => item.id === boardId)
  if (!board) throw new CommentError(404, 'unknown_board', `No board "${boardId}".`)
  return board
}

// ---- Pull requests ------------------------------------------------------------------

// "12", "#12" or a pull request URL of the configured repo -> 12.
export function parsePullRef(value, repo) {
  const text = String(value ?? '').trim()
  let match = /^#?([1-9][0-9]{0,9})$/.exec(text)
  if (match) return Number(match[1])
  match = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]{0,9})(?:[/?#].*)?$/.exec(text)
  if (match) {
    if (repo && match[1].toLowerCase() !== repo.toLowerCase()) {
      throw new CommentError(400, 'other_repo', `That pull request is in ${match[1]}, not ${repo}.`)
    }
    return Number(match[2])
  }
  throw new CommentError(400, 'invalid_pull', 'Give a pull request number (12 or #12) or its URL.')
}

// A pull request as GitHub's API (or a webhook) describes it -> what a comment keeps.
export function pullFromApi(pr) {
  return {
    number: pr.number,
    url: pr.html_url,
    title: typeof pr.title === 'string' ? pr.title : '',
    state: pr.merged_at || pr.merged === true ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
    mergedAt: typeof pr.merged_at === 'string' ? pr.merged_at : null,
  }
}

const MARKER_RE = /\bshapewall(?::|#)(?:([a-z0-9][a-z0-9-]{0,63})\/)?([1-9][0-9]{0,9})\b/gi
const CLOSES_ISSUE_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#([1-9][0-9]{0,9})\b/gi

// Comments a pull request names in its title or description:
// "shapewall:12", "shapewall:<board>/12", "Fixes shapewall#12" (bare ids
// are on `defaultBoard`), plus issue numbers it closes ("Fixes #45").
export function refsInText(text, defaultBoard) {
  const value = String(text || '')
  const comments = []
  for (const match of value.matchAll(MARKER_RE)) {
    comments.push({ boardId: match[1] ? match[1].toLowerCase() : defaultBoard, commentId: Number(match[2]) })
  }
  const issues = [...value.matchAll(CLOSES_ISSUE_RE)].map((match) => Number(match[1]))
  return { comments, issues }
}

// Which comments link to which issue and pull request numbers, on every board.
function linkIndex(config) {
  const issues = new Map()
  const pulls = new Map()
  const add = (map, key, value) => map.set(key, [...(map.get(key) || []), value])
  for (const board of config.boards) {
    for (const comment of listComments(config, board.id)) {
      if (comment.github.issue) add(issues, comment.github.issue.number, { boardId: board.id, commentId: comment.id })
      for (const pull of comment.github.pulls) add(pulls, pull.number, { boardId: board.id, commentId: comment.id, state: pull.state })
    }
  }
  return { issues, pulls }
}

// Links (or updates) one pull request on every comment it concerns. Returns
// { linked: [...], merged: [...], skipped: [...] } with { board, comment, pull, state }.
async function applyPull(config, settings, pr, index, now) {
  const pull = pullFromApi(pr)
  const refs = refsInText(`${pr.title || ''}\n${pr.body || ''}`, settings.board)
  const targets = new Map()
  const want = (boardId, commentId, via) => {
    const key = `${boardId}/${commentId}`
    if (!targets.has(key)) targets.set(key, { boardId, commentId, via })
  }
  for (const link of index.pulls.get(pull.number) || []) want(link.boardId, link.commentId, 'manual')
  for (const ref of refs.comments) want(ref.boardId, ref.commentId, 'body')
  for (const number of refs.issues) for (const link of index.issues.get(number) || []) want(link.boardId, link.commentId, 'issue')
  const result = { linked: [], merged: [], skipped: [] }
  for (const target of targets.values()) {
    const entry = { board: target.boardId, comment: target.commentId, pull: pull.number, state: pull.state }
    if (!ID_RE.test(target.boardId) || !config.boards.some((board) => board.id === target.boardId)) {
      result.skipped.push({ ...entry, reason: 'no such board' })
      continue
    }
    try {
      const { changed, merged } = await recordGithubPull(config, target.boardId, target.commentId, pull, { via: target.via, now })
      if (changed) result.linked.push(entry)
      if (merged) result.merged.push(entry)
    } catch (error) {
      if (!(error instanceof CommentError)) throw error
      result.skipped.push({ ...entry, reason: error.code === 'unknown_comment' ? 'no such comment' : error.message })
    }
  }
  return result
}

function mergeResults(into, from) {
  into.linked.push(...from.linked)
  into.merged.push(...from.merged)
  into.skipped.push(...from.skipped)
  return into
}

// Links a pull request to a comment by hand (`shapewall github link`). Reads
// the PR from GitHub, so a merged one resolves the comment right away.
// Returns { comment, pull, merged }.
export async function linkPull(config, { boardId = null, commentId, pr, env = process.env, fetchImpl, now = new Date() }) {
  const settings = githubSettings(config, env)
  const board = boardFor(config, boardId)
  getComment(config, board.id, commentId)
  if (!settings.ready) throw new CommentError(400, 'github_not_configured', notReady(settings))
  const number = parsePullRef(pr, settings.repo)
  const data = await githubRequest(settings, env, 'GET', `/repos/${settings.repo}/pulls/${number}`, { fetchImpl })
  const pull = pullFromApi(data)
  const { comment, merged } = await recordGithubPull(config, board.id, commentId, pull, { via: 'manual', now })
  return { comment, pull: comment.github.pulls.find((item) => item.number === number), merged }
}

// ---- Sync (polling) -----------------------------------------------------------------

export function syncStateFile(config) {
  return path.join(config.outputDir, 'github-sync.json')
}

// Reads the repo's pull requests updated since the last sync (newest first,
// a few pages at most), links the ones that name a comment, and refreshes
// linked ones that were not in the list. Returns { repo, scanned, linked,
// merged, skipped, since }.
export async function syncGithub(config, { env = process.env, fetchImpl, now = new Date(), log = () => {} } = {}) {
  const settings = githubSettings(config, env)
  if (!settings.ready) throw new CommentError(400, 'github_not_configured', notReady(settings))
  const stateFile = syncStateFile(config)
  const state = readJson(stateFile)
  const since = state?.repo === settings.repo && typeof state.lastSyncAt === 'string' ? state.lastSyncAt : null
  const cutoff = since ? Date.parse(since) - SYNC_OVERLAP_MS : null
  const index = linkIndex(config)
  const result = { repo: settings.repo, since, scanned: 0, linked: [], merged: [], skipped: [] }
  const seen = new Set()
  let done = false
  for (let page = 1; page <= SYNC_PAGES_MAX && !done; page += 1) {
    const list = await githubRequest(
      settings,
      env,
      'GET',
      `/repos/${settings.repo}/pulls?state=all&sort=updated&direction=desc&per_page=${SYNC_PAGE_SIZE}&page=${page}`,
      { fetchImpl },
    )
    if (!Array.isArray(list)) throw new CommentError(502, 'github_error', 'GitHub did not return a list of pull requests.')
    for (const pr of list) {
      if (cutoff !== null && Date.parse(pr.updated_at) < cutoff) {
        done = true
        break
      }
      if (!Number.isSafeInteger(pr?.number) || seen.has(pr.number)) continue
      seen.add(pr.number)
      result.scanned += 1
      mergeResults(result, await applyPull(config, settings, pr, index, now))
    }
    if (list.length < SYNC_PAGE_SIZE) done = true
  }
  // Linked pull requests still open that the list did not reach.
  const stale = [...index.pulls.entries()].filter(([number, links]) => !seen.has(number) && links.some((link) => link.state === 'open'))
  for (const [number] of stale.slice(0, REFRESH_MAX)) {
    try {
      const pr = await githubRequest(settings, env, 'GET', `/repos/${settings.repo}/pulls/${number}`, { fetchImpl })
      result.scanned += 1
      mergeResults(result, await applyPull(config, settings, pr, index, now))
    } catch (error) {
      if (!(error instanceof CommentError) || error.code !== 'github_not_found') throw error
      log(`pull request #${number} is gone from ${settings.repo}`)
    }
  }
  writeJsonAtomic(stateFile, { repo: settings.repo, lastSyncAt: now.toISOString() })
  return result
}

// ---- Webhook ------------------------------------------------------------------------

// X-Hub-Signature-256 is "sha256=" + HMAC-SHA256(secret, raw body), hex.
export function verifySignature(secret, raw, header) {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`)
  const given = Buffer.from(header)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

// Handles one verified delivery. Returns { status, body } for the response.
// Only pull_request events of the configured repo change anything; a
// webhook needs no token, the event carries the pull request.
export async function handleWebhook(config, { event, payload, env = process.env, now = new Date() }) {
  const settings = githubSettings(config, env)
  if (event === 'ping') return { status: 200, body: { ok: true, pong: true } }
  if (event !== 'pull_request') return { status: 202, body: { ok: true, ignored: `event ${String(event).slice(0, 40)}` } }
  const fullName = String(payload?.repository?.full_name || '')
  if (!settings.repo || fullName.toLowerCase() !== settings.repo.toLowerCase()) {
    return { status: 202, body: { ok: true, ignored: 'another repository' } }
  }
  const pr = payload?.pull_request
  if (!pr || !Number.isSafeInteger(pr.number) || typeof pr.html_url !== 'string') {
    return { status: 400, body: { error: { code: 'invalid_payload', message: 'No pull request in the event.' } } }
  }
  const result = await applyPull(config, settings, pr, linkIndex(config), now)
  return { status: 200, body: { ok: true, action: payload.action || null, pull: pr.number, ...result } }
}

// ---- Doctor -------------------------------------------------------------------------

// The `shapewall doctor` line for GitHub. With a repo and a token it asks
// GitHub whether the token can see the repo.
export async function checkGithub(config, { env = process.env, fetchImpl, network = true } = {}) {
  if (!config) return { name: 'github', status: 'skip', message: 'No valid config, so no GitHub settings to check' }
  const settings = githubSettings(config, env)
  const webhook = settings.webhook ? 'webhook secret set' : `no webhook secret (${WEBHOOK_SECRET_VAR}), use "shapewall github sync"`
  if (settings.repoError) return { name: 'github', status: 'fail', message: `GitHub repo ${settings.repoError}`, fix: 'Use "owner/name".' }
  if (!settings.repo) return { name: 'github', status: 'skip', message: 'GitHub connect is off (optional; see docs/github.md)' }
  if (settings.apiError) return { name: 'github', status: 'fail', message: `GitHub: ${settings.apiError}`, fix: 'Fix github.apiUrl.' }
  if (!settings.apiConfirmed) {
    return {
      name: 'github',
      status: 'fail',
      message: `GitHub: the config names the API URL ${settings.apiUrl}, which gets no token until you confirm it`,
      fix: `Set SHAPEWALL_GITHUB_API_URL=${settings.apiUrl} in your environment.`,
    }
  }
  if (!settings.tokenVar) {
    return {
      name: 'github',
      status: 'warn',
      message: `GitHub repo ${settings.repo}, but no token: issues, links and sync are off`,
      fix: `Set ${TOKEN_VARS.join(' or ')} (a token that can read pull requests and write issues), or sign in with "gh auth login".`,
    }
  }
  const prefix = `GitHub ${settings.repo}, token from ${settings.tokenVar}, ${webhook}`
  if (!network) return { name: 'github', status: 'ok', message: `${prefix} (not checked)` }
  try {
    const repo = await githubRequest(settings, env, 'GET', `/repos/${settings.repo}`, { fetchImpl })
    if (repo?.has_issues === false) {
      return {
        name: 'github',
        status: 'warn',
        message: `${prefix}; issues are turned off in the repo`,
        fix: 'Turn on Issues in the repo settings.',
      }
    }
    return { name: 'github', status: 'ok', message: `${prefix}; the token can see the repo` }
  } catch (error) {
    // A token GitHub rejects (401 Bad credentials) breaks every GitHub action: a FAIL, not a warning.
    if (error.code === 'github_unauthorized') {
      return { name: 'github', status: 'fail', message: `${prefix}; ${error.message}`, fix: `Replace the token in ${settings.tokenVar}.` }
    }
    return { name: 'github', status: 'warn', message: `${prefix}; ${error.message}`, fix: 'Check the token and its access to the repo.' }
  }
}
