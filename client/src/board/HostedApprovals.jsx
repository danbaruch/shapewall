// Hosted boards: the strip above the board with what waits for this
// person's OK, so an admin sees it with every panel closed.
//
//   - shell commands an agent that takes comments asked to run (answered
//     here, with a passkey);
//   - requests of a connected agent in the middle of a fix (edit a file, run
//     a command): each is a card in its comment's chat, where the diff is.
//     The strip names it and opens that chat; the answer is given there.
import { useEffect, useState } from 'react'
import { ShieldQuestion } from 'lucide-react'
import { api } from '../lib/api'
import { api as consoleApi } from '../console/lib/api'
import { getPasskey } from '../console/lib/webauthn'
import { Button } from '../components/ui'

export async function confirmHostedPasskey() {
  const { options } = await consoleApi.post('/auth/reauth/options', {})
  const response = await getPasskey(options)
  await consoleApi.post('/auth/reauth/verify', { response })
}

// What the server sends the board when a shared chat or the agents changed
// (chat/useHostedTurn.js HOSTED_AGENTS_EVENT; not imported: the chat loads later).
const HOSTED_AGENTS_EVENT = 'shapewall:hosted-agents'

// Text an agent wrote, shown as text: control and direction characters as their codes.
const plain = (text) =>
  String(text || '').replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )

const sameCards = (a, b) => a.length === b.length && a.every((card, index) => card.id === b[index].id && card.thread === b[index].thread)

// "comment-3" -> 3 (null for the board's chat).
const commentOf = (thread) => (/^comment-(\d+)$/.test(thread || '') ? Number(thread.slice(8)) : null)
// Where a card waits, in words.
export const cardPlace = (thread) => (commentOf(thread) ? `comment #${commentOf(thread)}` : 'the board chat')

// `onRows(rows)`: the board hears what is waiting (the toolbar's agent
// activity counts an approval as "needs your OK"). A chat card is a row
// too: { id, chat: true, commentId }.
// `onOpenThread(threadId)`: opens the Agent panel at a chat (null: the
// board has no chat, and the cards are not listed).
export function HostedApprovals({ boardId, onRows = null, onOpenThread = null }) {
  const [rows, setRows] = useState([])
  const [cards, setCards] = useState([])
  const chat = Boolean(onOpenThread)
  useEffect(() => {
    onRows?.([...rows, ...cards.map((card) => ({ id: `card-${card.id}`, chat: true, commentId: commentOf(card.thread) }))])
  }, [onRows, rows, cards])
  const [budget, setBudget] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const url = `/api/boards/${encodeURIComponent(boardId)}/approvals`
  useEffect(() => {
    let live = true
    const loadBudget = () =>
      api
        .get(`/api/boards/${encodeURIComponent(boardId)}/agent-budget`)
        .then((data) => {
          if (live) setBudget(data)
        })
        .catch(() => {})
    const load = () =>
      api
        .get(url)
        .then((data) => {
          if (live) setRows(data.approvals)
        })
        .catch(() => {})
    // The cards of connected agents that this person may answer (never a private chat's).
    const loadCards = () =>
      chat
        ? api
            .get(`/api/agent/boards/${encodeURIComponent(boardId)}/permissions`)
            .then((data) => {
              const next = Array.isArray(data?.permissions) ? data.permissions : []
              // The same cards as last time: nothing to draw again.
              if (live) setCards((current) => (sameCards(current, next) ? current : next))
            })
            .catch(() => {})
        : null
    load()
    loadCards()
    loadBudget()
    // Not while the tab is in the background; coming back loads at once.
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      load()
      loadCards()
      loadBudget()
    }
    const timer = setInterval(tick, 3000)
    document.addEventListener('visibilitychange', tick)
    // The server says a shared chat changed (a card arrived or was answered).
    const onChange = () => loadCards()
    window.addEventListener(HOSTED_AGENTS_EVENT, onChange)
    return () => {
      live = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
      window.removeEventListener(HOSTED_AGENTS_EVENT, onChange)
    }
  }, [url, boardId, chat])
  const answer = async (row, state) => {
    setBusy(true)
    setError(null)
    try {
      // Always request a fresh passkey before approving a shell command.
      await confirmHostedPasskey()
      await api.post(`${url}/${row.id}`, { state, hash: row.command_hash })
      setRows((rows) => rows.filter((r) => r.id !== row.id))
    } catch (error) {
      setError(error.message)
    } finally {
      setBusy(false)
    }
  }
  if (!rows.length && !cards.length && !error && !budget?.exhausted) return null
  return (
    <section aria-label="Agent approvals" className="max-h-64 shrink-0 overflow-auto border-b border-line bg-surface p-3 text-sm">
      {budget?.exhausted ? (
        <p role="status" className="pb-2">
          The agent hit today’s limit: {budget.claims}/{budget.dailyLimit} runs, {budget.open}/{budget.openLimit} in progress. Change limits
          in Agent policy in the console.
        </p>
      ) : null}
      {cards.length ? (
        <ul className="space-y-1.5 pb-1" aria-label="Requests waiting for your answer" data-sw-hosted-cards={cards.length}>
          {cards.map((card) => (
            <li
              key={`${card.thread}/${card.id}`}
              className="flex min-w-0 flex-col gap-2 rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 sm:flex-row sm:items-center"
              data-sw-hosted-card={card.id}
              data-sw-hosted-card-thread={card.thread}
            >
              <ShieldQuestion size={15} className="hidden shrink-0 text-warn sm:block" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-medium break-words text-fg">
                  {card.agent?.name || 'An agent'} asks before it acts, on {cardPlace(card.thread)}
                </p>
                <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs text-muted">
                  <span className="shrink-0">{card.name === 'execute' ? 'Run a command:' : 'Edit a file:'}</span>
                  <code className="min-w-0 truncate font-mono text-fg">{plain(card.detail || card.label)}</code>
                </p>
              </div>
              <Button
                size="touch"
                variant="default"
                className="shrink-0 lg:h-8"
                onClick={() => onOpenThread(card.thread)}
                data-sw-hosted-card-open={card.thread}
              >
                Review and answer
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {rows.map((row) => (
        <article key={row.id} className="space-y-2 pb-3">
          <p className="font-semibold">Agent asks to run a command for comment #{row.comment_number}</p>
          <pre className="overflow-auto rounded bg-surface-2 p-2 break-words whitespace-pre-wrap">{plain(row.command)}</pre>
          <p>{row.reason}</p>
          <Button size="touch" variant="default" className="lg:h-8" disabled={busy} onClick={() => answer(row, 'approved')}>
            Approve once with passkey
          </Button>{' '}
          <Button size="touch" variant="danger" className="lg:h-8" disabled={busy} onClick={() => answer(row, 'denied')}>
            Deny
          </Button>
        </article>
      ))}
      {error ? (
        <p role="alert" className="text-bad">
          {error}
        </p>
      ) : null}
    </section>
  )
}
