// The questions on the home page. Plain JS: the page renders them and the build writes the same
// words into the FAQPage structured data, so the two can never disagree.
import { BETA_NOTE } from './launch.js'

export const FAQ = [
  {
    q: 'Is Shapewall a design tool?',
    a: 'No. It works on your real, running site. Every tile on the wall is a capture of a page as it renders today, so comments are about what you ship, not a mockup of it.',
  },
  {
    q: 'Does it include an AI model?',
    a: 'No. Shapewall turns comments into precise, structured work (page, viewport, selector, element text, screenshot) that any coding agent can act on. Bring Claude Code, Codex or whichever agent you already use.',
  },
  {
    q: 'Does it work with single-page apps?',
    a: 'Yes. It snapshots the rendered DOM after your waitFor selector and actions run, so client-rendered content is in both the screenshot and the live HTML.',
  },
  {
    q: 'My site needs a login.',
    a: 'Run shapewall auth record: sign in by hand in the fresh browser it opens and Shapewall saves the session for captures. A small login script works too, for automation. Use a test account and keep the saved session out of git.',
  },
  {
    q: 'Is it safe to open captured pages?',
    a: 'Captured HTML runs no code. It is sanitized against an allowlist, served with a strict content security policy and shown in a sandboxed frame. Any one of the three is enough on its own.',
  },
  {
    q: 'Where does my data go?',
    a: 'Nowhere, unless you connect something. Captures and comments are plain files in .shapewall/ in your project, with no account and no telemetry. An agent endpoint, notifications, GitHub connect or a team server you set up receive what you send them.',
  },
  {
    q: 'Will there be a hosted version?',
    a: `You can host it yourself today: shapewall hosted is a team server with passkey sign-in, workspaces and roles. ${BETA_NOTE} A service run by us, for teams that would rather not run a server, is planned. The local tool stays complete on its own.`,
  },
]
