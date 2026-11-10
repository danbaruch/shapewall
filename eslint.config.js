import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    ignores: [
      'dist/',
      'node_modules/',
      'test/.output/',
      '**/.shapewall/',
      'shapewall-export/',
      'coverage/',
      'website/dist/',
      'website/.ssr/',
      'website/node_modules/',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Defensive initial values (let x = null before a try) are intentional here.
      'no-useless-assignment': 'off',
    },
  },
  {
    // page.evaluate() callbacks run in the browser.
    files: ['test/e2e/**/*.js', 'scripts/docs-screenshots.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // In-page code (the snapshot runs in the captured page) and the demo site.
    files: ['src/capture/live.js', 'src/capture/element-map.js', 'src/capture/capture.js', 'examples/demo-site/public/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ['client/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // __SHAPEWALL_DEMO__: set by the Vite configs (true only in vite.demo.config.js).
      globals: { ...globals.browser, __SHAPEWALL_DEMO__: 'readonly', __APP_VERSION__: 'readonly', __APP_REVISION__: 'readonly' },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // JSX identifiers are used, but core ESLint cannot see that without a React plugin.
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z]', argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // The website (website/): React pages, build scripts and Playwright helpers.
    files: ['website/**/*.{js,jsx,mjs}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node, ...globals.serviceworker },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z]', argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
]
