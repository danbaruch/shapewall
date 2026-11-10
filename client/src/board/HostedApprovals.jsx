import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { api as consoleApi } from '../console/lib/api'
import { getPasskey } from '../console/lib/webauthn'
import { Button } from '../components/ui'

export async function confirmHostedPasskey() {
  const { options } = await consoleApi.post('/auth/reauth/options', {})
  const response = await getPasskey(options)
  await consoleApi.post('/auth/reauth/verify', { response })
}

export function HostedApprovals({ boardId }) {
  const [rows, setRows] = useState([])
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
    load()
    loadBudget()
    // Not while the tab is in the background; coming back loads at once.
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      load()
      loadBudget()
    }
    const timer = setInterval(tick, 3000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      live = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [url, boardId])
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
  if (!rows.length && !error && !budget?.exhausted) return null
  return (
    <section aria-label="Agent command approvals" className="max-h-64 shrink-0 overflow-auto border-b border-line bg-surface p-3 text-sm">
      {budget?.exhausted ? (
        <p role="status" className="pb-2">
          The agent hit today’s limit: {budget.claims}/{budget.dailyLimit} runs, {budget.open}/{budget.openLimit} in progress. Change limits
          in Agent policy in the console.
        </p>
      ) : null}
      {rows.map((row) => (
        <article key={row.id} className="space-y-2 pb-3">
          <p className="font-semibold">Agent asks to run a command for comment #{row.comment_number}</p>
          <pre className="overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2">
            {row.command.replace(
              // eslint-disable-next-line no-control-regex
              /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
              (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
            )}
          </pre>
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
