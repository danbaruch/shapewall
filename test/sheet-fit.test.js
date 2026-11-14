// How tall the phone's thread sheet may be: it has to leave a strip of board
// above itself for the pin to land on, whatever sits over the canvas
// (client/src/board/sheetFit.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SHEET_CHROME, SHEET_MIN, SHEET_SHARE, SHEET_STRIP, sheetContentMax, sheetPanelMax } from '../client/src/board/sheetFit.js'
import { PHONE_SHEET_GAP, PHONE_TOP_ROOM, phoneFloor } from '../client/src/board/commentFocus.js'

// A phone, as measured on the demo board: 844 px tall, the canvas starting
// 102 px down with the toolbar over it, and 247 px down in compare mode,
// where the compare bar takes another 145 px.
const PHONE = 844
const PLAIN_TOP = 102
const COMPARE_TOP = 247

test('the strip is exactly what the pin needs: its own room and its gap', () => {
  assert.equal(SHEET_STRIP, PHONE_TOP_ROOM + PHONE_SHEET_GAP)
})

test('nothing over the canvas: the sheet keeps the share 0.7.2 settled on', () => {
  // The strip is not the binding rule here, so the sheet is as tall as it
  // has been since 0.7.2 and nothing about those boards changes.
  assert.equal(sheetContentMax({ windowHeight: PHONE, canvasTop: PLAIN_TOP }), Math.round(PHONE * SHEET_SHARE))
  assert.equal(sheetContentMax({ windowHeight: PHONE, canvasTop: 0 }), Math.round(PHONE * SHEET_SHARE))
})

test('compare mode pushes the canvas down, so the sheet gives way, not the board', () => {
  const content = sheetContentMax({ windowHeight: PHONE, canvasTop: COMPARE_TOP })
  const panel = sheetPanelMax({ windowHeight: PHONE, canvasTop: COMPARE_TOP })
  assert.ok(content < Math.round(PHONE * SHEET_SHARE), `${content} is shorter than the plain share`)
  // The board left above the sheet is the strip, to the pixel.
  assert.equal(PHONE - panel - COMPARE_TOP, SHEET_STRIP)
})

test('the strip is enough for the pin: phoneFloor leaves its full gap', () => {
  // What the camera does with it (useCameraMoves.js measures the real sheet
  // and hands its top to phoneFloor, in pixels from the canvas's top).
  const panel = sheetPanelMax({ windowHeight: PHONE, canvasTop: COMPARE_TOP })
  const canvas = { height: PHONE - COMPARE_TOP, width: 390 }
  const sheetTop = PHONE - panel - COMPARE_TOP
  const floor = phoneFloor(canvas, sheetTop)
  assert.equal(floor, PHONE_TOP_ROOM, 'the pin gets its own room at the top of the canvas')
  assert.ok(sheetTop - floor >= PHONE_SHEET_GAP, `${sheetTop - floor} px of gap above the sheet`)
})

test('a bar twice as tall takes twice as much off the sheet, not off the board', () => {
  for (const top of [102, 160, 247, 320, 420]) {
    const panel = sheetPanelMax({ windowHeight: PHONE, canvasTop: top })
    assert.ok(top + panel <= PHONE - SHEET_STRIP, `canvas at ${top}: sheet of ${panel} leaves ${PHONE - panel - top}`)
  }
})

test('a canvas squeezed to nothing keeps a readable sheet rather than an unreadable one', () => {
  // There is no room for both; the pin then takes the highest spot there is
  // (phoneFloor clamps to PHONE_TOP_ROOM) and the thread stays readable.
  assert.equal(sheetContentMax({ windowHeight: 400, canvasTop: 330 }), SHEET_MIN)
  assert.equal(sheetContentMax({ windowHeight: PHONE, canvasTop: 700 }), SHEET_MIN)
})

test('no canvas to measure (a desktop, or before the first layout): the share alone', () => {
  assert.equal(sheetContentMax({ windowHeight: PHONE }), Math.round(PHONE * SHEET_SHARE))
  assert.equal(sheetContentMax({ windowHeight: PHONE, canvasTop: null }), Math.round(PHONE * SHEET_SHARE))
  assert.equal(sheetContentMax({ windowHeight: 0 }), null)
  assert.equal(sheetPanelMax({ windowHeight: 0 }), null)
})

test('the panel ceiling is the content cap plus the sheet chrome', () => {
  assert.equal(
    sheetPanelMax({ windowHeight: PHONE, canvasTop: COMPARE_TOP }),
    sheetContentMax({ windowHeight: PHONE, canvasTop: COMPARE_TOP }) + SHEET_CHROME,
  )
})
