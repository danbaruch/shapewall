// The demo's scripted agent: canned answers keyed to what was asked and
// where (a comment's thread, the whole board, an attached image), streamed
// word by word with the same events a real backend sends (status, text,
// tool and permission cards), so the live activity line and the streamed
// answer look as they do with a real agent. It asks before it "edits" anything, and Stop
// ends it like a real run. Nothing leaves the browser; it changes nothing.
import { replyText, settleCardPositions } from '../../../src/agent/reply-text.js'
import { demoUsedOptions } from './backend/composer.js'

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

// A page's title; a variant ("variant:<id>") by its own title and its page's.
function pageTitle(context, pageId) {
  const id = String(pageId || '')
  if (id.startsWith('variant:')) {
    const variant = (context.variants || []).find((item) => item.id === id.slice(8))
    if (!variant) return 'a variant'
    const page = context.pages.find((item) => item.id === variant.pageId)
    return page ? `${variant.title || 'Variant'} (variant of ${page.title})` : variant.title || 'a variant'
  }
  return context.pages.find((page) => page.id === id)?.title || id
}

// Words that say what to do, not which comment: they never pick one.
const FILLER = new Set(
  'a an and are be can could do fix for from in is it make me my next of on one or please should that the this to up us we with you your change edit update comment comments page agent'.split(
    ' ',
  ),
)
const wordsOf = (text) =>
  String(text || '')
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((word) => word.length > 1 && !FILLER.has(word)) || []

// The open comment a "fix ..." request names: by #id (or "comment 12"),
// then by the page it is on and the words of its text. Null when the
// request names none of them.
export function matchComment(text, open, context) {
  const lower = String(text || '').toLowerCase()
  const byId = /(?:#|\bcomment\s+|\bno\.?\s*)(\d{1,9})\b/.exec(lower)
  if (byId) {
    const found = open.find((item) => item.id === Number(byId[1]))
    if (found) return found
  }
  const asked = new Set(wordsOf(lower))
  if (!asked.size) return null
  let best = null
  let bestScore = 0
  for (const item of open) {
    const title = wordsOf(pageTitle(context, item.pageId))
    let score = title.length && title.every((word) => asked.has(word)) ? 5 : 0
    for (const word of new Set(wordsOf(item.body))) if (asked.has(word)) score += 1
    if (score > bestScore || (score === bestScore && score > 0 && /@agent/.test(item.body) && !/@agent/.test(best.body))) {
      best = item
      bestScore = score
    }
  }
  return best
}

// What to answer: a script of steps.
export function pickScript(text, context) {
  const lower = String(text || '').toLowerCase()
  const commentId = context.threadId.startsWith('comment-') ? Number(context.threadId.slice(8)) : null
  const comment = commentId ? context.comments.find((item) => item.id === commentId) : null
  const open = context.comments.filter((item) => item.status === 'open')
  // Fix with agent sends the comment with a crop near its pin: a fix, not a
  // question about the image.
  if (context.fix && comment) return fixScript(context, comment)
  // "@" mentions and text files from the composer (demo/backend/composer.js).
  const mentions = context.mentions || []
  const mentioned = mentions.find((item) => item.kind === 'comment' || item.kind === 'element')
  const mentionedComment = mentioned ? context.comments.find((item) => item.id === mentioned.id) : null
  if (mentionedComment && /fix|change|edit|update|make/.test(lower)) return fixScript(context, mentionedComment)
  if (context.files?.length) return fileScript(context)
  if (mentions.length) return mentionScript(context, mentions)
  if (context.attachments.length) return imageScript(context)
  // A reply cut off by the length limit, and Continue (messages.jsx CONTINUE_PROMPT).
  if (/^continue from where you stopped/.test(lower)) return continueScript(context)
  if (/\b(long|full) (report|review|answer)\b/.test(lower)) return longScript(context)
  if (comment && !/summar|open|what.s left/.test(lower)) return fixScript(context, comment)
  if (/fix|change|edit|update|make it|can you/.test(lower)) {
    const target = matchComment(text, open, context) || open.find(waitingForAgent) || open[0]
    if (target) return fixScript(context, target)
  }
  if (/summar|open|left|status|what/.test(lower) || !lower) return summaryScript(context, open)
  return helpScript(context)
}

function summaryScript(context, open) {
  const byPage = new Map()
  for (const item of open) byPage.set(item.pageId, (byPage.get(item.pageId) || 0) + 1)
  const top = [...byPage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  const waiting = open.filter((item) => item.agentStatus === 'needs-human').length
  const lines = top.map(([pageId, n]) => `- **${pageTitle(context, pageId)}**: ${n} open`).join('\n')
  return [
    { tool: { id: 'pages', name: 'list_pages', label: 'Read the pages' }, detail: `${context.pages.length} pages` },
    { tool: { id: 'list', name: 'list_comments', label: 'Read the open comments' }, detail: `${open.length} open on ${byPage.size} pages` },
    {
      say: open.length
        ? `There are **${open.length} open comments** on ${context.board.title}. The busiest pages:\n\n${lines}\n\n${
            waiting ? `${waiting} ${waiting === 1 ? 'is' : 'are'} waiting for a person to decide. ` : ''
          }Open a comment and choose **Ask agent** to work on one, or ask me to fix one.`
        : 'Nothing is open on this board. Everything has been resolved.',
    },
    {
      suggest: open.length
        ? [
            open.some(waitingForAgent) ? 'Fix the next @agent comment' : null,
            top[0] ? `Review the open comments on ${pageTitle(context, top[0][0])}` : null,
          ].filter(Boolean)
        : [],
    },
  ]
}

// An open comment that asks the agent and that it has not done yet.
const waitingForAgent = (item) => item.status === 'open' && /@agent/.test(item.body) && item.agentStatus !== 'done'

function fixScript(context, comment) {
  const page = pageTitle(context, comment.pageId)
  // "Fix the next @agent comment" only while there is another one.
  const more = context.comments.some((item) => item.id !== comment.id && waitingForAgent(item))
  // A variant's own page file (it lives on its branch), never "variant:<id>".
  const fileId = String(comment.pageId).startsWith('variant:') ? String(comment.pageId).slice(8) : comment.pageId
  const file = `src/pages/${fileId}.html`
  return [
    { status: 'Reading the comment' },
    { tool: { id: 'read', name: 'get_comment', label: `Read comment #${comment.id}` }, detail: `${page}, ${comment.viewport}` },
    { tool: { id: 'look', name: 'view_capture', label: `Look at ${page} (${comment.viewport})` }, detail: 'Capture and pinned element' },
    {
      plan: [
        { content: `Change ${page} as the comment asks`, status: 'in_progress' },
        { content: 'Recapture the page', status: 'pending' },
        { content: 'Reply on the comment', status: 'pending' },
      ],
    },
    { say: `"${comment.body.slice(0, 140)}${comment.body.length > 140 ? '...' : ''}"\n\nI can make that change in \`${file}\`. ` },
    {
      ask: {
        id: 'edit',
        kind: 'edit',
        title: `Edit ${file}`,
        detail: `A small change to ${page}, then a recapture. (Demo: nothing is edited.)`,
        // After an Allow: the answer and its run summary (a pretend edit).
        done: `Done. I made the button stand out in \`${file}\` for [[comment:${comment.id}]]:\n\n\`\`\`html\n<a class="button button-primary" href="/signup">Get started</a>\n\`\`\`\n\nIn a real run I would recapture ${String(comment.pageId).startsWith('variant:') ? 'the page' : `[[page:${comment.pageId}]]`} and reply on the comment so someone can check it and resolve it.`,
        summary: demoSummary(file, comment),
        suggest: more ? ['Fix the next @agent comment', "What's still open?"] : ["What's still open?"],
      },
    },
  ]
}

// The run summary of the pretend edit: one file, a small diff, Undo.
// Fictional, like everything the demo agent says.
function demoSummary(file, comment) {
  const preview = [
    '@@ -18,7 +18,7 @@',
    '   <section class="hero">',
    '     <h1>Plans for every team</h1>',
    '-    <a class="button" href="/signup">Get started</a>',
    '+    <a class="button button-primary" href="/signup">Get started</a>',
    '   </section>',
    '@@ -42,3 +42,5 @@',
    '   .button { padding: 0.5rem 1rem; }',
    '+  .button-primary { background: var(--accent); color: white;',
    '+    font-weight: 600; }',
  ].join('\n')
  return {
    kind: 'files',
    files: [
      {
        path: file,
        status: 'modified',
        added: 3,
        removed: 1,
        diff: { path: file, added: 3, removed: 1, created: false, outside: false, preview, full: null, truncated: false },
      },
    ],
    added: 3,
    removed: 1,
    commit: null,
    pr: null,
    resolved: [],
    recapture: String(comment.pageId).startsWith('variant:') ? [] : [comment.pageId],
    undo: { kind: 'files', available: true },
    undone: null,
  }
}

function fileScript(context) {
  const lines = context.files.map((file) => {
    // Lines as an editor counts them: a final newline does not start another.
    const body = String(file.text || '').replace(/\r?\n$/, '')
    const count = body ? body.split(/\r?\n/).length : 0
    return `- **${file.name}**: ${count} line${count === 1 ? '' : 's'}`
  })
  return [
    { status: 'Reading the files' },
    {
      tool: { id: 'files', name: 'read_file', label: 'Read the attached text' },
      detail: `${context.files.length} file${context.files.length === 1 ? '' : 's'}`,
    },
    {
      say: `I have the text of:\n\n${lines.join('\n')}\n\nIn the demo I only count lines. A real agent reads the text with your message, as data rather than instructions.`,
    },
    { suggest: ['Summarize the errors in this log', "What's still open?"] },
  ]
}

function mentionScript(context, mentions) {
  const lines = mentions.map((item) => {
    if (item.kind === 'page') {
      const open = context.comments.filter((comment) => comment.status === 'open' && comment.pageId === item.id).length
      return `- **${item.label}** (page): ${open} open comment${open === 1 ? '' : 's'}`
    }
    if (item.kind === 'journey') return `- **${item.label}** (journey): I would walk it page by page`
    if (item.kind === 'person') {
      const theirs = context.comments.filter((comment) => comment.status === 'open' && String(comment.body).includes(item.label)).length
      return `- **${item.label}**: mentioned in ${theirs} open comment${theirs === 1 ? '' : 's'}`
    }
    return `- **${item.label}** (${item.kind})`
  })
  const page = mentions.find((item) => item.kind === 'page')
  const comment = mentions.find((item) => item.kind === 'comment' || item.kind === 'element')
  return [
    { tool: { id: 'mentions', name: 'read_mentions', label: 'Read what you mentioned' }, detail: `${mentions.length} mentioned` },
    { say: `You mentioned:\n\n${lines.join('\n')}\n\nAsk me to fix or review any of them.` },
    {
      suggest: [
        comment ? `Fix comment #${comment.id}` : null,
        page ? `Review the open comments on ${page.label}` : null,
        "What's still open?",
      ].filter(Boolean),
    },
  ]
}

function imageScript(context) {
  const names = context.attachments.map((item) => `**${item.name}**`).join(', ')
  const from = context.attachments.find((item) => item.source?.pageId)
  return [
    { status: 'Looking at the image' },
    {
      tool: { id: 'image', name: 'view_image', label: 'Look at the attached image' },
      detail: `${context.attachments.length} image${context.attachments.length === 1 ? '' : 's'}`,
    },
    {
      say: `I can see ${names}${from ? ` (from ${pageTitle(context, from.source.pageId)})` : ''}. In the demo I do not read pixels, but a real agent gets the image with your message. Ask about spacing, copy or contrast and it answers about what it sees.`,
    },
  ]
}

function longScript(context) {
  const pages = context.pages.slice(0, 4).map((page) => page.title)
  return [
    { tool: { id: 'pages', name: 'list_pages', label: 'Read the pages' }, detail: `${context.pages.length} pages` },
    {
      say: `Here is a full review of ${context.board?.title || 'the board'}, page by page.\n\n${pages
        .map(
          (title) =>
            `### ${title}\n\nThe layout reads well on desktop. On phones the first screen is busy: the headline, two buttons and a banner compete for attention, and the main action sits below the fold. Shorter copy and one primary button would help.`,
        )
        .join('\n\n')}\n\n### Across the site\n\nSpacing between sections changes from page to page, and`,
    },
    { limit: 'length' },
  ]
}

function continueScript() {
  return [
    {
      say: 'buttons use three different corner radii. Pick one spacing step and one radius and the pages will feel like one product. (Demo: this is the rest of the scripted review.)',
    },
  ]
}

function helpScript() {
  return [
    {
      say: "I'm the demo agent: my answers are scripted, and nothing leaves this browser. Try:\n\n- **What's still open?** for a summary\n- **Fix the next @agent comment** to see a plan, its steps and an approval\n- **Give me a full review** for a long answer that runs into the length limit\n- type **@** to mention a page or a comment, or **/** for commands\n- attach a screenshot or a text file with the paperclip\n\nConnect your own agent (an OpenAI-compatible endpoint or an agent CLI over ACP) to get real answers.",
    },
    { suggest: ["What's still open?", 'Fix the next @agent comment'] },
  ]
}

// The second demo agent says the same things in fewer words: its first
// paragraph only, opened with "Short version." and signed off as itself, so
// a visitor can tell the two apart after switching.
export function voiced(steps, voice = 'demo') {
  if (voice !== 'second') return steps
  let first = true
  return steps.map((step) => {
    if (!step.say || !first) return step
    first = false
    const lead = String(step.say).split(/\n\n/)[0]
    return { ...step, say: `Short version. ${lead}\n\n(Second agent, scripted for the demo.)` }
  })
}

const words = (text) => text.match(/\S+\s*|\s+/g) || []
// Rough token counts for the demo's usage ring (about 4 characters a token).
const tokens = (text) => Math.max(1, Math.round(String(text || '').length / 4))

// Runs a script as a generator of [event, data]; returns the stored reply.
export async function* runScriptedTurn({ text, context, signal, run, now = () => Date.now(), voice = 'demo' }) {
  const startedAt = now()
  const reply = {
    id: `msg_${now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    role: 'assistant',
    text: '',
    cards: [],
    model: 'scripted',
    status: 'done',
    createdAt: new Date(now()).toISOString(),
  }
  // Text and cards in the order they happened, as on the server (reply-text.js).
  const flow = replyText(reply)
  const card = (entry) => {
    const index = reply.cards.findIndex((item) => item.id === entry.id)
    if (index >= 0) reply.cards[index] = { ...reply.cards[index], ...entry }
    else reply.cards.push(flow.place(entry))
    flow.mark()
    return ['tool', reply.cards[index >= 0 ? index : reply.cards.length - 1]]
  }
  async function* say(value) {
    for (const word of words(value)) {
      if (signal.aborted) return
      const piece = flow.piece(word)
      reply.text += piece
      yield ['text', { text: piece }]
      await sleep(18 + Math.random() * 30, signal)
    }
  }
  yield ['status', { text: 'Thinking' }]
  await sleep(350, signal)
  // Regenerate: the script is the same, so the new version says it is another try.
  if (context.regenerate) yield* say('Another take on this. ')
  for (const step of voiced(pickScript(text, context), voice)) {
    if (signal.aborted) break
    if (step.status) {
      yield ['status', { text: step.status }]
      await sleep(300, signal)
    } else if (step.tool) {
      yield card({ ...step.tool, kind: 'tool', state: 'running', detail: null })
      await sleep(500, signal)
      if (signal.aborted) break
      yield card({ id: step.tool.id, state: 'done', detail: step.detail || null })
    } else if (step.plan) {
      yield card({ id: 'plan', kind: 'plan', name: 'plan', label: 'Plan', entries: step.plan })
    } else if (step.say) {
      yield* say(step.say)
    } else if (step.limit) {
      // As a real backend does when the model runs out of room (run.js).
      reply.limit = step.limit
    } else if (step.suggest) {
      if (step.suggest.length) reply.suggestions = step.suggest.slice(0, 3)
    } else if (step.ask) {
      // An approval card; the answer comes in through run.answer (POST .../permissions/:id).
      const options = [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ]
      const answered = new Promise((resolve) => {
        run.answer = (id, optionId) => {
          if (id !== step.ask.id) return null
          if (optionId !== null && !options.some((option) => option.optionId === optionId)) return false
          resolve(optionId)
          run.answer = null
          return optionId === 'allow' ? 'approved' : 'denied'
        }
        signal.addEventListener('abort', () => resolve(undefined), { once: true })
      })
      yield card({
        id: step.ask.id,
        kind: 'permission',
        name: step.ask.kind,
        label: step.ask.title,
        detail: step.ask.detail,
        state: 'pending',
        options,
        chosen: null,
        expiresAt: new Date(now() + 5 * 60_000).toISOString(),
      })
      yield ['status', { text: 'Waiting for your answer' }]
      const choice = await answered
      if (choice === undefined) break
      const approved = choice === 'allow'
      yield card({ id: step.ask.id, state: approved ? 'approved' : 'denied', chosen: approved ? 'Allow' : 'Deny' })
      if (approved) {
        yield card({ id: 'edit-run', kind: 'tool', name: 'edit', label: 'Edit the page (pretend)', state: 'running', detail: null })
        await sleep(600, signal)
        yield card({ id: 'edit-run', state: 'done', detail: '1 file changed' })
        yield card({
          id: 'plan',
          entries: reply.cards.find((item) => item.id === 'plan')?.entries?.map((entry) => ({ ...entry, status: 'completed' })) || [],
        })
        yield* say(
          step.ask.done ||
            'Done. In a real run I would recapture the page and reply on the comment so someone can check it and resolve it.',
        )
        if (step.ask.summary && !signal.aborted) reply.summary = step.ask.summary
        reply.suggestions = step.ask.suggest || ["What's still open?"]
      } else {
        yield* say('Okay, I left it as it is. Tell me what you would rather change.')
      }
    }
  }
  if (signal.aborted) {
    reply.status = 'stopped'
    for (const item of reply.cards) {
      if (item.state === 'running') item.state = 'error'
      if (item.state === 'pending') item.state = 'cancelled'
    }
  }
  const full = reply.text
  reply.text = reply.text.trim()
  settleCardPositions(reply, full)
  reply.durationMs = Math.max(0, now() - startedAt)
  // The model and level the chat chose, for the answer's meta line.
  const used = demoUsedOptions(context.options)
  if (used.length) {
    reply.options = used
    reply.model = context.options.find((option) => option.category === 'model')?.currentValue || reply.model
  }
  if (reply.status !== 'done') delete reply.suggestions
  // Usage as a real agent reports it: this answer's tokens and the session's
  // context (fictional numbers, a 128k window).
  const files = (context.files || []).reduce((sum, file) => sum + tokens(file.text), 0)
  const input = 900 + tokens(text) + (context.history || 0) * 120 + files
  const output = tokens(reply.text) + reply.cards.length * 40
  reply.usage = { input, output, total: input + output, contextUsed: input + output, contextSize: 128000 }
  yield ['usage', reply.usage]
  return reply
}
