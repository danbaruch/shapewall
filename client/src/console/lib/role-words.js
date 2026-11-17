// A role inside a sentence ("Sam is now an admin"), apart from format.js so
// test/console-security-labels.test.js can check it without a browser.
const WORD = { viewer: 'viewer', member: 'member', admin: 'admin', owner: 'owner', guest: 'guest' }

export function roleInSentence(role) {
  const word = typeof role === 'string' && Object.hasOwn(WORD, role) ? WORD[role] : 'member'
  return (/^[aeiou]/.test(word) ? 'an ' : 'a ') + word
}
