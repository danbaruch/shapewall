// /account: profile, passkeys (add, rename, remove), recovery codes, and
// sessions (sign out one device or all others). Sensitive changes ask for
// a passkey check first (the server decides; see ReauthProvider).

import { History, KeyRound, LifeBuoy, MonitorSmartphone, UserRound } from 'lucide-react'
import { Notice, PageHeader } from '../components'
import { useSession } from '../state'
import { SidebarSections } from '../shell'
import { Profile } from './account/profile'
import { Passkeys } from './account/passkeys'
import { Recovery } from './account/recovery'
import { Sessions } from './account/sessions'
import { SecurityLog } from './account/activity'
import { DeleteAccount } from './account/delete'
import { TailnetAccount } from './tailnet'

export function AccountPage() {
  const { me } = useSession()
  const jump = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return (
    <div>
      {/* On a desktop the app sidebar lists the sections (shell.jsx). */}
      <SidebarSections
        label="Account"
        sections={ACCOUNT_SECTIONS.filter(([id]) => !me?.passkeysOff || !['account-passkeys', 'account-recovery'].includes(id)).map(
          ([id, label, Icon]) => ({
            id: `account-nav-${id}`,
            label,
            icon: Icon,
            onSelect: () => jump(id),
            'data-sw-account-nav': id,
          }),
        )}
      />
      <div className="min-w-0">
        <PageHeader
          title="Account and security"
          description={
            me?.passkeysOff
              ? 'Your profile, how you sign in and your signed-in devices.'
              : 'Your profile, the passkeys you sign in with, recovery codes and signed-in devices.'
          }
        />
        <div className="grid gap-5">
          {me?.local ? (
            <Notice title="Security on this installation">
              Signing out ends your Shapewall session. Private-network access and device pairing are managed separately.
            </Notice>
          ) : null}
          <Profile />
          {me?.passkeysOff ? null : <Passkeys />}
          <TailnetAccount />
          {me?.passkeysOff ? null : <Recovery />}
          <Sessions />
          <SecurityLog />
          <DeleteAccount />
        </div>
      </div>
    </div>
  )
}

const ACCOUNT_SECTIONS = [
  ['account-profile', 'Profile', UserRound],
  ['account-passkeys', 'Passkeys', KeyRound],
  ['account-recovery', 'Recovery codes', LifeBuoy],
  ['account-devices', 'Signed-in devices', MonitorSmartphone],
  ['activity', 'Activity', History],
]
