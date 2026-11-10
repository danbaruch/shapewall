// An example login hook for sites behind a sign-in. Copy it next to your
// shapewall.config.json, adapt the selectors, and point the config at it:
//
//   "auth": { "loginScript": "./shapewall.login.mjs" }
//
// Shapewall runs it once per capture in a fresh browser context, then reuses
// that context's cookies and storage for every page. Credentials come from
// the environment, never from the config or the repository:
//
//   SHAPEWALL_USER=reviewer@example.com SHAPEWALL_PASSWORD=... npx shapewall capture
//
// Use a dedicated test account with as little access as the pages need.

export default async function login({ page, baseUrl }) {
  const user = process.env.SHAPEWALL_USER
  const password = process.env.SHAPEWALL_PASSWORD
  if (!user || !password) throw new Error('Set SHAPEWALL_USER and SHAPEWALL_PASSWORD for the login script')
  await page.goto(new URL('/login', baseUrl).toString())
  await page.fill('input[name="email"]', user)
  await page.fill('input[name="password"]', password)
  await Promise.all([page.waitForURL((url) => !url.pathname.startsWith('/login')), page.click('button[type="submit"]')])
}
