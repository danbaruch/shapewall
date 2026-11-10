import { History, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Button, Spinner } from '../../../components/ui'
import { Card, CardHeader, LoadError, Loading, Time } from '../../components'
import { usePagedLoad } from '../../state'

// What happened to this account, newest first: sign-ins (and how), passkeys
// added or removed, recovery codes, devices signed out.
const SECURITY_LABEL = {
  account_created: () => 'Account created',
  signed_in: (detail) =>
    detail.via === 'recovery_code'
      ? 'Signed in with a recovery code'
      : detail.via === 'rebind'
        ? 'Signed in after moving to a new address'
        : detail.newDevice
          ? 'Signed in on a new device'
          : 'Signed in with a passkey',
  passkey_added: (detail) =>
    detail.via === 'rebind'
      ? 'Passkey added for the new address'
      : detail.viaRecovery
        ? 'Passkey added after a recovery-code sign-in'
        : 'Passkey added',
  rebind_started: () => 'Started moving your sign-in to a new address',
  passkey_removed: () => 'Passkey removed',
  passkey_renamed: () => 'Passkey renamed',
  recovery_codes_created: () => 'New recovery codes made',
  sessions_revoked: () => 'Signed out every other device',
  session_revoked: () => 'Signed out a device',
  workspace_deleted: () => 'Deleted a workspace',
}
export function securityLabel(event) {
  const label = SECURITY_LABEL[event.action]
  return label ? label(event.detail || {}) : event.action.replaceAll('_', ' ')
}
function securityExtra(event) {
  const detail = event.detail || {}
  const parts = []
  if (detail.device) parts.push(detail.device)
  if (detail.otherSessionsEnded) parts.push('other devices signed out')
  if (typeof detail.codesLeft === 'number') parts.push(`${detail.codesLeft} ${detail.codesLeft === 1 ? 'code' : 'codes'} left`)
  if (event.ip) parts.push(event.ip)
  return parts.join(' · ')
}

const securityLogUrl = (before) => `/auth/security-log${before ? `?before=${before}` : ''}`

export function SecurityLog() {
  const log = usePagedLoad(securityLogUrl, 'events')
  const events = log.items
  return (
    <Card id="activity" className="scroll-mt-20" data-sw-security-log>
      <CardHeader icon={History} title="Account activity" description="Sign-ins and security changes on your account." />
      {log.error ? (
        <div className="p-4">
          <LoadError error={log.error} onRetry={events.length ? log.loadMore : log.reload} />
        </div>
      ) : null}
      {!log.loading && !log.error && !events.length ? <p className="px-4 py-4 text-sm text-muted sm:px-5">Nothing yet.</p> : null}
      <ul className="divide-y divide-line">
        {events.map((event) => {
          const warn = event.action === 'signed_in' && (event.detail?.via === 'recovery_code' || event.detail?.newDevice)
          return (
            <li key={event.id} className="flex items-start gap-3 px-4 py-3 sm:px-5" data-sw-security-event={event.action}>
              <span
                className={
                  warn
                    ? 'mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-warn/10 text-warn'
                    : 'mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted'
                }
              >
                {warn ? <ShieldAlert size={14} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-fg">{securityLabel(event)}</p>
                <p className="mt-0.5 text-xs text-muted">
                  <Time value={event.at} />
                  {securityExtra(event) ? ` · ${securityExtra(event)}` : ''}
                </p>
              </div>
            </li>
          )
        })}
      </ul>
      {log.loading ? <Loading /> : null}
      {log.next && !log.loading ? (
        <div className="px-4 pb-4 sm:px-5">
          <Button size="touch" variant="secondary" onClick={log.loadMore} disabled={log.more} className="lg:h-9">
            {log.more ? <Spinner /> : null} Show older
          </Button>
        </div>
      ) : null}
    </Card>
  )
}
