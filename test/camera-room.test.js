// Unit tests for camera.js top-overlay clearance (F26): height-constrained
// desktop boards, Shift+1 Fit, and phone boards never put the first group
// label behind CanvasNotes, FollowBar or PresenceBar.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FOLLOW_ROOM, PHONE_FOLLOW_ROOM, PHONE_TIP_ROOM, START_TOP_BASE, TIP_ROOM, fitWholeViewport } from '../client/src/board/camera.js'

const LABEL_ROOM = 28

// Two tall pages side-by-side inside a group frame: height-constrained on 1280x768.
const tallBoard = [
  { id: 'group-main', type: 'groupFrame', position: { x: 0, y: 0 }, width: 920, height: 1400 },
  { id: 'home', type: 'page', position: { x: 24, y: 24 }, width: 420, height: 1350 },
  { id: 'pricing', type: 'page', position: { x: 476, y: 24 }, width: 420, height: 1350 },
]

test('fitWholeViewport keeps the first group label below FollowBar and PresenceBar on 1280x768 height-constrained boards', () => {
  const box = { width: 1280, height: 712 }
  for (const padding of [0.06, 0.16]) {
    const view = fitWholeViewport(tallBoard, box, { padding, top: FOLLOW_ROOM, maxZoom: 1 })
    assert.ok(view)
    const frameTop = view.y + tallBoard[0].position.y * view.zoom
    const labelTop = frameTop - LABEL_ROOM
    const boardBottom = frameTop + tallBoard[0].height * view.zoom
    // FollowBar (top-14: 56..94px) and PresenceBar (top-14: 56..98px) both end <= 98px.
    assert.ok(labelTop >= 100, `padding=${padding}: labelTop=${labelTop} must clear FollowBar/PresenceBar (98px)`)
    assert.ok(boardBottom <= box.height, `padding=${padding}: boardBottom=${boardBottom} fits inside ${box.height}`)
  }
})

test('fitWholeViewport keeps the first group label below CanvasNotes tip when top is TIP_ROOM', () => {
  const box = { width: 1280, height: 712 }
  const view = fitWholeViewport(tallBoard, box, { padding: 0.06, top: TIP_ROOM, maxZoom: 1 })
  assert.ok(view)
  const labelTop = view.y - LABEL_ROOM
  // CanvasNotes single row sits at top-3 (12..48px).
  assert.ok(labelTop >= 56, `labelTop=${labelTop} must clear CanvasNotes`)
  assert.equal(view.y, START_TOP_BASE + TIP_ROOM)
})

test('fitWholeViewport reserves phone FollowBar/PresenceBar room on 390x788 canvas', () => {
  const box = { width: 390, height: 788 }
  const hostedView = fitWholeViewport(tallBoard, box, { top: PHONE_FOLLOW_ROOM })
  assert.ok(hostedView)
  // Phone PresenceBar (56..110px) + FollowBar at top-28 (112..156px).
  assert.ok(hostedView.y - LABEL_ROOM >= 160, `phone hosted labelTop=${hostedView.y - LABEL_ROOM} must clear FollowBar (156px)`)

  const tipView = fitWholeViewport(tallBoard, box, { top: PHONE_TIP_ROOM })
  assert.ok(tipView)
  assert.ok(tipView.y - LABEL_ROOM >= 70, `phone tip labelTop=${tipView.y - LABEL_ROOM} must clear CanvasNotes (68px)`)
})

test('fitWholeViewport with top=0 preserves default framing and never produces negative zoom on tiny boxes', () => {
  const normal = fitWholeViewport(tallBoard, { width: 1280, height: 712 }, { top: 0 })
  assert.ok(normal && normal.zoom > 0)
  assert.ok(normal.y >= LABEL_ROOM)

  const tiny = fitWholeViewport(tallBoard, { width: 320, height: 80 }, { top: FOLLOW_ROOM })
  assert.ok(tiny && tiny.zoom > 0)
})
