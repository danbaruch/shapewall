// `shapewall ci comment`: one pull request comment from a result folder,
// created once and then updated in place (found again by a hidden marker).
//
// The token is the workflow's GITHUB_TOKEN (or SHAPEWALL_GITHUB_TOKEN) from
// the environment, and it goes only where src/github.js sends tokens: to
// api.github.com, or to an API URL the environment itself names
// (SHAPEWALL_GITHUB_API_URL, or GITHUB_API_URL, which the Actions runner sets).
// A config can never point it at another host, and the signed-in GitHub CLI is
// never asked here. Redirects are refused, so the token cannot follow one.
//
// Pull requests from forks get a read-only token. That is detected from the
// event (and from a 403 on write), and the summary then goes to the job
// summary ($GITHUB_STEP_SUMMARY) instead; nothing fails.
//
// Images: a comment cannot show files from a workflow artifact, so by default
// it links to the artifact. With "ci": { "images": "branch" } in a public
// repository, the thumbnails and images are committed to an orphan branch
// (shapewall-ci) with the git data API and embedded from it. That needs
// "contents: write" and makes the images public.

import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_API_URL, checkApiUrl, tokenFrom } from '../github.js'
import { COMMENT_MARKER, normalizeSummary, renderMissing, renderSummary, renderUnreadable } from './summary.js'
import { SUMMARY_SCHEMA } from './compare.js'

export const IMAGES_BRANCH = 'shapewall-ci'
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/
const REQUEST_TIMEOUT_MS = 20000
const COMMENT_PAGES_MAX = 10
const BRANCH_SHOTS_MAX = 20

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// The pull request this job runs for: from the event file, or --repo and --pull.
export function prContext(env = process.env, { repo = null, pull = null } = {}) {
  const event = env.GITHUB_EVENT_PATH ? readJson(env.GITHUB_EVENT_PATH) : null
  const pr = event?.pull_request || null
  const fullName = String(repo || env.GITHUB_REPOSITORY || pr?.base?.repo?.full_name || '')
  const number = Number(pull ?? pr?.number)
  const headRepo = pr?.head?.repo?.full_name || null
  const baseRepo = pr?.base?.repo?.full_name || null
  return {
    repo: REPO_RE.test(fullName) ? fullName : null,
    pull: Number.isInteger(number) && number > 0 ? number : null,
    title: typeof pr?.title === 'string' ? pr.title : '',
    headSha: typeof pr?.head?.sha === 'string' && /^[0-9a-f]{40}$/.test(pr.head.sha) ? pr.head.sha : null,
    // A fork's pull request: GitHub gives its workflow a read-only token.
    fork: Boolean(headRepo && baseRepo && headRepo !== baseRepo),
  }
}

export const SKIP_MARKER = '[skip shapewall]'
export const skipRequested = (title) =>
  String(title || '')
    .toLowerCase()
    .includes(SKIP_MARKER)

// Where API calls go, and whether the environment named that host.
export function apiTarget(config, env = process.env) {
  const named = String(env.SHAPEWALL_GITHUB_API_URL || env.GITHUB_API_URL || '').trim()
  const apiUrl = String(named || config?.github?.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '')
  return { apiUrl, confirmed: apiUrl === DEFAULT_API_URL || Boolean(named), error: checkApiUrl(apiUrl) }
}

// The GitHub web host (links to the run, the artifact and raw images).
export function serverUrl(env = process.env) {
  const value = String(env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '')
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.pathname.replace(/\/+$/, '') ? url.origin : 'https://github.com'
  } catch {
    return 'https://github.com'
  }
}

export function runUrl(env, repo) {
  return repo && /^\d{1,20}$/.test(String(env.GITHUB_RUN_ID || '')) ? `${serverUrl(env)}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : null
}

// An artifact link is used only when it points at this GitHub's own web host.
export function checkArtifactUrl(value, env = process.env) {
  if (!value || value === true) return null
  try {
    const url = new URL(String(value))
    // ( ) [ ] percent-encoded: they could end the markdown link the URL goes in.
    const escaped = url.toString().replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\[/g, '%5B').replace(/\]/g, '%5D')
    return url.protocol === 'https:' && url.origin === serverUrl(env) ? escaped : null
  } catch {
    return null
  }
}

// REST calls with the token; never throws for an HTTP status, only when
// GitHub cannot be reached. Returns { status, data }.
export function githubClient({ apiUrl, token, fetchImpl = globalThis.fetch }) {
  return async (method, route, body) => {
    let response
    try {
      response = await fetchImpl(`${apiUrl}${route}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'shapewall-ci',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      })
    } catch (error) {
      throw new Error(`could not reach GitHub at ${apiUrl} (${error.cause?.code || error.name})`, { cause: error })
    }
    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    return { status: response.status, data }
  }
}

const said = (result) => (typeof result.data?.message === 'string' ? result.data.message.slice(0, 200) : `HTTP ${result.status}`)

// The comment this job wrote before: the newest one with the marker,
// preferring ones a bot (the workflow's token) wrote.
export async function findComment(request, repo, pull) {
  const found = []
  for (let page = 1; page <= COMMENT_PAGES_MAX; page += 1) {
    const result = await request('GET', `/repos/${repo}/issues/${pull}/comments?per_page=100&page=${page}`)
    if (result.status !== 200 || !Array.isArray(result.data)) {
      if (page === 1) return { error: result }
      break
    }
    for (const comment of result.data) if (typeof comment?.body === 'string' && comment.body.startsWith(COMMENT_MARKER)) found.push(comment)
    if (result.data.length < 100) break
  }
  const bots = found.filter((comment) => comment.user?.type === 'Bot')
  return { comment: (bots.length ? bots : found).at(-1) || null }
}

// Creates or updates the one comment. Returns { action, id, url } or { error }.
export async function upsertComment(request, repo, pull, body) {
  const existing = await findComment(request, repo, pull)
  if (existing.error) return { error: existing.error }
  if (existing.comment) {
    const result = await request('PATCH', `/repos/${repo}/issues/comments/${existing.comment.id}`, { body })
    if (result.status === 200) return { action: 'updated', id: result.data?.id ?? existing.comment.id, url: result.data?.html_url || null }
    // A marker comment someone else wrote cannot be edited: write our own.
    if (![403, 404].includes(result.status)) return { error: result }
  }
  const result = await request('POST', `/repos/${repo}/issues/${pull}/comments`, { body })
  if (result.status === 201) return { action: 'created', id: result.data?.id ?? null, url: result.data?.html_url || null }
  return { error: result }
}

// Commits the changed shots' images to the orphan branch and returns a
// function from a result-folder path to its raw URL, or { error }.
export async function pushImages(request, { repo, pull, sha, summary, dir, env }) {
  const info = await request('GET', `/repos/${repo}`)
  if (info.status !== 200) return { error: `could not read the repository (${said(info)})` }
  if (info.data?.private !== false)
    return { error: 'images: "branch" is for public repositories only (the images would be public); links are used instead' }
  const prefix = `pr-${pull}/${(sha || String(Date.now())).slice(0, 12)}`
  const files = []
  for (const shot of summary.shots.filter((item) => item.changed && item.images).slice(0, BRANCH_SHOTS_MAX)) {
    for (const rel of Object.values(shot.images)) {
      if (typeof rel !== 'string' || !/^images\/[a-z0-9][a-z0-9.-]{0,100}\/[a-z.]{1,40}\.png$/.test(rel)) continue
      files.push(rel)
    }
  }
  if (!files.length) return { url: () => null }
  const tree = []
  for (const rel of files) {
    const content = fs.readFileSync(path.join(dir, rel)).toString('base64')
    const blob = await request('POST', `/repos/${repo}/git/blobs`, { content, encoding: 'base64' })
    if (blob.status !== 201) return { error: `could not upload an image (${said(blob)})`, status: blob.status }
    tree.push({ path: `${prefix}/${rel.slice('images/'.length)}`, mode: '100644', type: 'blob', sha: blob.data.sha })
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ref = await request('GET', `/repos/${repo}/git/ref/heads/${IMAGES_BRANCH}`)
    const tip = ref.status === 200 ? ref.data?.object?.sha : null
    let baseTree = null
    if (tip) {
      const commit = await request('GET', `/repos/${repo}/git/commits/${tip}`)
      baseTree = commit.data?.tree?.sha || null
    }
    const newTree = await request('POST', `/repos/${repo}/git/trees`, { ...(baseTree ? { base_tree: baseTree } : {}), tree })
    if (newTree.status !== 201) return { error: `could not write the images (${said(newTree)})`, status: newTree.status }
    const commit = await request('POST', `/repos/${repo}/git/commits`, {
      message: `Shapewall images for pull request #${pull}`,
      tree: newTree.data.sha,
      parents: tip ? [tip] : [],
    })
    if (commit.status !== 201) return { error: `could not write the images (${said(commit)})`, status: commit.status }
    const update = tip
      ? await request('PATCH', `/repos/${repo}/git/refs/heads/${IMAGES_BRANCH}`, { sha: commit.data.sha, force: false })
      : await request('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${IMAGES_BRANCH}`, sha: commit.data.sha })
    if (update.status === 200 || update.status === 201) {
      const server = serverUrl(env)
      const raw =
        server === 'https://github.com'
          ? `https://raw.githubusercontent.com/${repo}/${commit.data.sha}`
          : `${server}/${repo}/raw/${commit.data.sha}`
      return { url: (rel) => (files.includes(rel) ? `${raw}/${prefix}/${rel.slice('images/'.length)}` : null) }
    }
    // Another pull request moved the branch meanwhile: once more from its new tip.
    if (update.status !== 422) return { error: `could not update the ${IMAGES_BRANCH} branch (${said(update)})`, status: update.status }
  }
  return { error: `the ${IMAGES_BRANCH} branch kept moving; links are used instead` }
}

export function writeStepSummary(env, markdown) {
  const file = env.GITHUB_STEP_SUMMARY
  if (!file) return false
  try {
    fs.appendFileSync(file, `${markdown}\n`)
    return true
  } catch {
    return false
  }
}

// The whole `ci comment`. Returns { posted, action?, url?, fallback?, reason? }.
// Never throws for GitHub's answers: the pull request must not fail over a comment.
export async function commentFromResult({
  dir,
  config = null,
  env = process.env,
  repo = null,
  pull = null,
  artifactUrl = null,
  fetchImpl,
  log = () => {},
}) {
  const context = prContext(env, { repo, pull })
  const run = runUrl(env, context.repo)
  const artifact = checkArtifactUrl(artifactUrl, env)
  // From the artifact, which the pull request's code could have written:
  // checked field by field before any of it reaches the comment.
  const file = path.join(dir, 'summary.json')
  const raw = readJson(file)
  const summary = raw?.schema === SUMMARY_SCHEMA ? normalizeSummary(raw) : null
  const valid = Boolean(summary)
  const fallback = (reason, body) => {
    const wrote = writeStepSummary(env, body)
    log(`${reason}${wrote ? ' The summary is in the job summary instead.' : ''}`)
    return { posted: false, fallback: wrote ? 'step-summary' : null, reason }
  }
  let body = valid
    ? renderSummary(summary, { artifactUrl: artifact, runUrl: run })
    : fs.existsSync(file)
      ? renderUnreadable({ runUrl: run })
      : renderMissing({ runUrl: run })
  if (!context.repo || !context.pull)
    return fallback(
      'No pull request to comment on (set GITHUB_REPOSITORY and run on a pull_request event, or pass --repo and --pull).',
      body,
    )
  if (context.fork) return fallback('This pull request comes from a fork, whose workflow token is read-only, so there is no comment.', body)
  const target = apiTarget(config, env)
  if (target.error) return fallback(`GitHub API URL: ${target.error}.`, body)
  const token = tokenFrom({ ...env, SHAPEWALL_GITHUB_GH: '0' }, target.apiUrl, target.confirmed)
  if (!token) {
    const why = target.confirmed
      ? 'No GitHub token: the workflow step needs GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} in its env.'
      : `The config sets github.apiUrl to ${target.apiUrl}; the token is only sent there when SHAPEWALL_GITHUB_API_URL names it in the environment.`
    return fallback(why, body)
  }
  const request = githubClient({ apiUrl: target.apiUrl, token: token.value, fetchImpl })
  try {
    if (valid && config?.ci?.images === 'branch' && summary.shots.some((shot) => shot.changed)) {
      const pushed = await pushImages(request, { repo: context.repo, pull: context.pull, sha: context.headSha, summary, dir, env })
      if (pushed.error) {
        const hint = pushed.status === 403 ? ' (the workflow needs "contents: write" for images: "branch")' : ''
        log(`Images branch: ${pushed.error}${hint}`)
        body = renderSummary(summary, { artifactUrl: artifact, runUrl: run, note: `Images are linked, not shown: ${pushed.error}${hint}.` })
      } else body = renderSummary(summary, { artifactUrl: artifact, runUrl: run, imageUrl: pushed.url })
    }
    const result = await upsertComment(request, context.repo, context.pull, body)
    if (result.error) {
      const status = result.error.status
      if (status === 403)
        return fallback(
          `GitHub refused the comment (${said(result.error)}): the token is read-only here (a fork, or no "pull-requests: write").`,
          body,
        )
      return fallback(`GitHub refused the comment (${said(result.error)}).`, body)
    }
    writeStepSummary(env, body)
    log(
      `${result.action === 'created' ? 'Commented on' : 'Updated the comment on'} ${context.repo}#${context.pull}${result.url ? `: ${result.url}` : ''}`,
    )
    return { posted: true, action: result.action, url: result.url }
  } catch (error) {
    return fallback(`${error.message}.`, body)
  }
}
