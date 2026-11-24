import { Building2, Flag, Settings, UserRound } from 'lucide-react'
import { leavePage } from '../lib/hooks'
import { ProfileMenu } from '../components/profile-menu'

// Under the name in the profile menu: the account, a share link guest, or a
// board on this machine (no accounts).
function profileDetail(info) {
  if (info?.public) return 'Visitor, public board (view only)'
  if (info?.guest) return 'Guest, through a share link'
  if (info?.hosted) return [info.user?.handle ? `@${info.user.handle}` : null, roleLabel(info.role)].filter(Boolean).join(' · ')
  return 'A board on this machine'
}
const roleLabel = (role) => (role ? role[0].toUpperCase() + role.slice(1) : null)

// You: the profile menu, with the ways out of the board (settings, the
// console, sharing) for this kind of board. In the compact toolbar on a phone,
// at the bottom of the app rail on a desktop.
export function BoardProfile({
  info,
  localName,
  onOpenBuzz,
  demo,
  localSettingsAvailable,
  settingsAvailable,
  openSettings,
  setShareOpen,
  side,
  align,
  showName,
  triggerClassName,
}) {
  return (
    <ProfileMenu
      name={info?.user?.name || localName || null}
      avatarUrl={info?.user?.avatarUrl}
      detail={profileDetail(info)}
      items={[
        // Only on an install with the Buzz bridge on (the server says so).
        ...(info?.buzzAvailable === true
          ? [{ id: 'buzz', label: 'Existing Buzz conversation', icon: Settings, onSelect: onOpenBuzz, 'data-sw-buzz-open': 'true' }]
          : []),
        // The local console is available even when agent chat is off.
        ...(localSettingsAvailable
          ? [
              { id: 'account', label: 'Account and security', icon: UserRound, onSelect: () => leavePage('/account') },
              {
                id: 'console',
                label: 'Workspace Console',
                icon: Building2,
                onSelect: () => leavePage('/console'),
              },
            ]
          : settingsAvailable
            ? [{ id: 'settings', label: 'Settings', icon: Settings, onSelect: openSettings, 'data-sw-settings-open': 'profile' }]
            : []),
        ...(info?.shareEnabled
          ? [{ id: 'share', label: 'Share with your team...', icon: Building2, onSelect: () => setShareOpen(true) }]
          : []),
        ...(info?.consoleUrl && !info?.guest
          ? [{ id: 'console', label: 'Workspace Console', icon: Building2, onSelect: () => leavePage(info.consoleUrl) }]
          : []),
        // A public board: tell the server's operator about it (a mailto: link).
        ...(info?.public && typeof info.reportUrl === 'string' && info.reportUrl.startsWith('mailto:')
          ? [{ id: 'report', label: 'Report this board', icon: Flag, onSelect: () => leavePage(info.reportUrl) }]
          : []),
        ...(demo ? [demo.resetItem] : []),
      ]}
      viewAs={demo?.viewAs || null}
      side={side}
      align={align}
      showName={showName}
      triggerClassName={triggerClassName}
    />
  )
}
