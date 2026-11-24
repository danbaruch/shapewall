import ChatPanel from './ChatPanel'
import { TOKEN_HINT } from '../settings/SettingsHint'

// The board's chat panel, loaded on first open. The settings hint is
// resolved here so the board's main chunk does not need it.
export default function BoardChat({ settingsLocked, ...props }) {
  return <ChatPanel {...props} settingsHint={settingsLocked ? TOKEN_HINT : null} />
}
