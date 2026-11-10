// Browser routes do not reliably re-run for every redirect hop. Chromium Fetch
// interception checks each main-document request before it leaves the browser.
// Authentication setup uses its own context before this guard is installed.
export async function installFlowOriginGuard(context, page, origin, closeContext) {
  let violated = false
  const reject = () => {
    violated = true
    void closeContext(context)
  }
  context.on('page', (popup) => {
    if (popup !== page) reject()
  })
  await context.route('**/*', async (route) => {
    const request = route.request()
    try {
      if (
        request.isNavigationRequest() &&
        !request.frame().parentFrame() &&
        (request.frame().page() !== page || new URL(request.url()).origin !== origin)
      ) {
        violated = true
        await route.abort('blockedbyclient')
        reject()
        return
      }
      await route.continue()
    } catch {
      reject()
    }
  })
  const session = await context.newCDPSession(page)
  const { frameTree } = await session.send('Page.getFrameTree')
  session.on('Fetch.requestPaused', async (event) => {
    try {
      if (event.frameId === frameTree.frame.id && new URL(event.request.url).origin !== origin) {
        violated = true
        await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' })
        reject()
      } else await session.send('Fetch.continueRequest', { requestId: event.requestId })
    } catch {
      if (!page.isClosed()) reject()
    }
  })
  await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] })
  return {
    get violated() {
      return violated
    },
    assertOrigin() {
      if (violated || page.isClosed() || new URL(page.url()).origin !== origin) throw new Error('Audit origin boundary changed.')
    },
  }
}
