// The launch switch: one place that says whether Shapewall is public yet. Every page, the head tags and the docs
// read it, so flipping it changes the whole site at once.
//
//   SHAPEWALL_LAUNCHED=0 (the default)  private early access: the repository is invite only, no install command.
//   SHAPEWALL_LAUNCHED=1                launched: the public repository, a real install command, a free Offer in
//                                       the structured data, Changelog and Security links to GitHub.
//
// It is a build-time setting (see README.md, "Launch runbook"). Vite replaces __SHAPEWALL_LAUNCHED__ in the client
// and the prerender bundle (vite.config.js); plain Node (scripts, tests) reads the environment variable itself.
// Search indexing is a separate switch, SHAPEWALL_STEALTH (scripts/prerender.mjs).
/* global __SHAPEWALL_LAUNCHED__ */
const flag = typeof __SHAPEWALL_LAUNCHED__ !== 'undefined' ? __SHAPEWALL_LAUNCHED__ : process.env.SHAPEWALL_LAUNCHED

export const LAUNCHED = String(flag ?? '').trim() === '1'

// True once `shapewall` is on the npm registry: the install command and the docs then use the registry.
export const NPM_PUBLISHED = true

export const GITHUB_REPO = 'danbaruch/shapewall'
export const GITHUB_URL = `https://github.com/${GITHUB_REPO}`

// How to add Shapewall to a project: from the npm registry once it is published, before that from GitHub (npm clones
// the repository and builds the board with the package's prepare script).
export const INSTALL_PACKAGE = NPM_PUBLISHED ? 'shapewall' : `github:${GITHUB_REPO}`
// The command on the marketing pages. Null before launch: the repository is not readable without an invitation.
export const INSTALL_COMMAND = LAUNCHED ? `npm install --save-dev ${INSTALL_PACKAGE}` : null

export const GITHUB_LABEL = LAUNCHED ? 'GitHub' : 'GitHub (invite only)'
export const ACCESS_LABEL = LAUNCHED ? 'Free to use' : 'Private early access'
// One sentence on the two licenses, the same wording wherever the site states them.
export const LICENSE_SUMMARY =
  'The local tool is open source under Apache 2.0. The self-hosted team server is source-available under the Functional Source License and becomes Apache 2.0 two years after each release.'
// Self-hosted multiplayer (`shapewall hosted`) is in beta. The same sentence wherever the site introduces it.
export const BETA_NOTE =
  'Beta: it works and is tested with automated browsers, but it has not yet had a real multi-person team on it or real phone passkeys verified, so run it for people you trust and keep backups.'
