// Files that run in CI, or decide what CI installs and runs, as soon as a
// branch is pushed: CI config, dependency manifests and lockfiles, build and
// task files. The starter agent does not push a change to any of them unless
// the person passes --allow-ci-push for that run.

const DIRS = ['.github', '.gitlab', '.circleci', '.buildkite', '.woodpecker', '.azure-pipelines', '.husky', '.devcontainer']
const NAMES = new Set([
  // CI
  '.gitlab-ci.yml',
  '.travis.yml',
  'azure-pipelines.yml',
  'jenkinsfile',
  'bitbucket-pipelines.yml',
  '.drone.yml',
  '.woodpecker.yml',
  'appveyor.yml',
  '.appveyor.yml',
  'cloudbuild.yaml',
  'cloudbuild.yml',
  'buildspec.yml',
  'codemagic.yaml',
  '.pre-commit-config.yaml',
  'netlify.toml',
  'vercel.json',
  // JavaScript
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  '.yarnrc',
  '.yarnrc.yml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'bun.lock',
  'bun.lockb',
  '.npmrc',
  '.nvmrc',
  '.node-version',
  '.tool-versions',
  // Python, Ruby, Go, Rust, PHP, JVM, .NET
  'pyproject.toml',
  'poetry.lock',
  'pipfile',
  'pipfile.lock',
  'setup.py',
  'setup.cfg',
  'tox.ini',
  'noxfile.py',
  'conftest.py',
  'uv.lock',
  'gemfile',
  'gemfile.lock',
  'rakefile',
  'go.mod',
  'go.sum',
  'cargo.toml',
  'cargo.lock',
  'build.rs',
  'composer.json',
  'composer.lock',
  'pom.xml',
  'gradle.properties',
  'nuget.config',
  'directory.build.props',
  'directory.build.targets',
  // Build and task files
  'makefile',
  'gnumakefile',
  'justfile',
  'taskfile.yml',
  'taskfile.yaml',
  'dockerfile',
  'containerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
])
const PATTERNS = [
  /^requirements.*\.txt$/,
  /^build\.gradle(\.kts)?$/,
  /^settings\.gradle(\.kts)?$/,
  /^dockerfile\..+$/,
  /^.+\.dockerfile$/,
  /^.+\.csproj$/,
]

export function isGuarded(file) {
  const parts = String(file).split('/')
  if (parts.slice(0, -1).some((part) => DIRS.includes(part.toLowerCase()))) return true
  const name = parts.at(-1).toLowerCase()
  return NAMES.has(name) || PATTERNS.some((pattern) => pattern.test(name))
}

export const guardedFiles = (files) => files.filter(isGuarded)
