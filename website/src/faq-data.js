// The questions on the home page. Plain JS: the page renders them and the build writes the same
// words into the FAQPage structured data, so the two can never disagree.
import { LAUNCHED, LICENSE_SUMMARY } from './launch.js'

export const FAQ = [
  LAUNCHED
    ? {
        q: 'What does Shapewall cost?',
        a: `Nothing. ${LICENSE_SUMMARY}`,
      }
    : {
        q: 'How is Shapewall licensed?',
        a: LICENSE_SUMMARY,
      },
  {
    q: 'Which coding agents does it work with?',
    a: 'Any agent that can run a shell command and read JSON, including Claude Code, Codex and goose. Agents that speak MCP can use shapewall mcp, and shapewall watch starts a command-line agent for each new comment. Shapewall includes no model of its own: you bring the agent you already use.',
  },
  {
    q: 'What does it need to run?',
    a: 'Node.js 22.13 or newer and Chromium, which shapewall doctor --install-browser downloads, or a Chrome you already have. It runs on Linux, macOS and Windows; Linux is the primary tested platform. Point it at any running site: a local dev server, a preview deploy, staging or production.',
  },
  {
    q: 'Is Shapewall a design tool?',
    a: 'No. It works on your running site: every tile on the wall is a capture of a real page, so comments are about what you ship, not a mockup.',
  },
  {
    q: 'Does it work with single-page apps?',
    a: 'Yes. It snapshots the rendered DOM after your waitFor selector and actions run, so client-rendered content is in both the screenshot and the live HTML.',
  },
  {
    q: 'Can it capture pages behind a login?',
    a: 'Yes. Run shapewall auth record, sign in by hand in the browser it opens, and Shapewall saves the session for captures. A login script works for automation. Use a test account and keep the saved session out of git.',
  },
  {
    q: 'Is it safe to open captured pages?',
    a: 'Yes. Captured HTML runs no code: it is sanitized against an allowlist, served with a strict content security policy and shown in a sandboxed frame. Any one of the three is enough on its own.',
  },
  {
    q: 'Where does my data go?',
    a: 'Nowhere, unless you connect something. Captures and comments are plain files in .shapewall/ in your project, with no account and no telemetry. An agent endpoint, notifications, GitHub connect or a team server you set up receive only what you send them.',
  },
  {
    q: 'Can my team use it together?',
    a: 'Yes, on a server you host. The team server (beta), started with shapewall hosted, adds passkey sign-in, workspaces with owner, admin, member and viewer roles, live presence, and share links for clients. Captures run on your machines and upload to your server.',
  },
]
