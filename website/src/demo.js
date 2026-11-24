// What the marketing pages say about the live demo and the hero media, in one place, so a new demo or new videos only
// change this file (and src/media.json, which the encode script writes).

// How many screens the live demo's fictional app (Brackwell, scripts/demo-brackwell.js) has. Null describes the demo
// without a number.
export const DEMO_SCREENS = 146
export const DEMO_APP = DEMO_SCREENS ? `a fictional app with ${DEMO_SCREENS} screens` : 'a fictional app'

// The film the home page hero plays inside its screenshot: an id in src/media.json (its poster, sources and captions)
// and in FILMS (src/videos.js, its name and structured data). Swap the id to swap the film.
export const HERO_FILM = 'tour'

// The two notes floating over the hero screenshot (src/assets/shots/board-overview-*.webp). They describe that
// screenshot, so change them together with it.
export const HERO_NOTES = {
  resolved: { title: 'Agent resolved #1', text: 'Added Assign to the selection bar. Work orders recaptured.' },
  open: { count: 12, text: 'open instructions on 146 screens' },
}

// The first four commands, the same as the Getting started page and the README.
export const QUICKSTART = [
  { command: 'npx shapewall doctor --install-browser', note: 'gets Chromium, checks it runs' },
  { command: 'npx shapewall init --base-url http://localhost:3000', note: 'finds screens, writes the config' },
  { command: 'npx shapewall capture', note: 'every screen, desktop and phone' },
  { command: 'npx shapewall serve --open', note: 'opens the wall' },
]
