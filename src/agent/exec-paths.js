// Which files of a project run something, somewhere, once they change: on
// install, on build, in CI, or the moment a branch is pushed. One list, used
// in both places a connected agent's fix meets it (src/agent/backends/acp.js
// when an edit is asked, src/remote/agent-fix.js before a push):
//
//   - an edit to such a file is refused on the agent's machine unless the
//     machine names the file itself (`agent connect --allow-path`);
//   - even then it is never allowed without asking: a person answers its card;
//   - and a fix that changes one is not pushed from the machine at all.
//
// The list: everything the starter agent's push guard knows (CI config,
// dependency manifests and lockfiles, build and task files:
// src/agent/starter/push-guard.js), every dotfile and file in a dot folder,
// tool and build configuration (*.config.js and friends, tsconfig, the jest /
// vitest / vite / webpack / rollup / babel / eslint / prettier files),
// scripts a package runs (scripts/, bin/, tools/, hooks), container files,
// makefiles, and test files (CI runs them). Everything else is ordinary source.
//
// Two more kinds are never editable from a hosted board, named or not,
// because Shapewall's own commit leaves them out: what the base commit's
// ignore rules ignore, node_modules, .gitattributes and .gitmodules. Those
// are refused where the fix is made (agent-fix.js), with the reason.

import { isGuarded } from './starter/push-guard.js'

const EXEC_DIRS = new Set([
  'scripts',
  'script',
  'bin',
  'tools',
  'hooks',
  'ci',
  'build-scripts',
  '__tests__',
  'tests',
  'test',
  'spec',
  'e2e',
  'cypress',
  'playwright',
])
const EXEC_NAMES = new Set([
  'shapewall.config.json',
  'tsconfig.json',
  'jsconfig.json',
  'gnumakefile',
  'makefile',
  'procfile',
  'gulpfile.js',
  'gruntfile.js',
  'webpack.config.js',
  'karma.conf.js',
  'wdio.conf.js',
  'protractor.conf.js',
  'tiltfile',
  'vagrantfile',
  'brewfile',
  'jenkinsfile',
  'install.sh',
  'setup.sh',
  'bootstrap.sh',
  'postinstall.js',
  'preinstall.js',
])
const EXEC_PATTERNS = [
  // Tool and build configuration: vite.config.ts, jest.config.cjs, tailwind.config.js, ...
  /^.+\.config\.(js|cjs|mjs|ts|cts|mts|json)$/,
  /^.+\.conf\.(js|cjs|mjs|ts)$/,
  /^tsconfig\..+\.json$/,
  /^(jest|vitest|vite|webpack|rollup|babel|eslint|prettier|playwright|cypress|karma|mocha|ava|nyc|postcss|tailwind|next|nuxt|svelte|astro|metro|esbuild|tsup)(\.|rc)/,
  /^(gulpfile|gruntfile)\..+$/,
  // Container and task files.
  /^dockerfile/,
  /^containerfile/,
  /^(docker-)?compose(\..+)?\.ya?ml$/,
  /^.+\.mk$/,
  // Shell and batch scripts run as they are.
  /^.+\.(sh|bash|zsh|fish|ps1|bat|cmd)$/,
  // Test files: CI runs them.
  /^.+\.(test|spec|e2e)\.[a-z]+$/,
  /^.+_test\.[a-z]+$/,
  /^test_.+\.py$/,
]

// True for a project-relative path (with "/") that runs something when it changes.
export function runsSomething(file) {
  const rel = String(file || '')
  if (!rel) return true
  if (isGuarded(rel)) return true
  const parts = rel.split('/')
  // Dotfiles and dot folders: settings of tools, editors, agents, CI.
  if (parts.some((part) => part.startsWith('.'))) return true
  if (parts.slice(0, -1).some((part) => EXEC_DIRS.has(part.toLowerCase()))) return true
  const name = parts.at(-1).toLowerCase()
  return EXEC_NAMES.has(name) || EXEC_PATTERNS.some((pattern) => pattern.test(name))
}

export const filesThatRun = (files) => files.filter(runsSomething)

// What Shapewall's own commit never takes from an agent, whatever was allowed.
const NEVER_NAMES = new Set(['.gitattributes', '.gitmodules'])
export function neverCommitted(file) {
  const parts = String(file || '').split('/')
  return parts.includes('node_modules') || parts.includes('.git') || NEVER_NAMES.has(parts.at(-1))
}
