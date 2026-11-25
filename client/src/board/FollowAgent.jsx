import { FollowBar } from './FollowBar'
import { useFollowAgent } from './hooks/useFollowAgent'

// Follow mode, loaded by the board only once there is something to follow
// (a `follow=` request, or an agent to offer): the hook that turns what the
// board knows into moves (hooks/useFollowAgent.js) and its bar (FollowBar.jsx),
// in their own chunk, out of the main bundle.
export default function FollowAgent({ candidates, touch, belowPresence, titleOf, ...options }) {
  const following = useFollowAgent({ ...options, titleOf })
  return <FollowBar following={following} candidates={candidates} touch={touch} belowPresence={belowPresence} titleOf={titleOf} />
}
