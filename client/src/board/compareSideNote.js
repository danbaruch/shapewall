// What one side of a compare card says when it has no picture.
//
// A capture that answered 404 is not broken: that environment simply has no
// such page (a page that is new on Staging and not on Production yet), so it
// reads calmly and names the environment. Any other failure still says the
// capture failed, with the reason. Kept pure for test/compare-side-note.test.js.
//
// Returns { text, failed }: `failed` is true only for a real failure.
export function compareSideNote(failure, title) {
  if (!failure) return { text: `Not captured in ${title} yet.`, failed: false }
  if (String(failure) === 'HTTP 404') return { text: `No page here on ${title} (HTTP 404)`, failed: false }
  return { text: `Capture failed: ${failure}`, failed: true }
}
