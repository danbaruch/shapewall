// The Contact link in the profile menu and the console footer (the board, the console and the public demo).
export const CONTACT_URL = 'https://shapewall.com/contact'

export const BUILD = {
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.1.0',
  revision: typeof __APP_REVISION__ === 'string' ? __APP_REVISION__ : null,
}
export const VERSION = (value) => `v${value?.version || BUILD.version}${value?.revision ? ` · ${value.revision.slice(0, 7)}` : ''}`
