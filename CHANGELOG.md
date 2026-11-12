# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## 0.7.0 - 2026-11-12

Connected agents, stage E: the Usage dashboard, and people's activity. Two new pages in the Workspace Console of a team server, and
a Usage view on a local board.

- **Usage** (`/w/<workspace>/usage`). Every agent turn (a chat answer, a comment answer, a fix, a push) with the numbers the agent
  reported. Tiles with the change against the period before (turns, tokens, agent time, reported cost, fixes ready, failed or
  stopped). Usage over time as stacked bars by day, week or month, split by agent, project, person, kind, model or outcome,
  measuring turns, tokens, time or reported cost, with a brush to zoom. A ranked breakdown with shares, how turns ended, approvals,
  and the median and 95th percentile turn duration. Top lists, and each project's daily budgets with today's use. Hover or tap for
  exact values; press a bar, a row or a legend entry to filter the whole page; every chart has a table, "copy as CSV" and "copy as
  an image". One palette, checked for colour-blind readers in light and dark.
- **Nothing is estimated, and "not reported" is not zero.** A cost appears only when the agent or its endpoint reported one. An
  agent that reports no tokens shows "Not reported" (a dash, or a hatched area in a chart), and totals say how many turns reported.
- **Turns: a real grid.** Sorted, filtered and paged by the server (fast at 100,000 rows, tested), virtual rows, column chooser
  and reordering, pinned columns, grouping with subtotals, a density toggle, keyboard navigation, a drawer with the full record
  and a link to the comment or board, and CSV or JSON export of the filtered set (streamed, at most 50,000 rows, audited).
  Drag a header to move a column and its right edge to resize it (the header's menu does both from the keyboard). Grouped rows
  can show the period before and the change beside each group. A sorted table holds still while a running turn finishes.
- **Filters live in the address,** so a link is a view. Saved views are a person's own names for an address; a link or a view
  never shows its reader more than they may see.
- **Who sees usage:** owners and admins the workspace; a member their own turns and every turn of an agent they connected;
  viewers, share link guests and project tokens nothing. Checked on every route, including exports and a turn opened by its id.
- **What a turn records, completed.** Duration (the server's clock, and the agent's own when it says), tool calls counted by
  type, approvals allowed without asking and who answered the others, the context window, and who connected the agent. Never the
  question, the answer, a file or a diff.
- **Activity** (`/w/<workspace>/activity`). People's activity, read from the audit log: sign-in and sign-out, settings with the
  value before and after, agents connected, reconfigured and revoked, approval cards answered, tokens, exports. Filter by person,
  kind of action, agent, project and period; "Worth a look" keeps the security-relevant changes. A page per person (role, what
  they made, devices, their usage and activity) and per agent. Admins and owners read everyone's; anyone else their own.
- **Sign-ins and devices stay each person's own.** They cover every workspace a person is in, so an owner or admin does not see
  them for anyone else. On a server with one team the operator can let owners see them: `shapewall hosted
  --owners-see-sign-ins` (off by default).
- **Periods compare honestly.** The last N days against the N local days before, across clock changes; this week or month so
  far against last week or month to the same day; last month against the month before. Any number of clock changes in a period
  is bucketed right.
- **Access review.** Every person, agent, API token, share link, public project and open invite in one place, with what it
  reaches, who made it and when it was last used; unused for 90 days is marked. Exports as CSV.
- **New audit entries:** `signed_out`, `usage_exported`, `audit_exported` (the old audit CSV leaves one too), `access_exported`,
  `usage_retention_changed`; `agent_policy_changed` now records which settings changed, before and after.
- **Retention, quota, export.** Usage records are kept 400 days by default (`shapewall hosted admin retention ws_ID --usage-days
  N`), count toward the storage quota, and are all in the workspace export as `usage.json`.
- **On a local board,** each agent turn is a line in `.shapewall/agent-usage.jsonl` (0600, written under a file lock; `shapewall
  init` now names it in `.gitignore`, and a project set up earlier should make sure `.shapewall/` is ignored), and the console's Usage page shows the owner
  totals, a chart by day and agent, how turns ended and the newest turns.
- **Phones.** At 390 px the tiles stack, charts answer a tap, the grid is a list of cards and a turn opens as a sheet.
- **Upgrade notes.** Migration 15 is additive (new columns on the usage records, saved views, indexes); see
  [Migration 15 and rollback](docs/hosted.md#migration-15-and-rollback). The retention job starts removing finished usage records
  older than 400 days. The console gains Recharts and TanStack Table, Virtual and Query, loaded only with these two pages; the
  board's JavaScript is unchanged in size.
- **Not in this release:** scheduled or emailed exports, per-agent budgets, notifications for "worth a look" entries, and a
  tamper-evident (hash-chained) audit log.
- **The live demo has Usage and Activity,** with made-up numbers. Its console shows both pages working in the browser: about sixty
  days of a pretend team's agent turns (a few thousand, placed relative to today; busy weekdays, spikes, a quiet stretch, a day of
  failures, agents that report a cost, tokens only, or nothing) and the activity that goes with them. Every chart, the grid, a
  turn, saved views, CSV and JSON exports (made in the browser), a person's page, an agent's page and the access review work.
  Asking the agent or running a fix on the demo board adds a turn and its activity; Reset puts everything back. The demo counts
  rows in memory and shares the rest with the server (`src/hosted/usage-core.js`, `activity-core.js`); a test puts the same rows
  into a real server and compares every answer. The demo's Audit log page reads the same history, each agent has its token on
  the API tokens page, and a turn's link opens its comment on the demo board. The charts still load only with these two pages.
- **Fixed: filter options ticked quickly all hold.** On Usage, ticking two options of a filter faster than the page redrew kept
  only the last one: each press wrote the list the menu was drawn with. A press is now applied to the address as it is when it
  lands. The same goes for removing filter chips, pressing a chart to filter, and "Worth a look" on Activity.

- **The panel buttons are the panel's header.** With a side panel open, Comments, Agent and Checks in the top bar are exactly as
  wide as the panel under them (the same inset as the panel's own rows), share that width, and follow the panel as you drag its
  edge. With no panel open they go back to their own width at the right of the bar; so do they in a window too narrow to fit
  them stretched. Agent settings now sits left of them, in the same place either way. The panel's default width is unchanged
  (384 px); the narrowest it drags to is now 368 px (was 280), so it is never narrower than its buttons need. Phones are unchanged.

### Fixes found on a real setup

A fix for connected agents on the current Claude Code adapter.

- **Connected agents work with `@agentclientprotocol/claude-agent-acp` 0.106.0.** With 0.6.0 and that adapter,
  `shapewall agent connect` connected, and the first question then failed with only "Claude Code did not start." The cause:
  0.106.0 starts a session in the mode "auto" and, when asked to switch, sends the new mode before its answer, in another place
  than the one Shapewall read. The session looked as if it still acted without asking, so Shapewall stopped it. Now the mode the
  agent names is the mode Shapewall checks, and the session is switched to "default" as intended. Nothing is loosened: a session
  that moves itself to a mode that acts without asking is still stopped, and the mode it names is checked on its own as well.
- **Tested adapter versions: 0.93.0 and 0.106.0.** The read-only and the edit provocations were run again on both with the real
  adapter ([how](docs/agent-hardening.md#connected-agents)). `agent connect` now opens a session when it starts (no prompt is
  sent) and prints which adapter answered. A version it was not tested with is used with a plain `Warning:` that names the tested
  ones; a session that cannot be opened stops the command with the cause.
- **A start that fails says why.** The chat and the machine's log both get the adapter's error or its last output, the adapter's
  name and version, and what to try. A turn that fails is also written to the machine's log. Never a bare "did not start".
- **The approval page shows what the machine asked for.** The box on the "Connect an agent" page said "does not change files"
  even for a machine started with `--approvals owner` or `--auto edits`. The terminal now reports its rules with the code, and
  the page says them: edits on a branch and who may allow them, "without asking" if asked, the base branch, and that commands are
  never run. It is marked "Reported by the terminal"; an older shapewall that reports nothing is said to have said nothing.
- **"Sign in a terminal" reads cleanly.** The two commands on `/device` are each in a code block on a line of their own, instead
  of one sentence that wrapped into narrow columns.
- **An expired code names the command that was run.** `shapewall agent connect` no longer says "Run shapewall login again".

### The board's tools move to the bottom of the canvas

Board tools: the tools you use on the board moved out of the top bar.

- **A floating toolbar at the bottom centre of the canvas,** like FigJam, Miro and tldraw. It holds what you do to the board:
  **Select** (V), **Hand** (H), then after a thin divider **Comment** (C), **Draw** and, on desktop when the board has live
  pages, **Select text**. One tool is in use at a time (Comment, Draw and Select text fill with the accent colour; Select
  and Hand in use are a quiet neutral chip); Esc goes back a step at a time and ends on Select. The top bar keeps what
  you look at: the board, the screen sizes, Views and the Comments, Agent and Checks panels. The Comment button is no longer in
  the top bar.
- **Select and Hand.** Select is the default pointer: a click selects a page and shows its actions or opens a comment's pin,
  and a drag on empty canvas still pans. Hand is for moving around a dense board: a drag anywhere pans, on pages and pins
  too, and a click selects and opens nothing. Holding Space in any tool is a temporary Hand, as before, and so is a
  middle-button drag. V and H do nothing while you type. Desktop only: on a phone a finger already pans.
- **Draw is a tool of its own.** Pick Draw and click a page: a comment starts on that page and you draw at once (a box, an arrow
  or the pen, as before). With a comment or a reply open, Draw draws on that comment's page. A drawing is still part of a
  comment, and the Box, Arrow and Pen buttons under a comment work as they did.
- **The note for the tool in use sits just above the tools:** the comment hint, "Commenting on ...", the drawing bar and the
  select-text note moved there from the top of the canvas. The tip, the links notes and the viewport notice stay at the top.
- **Nothing overlaps.** The tools are centred on the canvas (not the window), so they move when the sidebar or the side panel
  opens or is resized. On a narrow canvas they shift clear of the zoom controls, then the zoom controls compact (Fit and the
  minimap switch stay in the zoom menu), then the minimap steps aside. An open journey's bar and the toast sit above the tools.
- **Phones:** the tools are the bottom bar (44 px targets, above the safe-area inset) and the comment button left the top row.
  They step aside while a sheet or the keyboard is up. Draw, then a tap on a page, opens the page full screen to draw on.
- **Permissions are unchanged.** A viewer, a read-only share link or an export without comments has no Comment or Draw tool;
  a guest who may comment has both. Compare mode has neither, as before. Someone who may not comment has Select and Hand on a
  desktop (and Select text while a page is live), and no toolbar on a phone.
- **Keyboard and screen readers:** the tools are a labelled toolbar with one tab stop; the arrow keys, Home and End move between
  them, and each says whether it is in use. Tooltips show the shortcuts.
- **Esc goes back one step at a time.** With a journey open, Esc leaves comment mode (or Select text) first and the next Esc
  leaves the journey; one press used to do both. Turning comment mode on ends Select text, so one tool is in use at a time.
- **Comments keep clear of the tools.** A thread or a new-comment card near the bottom of the canvas sits above the tools, and
  above their note while one shows.


## 0.6.0 - 2026-11-12

Connected agents, stage C: approvals and edits from a hosted board. A connected agent can make a fix for a comment, on a new
branch, with each edit allowed by a person on the board. It is off until the machine that has the code switches it on. Nothing
changes on a local board.

- **The default is unchanged.** A connected agent reads and answers only. Edits are switched on only on the machine that has the
  code: `shapewall agent connect --approvals owner` (the person who connected it may allow each edit from the board) or
  `--approvals admins` (whoever the server lets answer: the agent's answer role, admin by default, owner if set).
  `--approvals none` switches it off again. The choice is saved per connection in the machine's own policy file
  (`agent-policy.json` beside the saved token, 0600, outside every repository). It is the ceiling, and the server can only
  narrow it.
- **More flags for `agent connect`,** each saved for the connection: `--auto none|edits` (what the server's "Allow without
  asking" rule may apply to; default none), `--allow-path FILE` (a settings file the agent may ask to edit: dotfiles,
  `package.json`, a `Makefile`, a `Dockerfile` and CI config are refused otherwise; adds one per run, `none` empties the list),
  `--base BRANCH` (where a fix starts; default the commit the checkout is on, and then a checkout with uncommitted changes to
  tracked files refuses the fix, because the fix would silently leave them out) and `--git-remote NAME|none` (where a finished
  fix is pushed; default `origin`).
- **Fix with an agent on a hosted comment.** Offered when a connected agent's machine takes edits and you may use that agent. The
  server takes the comment in the agent's name with the rules of sending a comment to an agent: a trusted member vouches for the
  text they saw, a non-admin's run still needs an admin's "Approve agent run" where the policy says so, the agent's audience, the
  daily and open-claims budgets. Chat messages never edit: only Fix does. An offline agent cannot be asked for a fix (Send to
  agent still queues). For an agent that reads and answers only, the button is not offered and one line says why.
- **A fix is never made in the checked-out tree.** The agent works in a fresh copy of the base commit, with no `.git` in it, in
  a folder outside the project (under `$XDG_STATE_HOME/shapewall/agent-fixes/`), made by the same code as "work on a branch" on a
  local board. Shapewall itself commits the result on a new branch, `shapewall/comment-<n>-<slug>`, with the repository's own
  author; no hook, filter or attribute runs. It pushes that one branch when the machine has the remote and the change touches
  nothing that runs in CI (dependency manifests, CI config: then the thread says "Not pushed" and why), and opens a pull request
  when GitHub connect is set up on that machine. Otherwise the thread says "Fix ready on branch" with the name to copy. The folder
  is removed afterwards; the branch stays. A folder that is not a Git repository, a repository with no commit yet, a merge in
  progress, or uncommitted changes without `--base`: refused, with a clear sentence in the thread and on the comment.
- **The commit is exactly what was allowed.** Every changed file must have had an allowed edit and must hold exactly the content
  that was shown. A changed edit, an extra file, another file touched: the branch is taken back and the thread says nothing was
  committed. If files in the person's own checkout changed during the fix, the thread says so.
- **Permission cards.** Each edit the agent asks for is checked on the machine first: inside the fix's folder after resolving
  symlinks, not `.git`, not Shapewall's store, not a settings file unless named with `--allow-path`, and the whole resulting file
  must be computable and small enough to show in full. What fails is refused there and never becomes a question. What passes is
  a card in the comment's chat thread: the path, the full diff, Allow and Deny, in the machine's own words, never the agent's
  title. A card carries a hash of the turn, the card, the path, the whole diff and its expiry, and an answer must send that hash
  back. A card expires after 2 minutes and is answered once. Stop cancels the cards that wait. Everyone with the thread open sees
  the state change live, and the strip above the board lists the cards that wait for you.
- **Who may answer.** The agent's answer role (admin by default), who is also in the agent's audience and trusted by the
  project's agent policy; only the person who connected the agent when its machine says `--approvals owner`. Allow needs a
  passkey check in the last 10 minutes (the browser asks); Deny does not.
- **The machine checks every answer again:** a card it asked and still waits on, the same hash, not expired, once, and from the
  connecting person when it said "owner". A failed "allow" is a deny, and an answer for a card it never asked is ignored. The
  server never takes "approved" from the machine.
- **"Allow without asking"** is an approval rule per agent, in the console's approvals dialog. It is available only when the
  agent's own machine named a kind with `--auto`, is set only by the role in the agent's "who may change the rule" setting (admin
  by default; owners can make it owner), applies only to the kinds the machine named, and never widens what may be edited. If the
  machine connects again without it, the stored rule is reset to "ask", and that is audited.
- **The console and the board say which mode an agent is in:** "Reads and answers", "Edits on a branch, each allowed by ..." or
  "Edits on a branch, allowed without asking".
- **Audit log.** New entries: `agent_edit_mode_changed` (what the machine allows changed), `agent_permission_asked`,
  `agent_permission_approved` and `agent_permission_denied` (who, the path, the card's hash; never file content or a diff),
  `agent_permission_expired`, `agent_permission_auto`, `agent_fix_branch_ready`, `agent_branch_pushed` and
  `agent_pull_request_opened` (as reported by the agent's machine), plus `agent_turn_started` with kind "fix" and
  `agent_approval_rule_changed`.
- **Usage records.** A fix is one record of kind "fix": its steps, how it ended (fix ready, answered, stopped, failed,
  interrupted) and how many requests were asked, allowed and denied.

**No commands for Claude Code.** The link and the machine's policy know a third kind of request: exact commands from the
machine's own list, each allowed on the board (`--allow-command`). It is not available for Claude Code in 0.6.0, and Claude Code
is still the only agent `agent connect` offers. The reason was found with the real adapter: started with its shell tool, Claude
Code runs commands it takes to be read-only (`ls`, `cat`) without asking anyone, and those can read outside the project. So a
fix session of Claude Code gets no shell tool at all, `--allow-command` is refused for it with that explanation, and commands in
a hand-edited policy file are not in effect.

**What leaves the code machine in edit mode,** beyond 0.5.0: the diffs on edit cards (bounded), the file paths and line counts of
a fix, the branch name and the pull request link. Still not the agent's token, which is never in the agent's environment, and
not absolute paths.

**The limit.** Shapewall does not sandbox the agent's own tools. With approvals on, a compromised hosted server can forge an
"allow" for an edit the agent really asked, with the right hash. The worst case is then edits to project files, on a branch, in a
throwaway folder, pushed for review: not commands, not the checkout, and not files outside the project that the agent asks about.
Give a connected agent a restricted profile, prefer `--approvals owner` to `admins`, review the pull request like any other, and
do not add `--allow-path` for CI files. [agent-hardening.md](docs/agent-hardening.md#edits-from-a-hosted-board) has the trust
table and how this was checked with the real Claude Code adapter.

Not in this release: recapture and push of new captures after a fix; the model and effort menus; batch fixes; "Allow for this
chat"; images in chat; connecting one agent to all projects; commands for Claude Code; fixes from chat messages; queueing a fix
for an offline agent; the usage and audit dashboards.

**Compatibility.** `shapewall watch --remote --exec` and `shapewall mcp --remote` work as before, with the same tokens. A
connected agent that was approved under 0.5.0 keeps reading and answering only until its own machine is started with
`--approvals`.

**Upgrading a hosted server.** Back up first (`shapewall hosted backup`). Migration 14 adds one table (`chat_permissions`) and
three columns on `agent_runs` (`approvals_asked`, `approvals_allowed`, `approvals_denied`), and changes nothing that exists. To
go back, restore the backup with 0.5.0, or run 0.5.0 on the upgraded database: it ignores the new table and columns, and a fix
cannot be started from it. Details and the SQL to remove the schema are in
[Migration 14 and rollback](docs/hosted.md#migration-14-and-rollback).

### After the security review

- **Files that run something.** One list (dotfiles, manifests and lockfiles, build and tool configuration, package scripts,
  container and CI files, makefiles, test files) decides both what a connected agent may be asked to edit and what is pushed. An
  edit to one is refused unless the machine names it with `--allow-path`; a named one is always answered by a person; a fix that
  changes one is never pushed from the machine.
- **Push this fix.** A fix with an edit that went without asking (`--auto edits`) is committed on its branch on the machine and
  held there. It is pushed, and a pull request opened, only after someone who may answer cards allows one card that shows the
  whole diff, with a fresh passkey. It can be asked again.
- **Only the connecting person switches "Allow without asking" on** when their machine says `--approvals owner`.
- **Stop stops the commit, the push and the pull request.** A push that had already finished is said in the thread.
- **The commit check compares bytes and file mode**, and fails when an allowed file is missing from the commit. Edits to files
  Git ignores, to `node_modules` and to `.gitattributes` / `.gitmodules` are refused when they are asked.
- **The policy file fails narrow**: an unknown value reads as the narrowest setting, by name, and the file's owner and mode are
  checked before it is read.
- **Cards wait a length of time**, counted on each side's own clock. An answer the machine did not take shows as expired.
- **Diffs on cards go to the agent's audience** (and whoever may answer or asked). Other members read which file and the outcome.
- **Fix on a comment whose run needs approval**: an admin's Fix approves and starts; a member's really sends it for approval.
- **Leftover fix copies are swept** at connect and around every fix; the fix folder is never inside the project.
- A fix's status is written with its own claim; a pull request link must be a pull request URL (a link only on github.com);
  cards count against the storage quota; comment text in a commit subject or pull request title pings and closes nothing.

## 0.5.0 - 2026-11-12

Connected agents: your Claude Code on a hosted board, to chat with. It reads and answers only. Nothing changes on a local board.

- **`shapewall agent connect --remote <server>`**, run in a project's folder on the machine that has the code, makes that machine's
  Claude Code an agent of a hosted project. The first run shows a code; an admin approves it on the server's `/device` page, where
  they name the agent, pick its icon, its project and who may use it. The agent gets a token of its own, saved on the machine and
  never printed. Flags: `--agent`, `--name`, `--as` (a second connection), `--audience owner|server`, `--takeover`,
  `--concurrency`, `--token-file` (for a service).
- **Only Claude Code can be connected.** An agent is offered when its own controls were shown to keep a session read-only. Codex,
  goose and Gemini CLI are refused with a message: Codex, started in its read-only sandbox, changed no file in our check but still
  ran shell commands and read a file outside the project without asking; goose's chat-only mode could not be verified on the test
  machine; Gemini CLI was not installed to verify. For them, `shapewall watch --remote` stays the way.
- **The agent is online while the command runs.** Its state on the board and in the console comes from its open link to the server.
  The link reconnects by itself; Ctrl+C is a clean exit.
- **One link per agent.** A second `agent connect` on the same token is refused, with the machine already connected and since
  when. `--takeover` closes the other link first; add it to a service's command so a restart after a crash is not refused.
- **Chat on hosted boards.** The Agents panel has a **Chat** button on each connected agent you may use. It opens the same chat
  panel a local board has: the answer streams in with the agent's steps, Stop works, and the conversation is kept on the server.
  A reload, or a second person with the same thread open, gets a running answer from its start, in order, and a dropped stream
  resumes where it was. The board chat and each comment's chat are shared with the workspace's members; a chat you start is yours
  alone (50 of your own per board). "@" mentions and text files work as they do locally.
- **Read and answer only, by the agent's own controls.** A connected agent does not change files and runs no commands. Its session
  starts with none of your Claude Code settings files (their allow rules, hooks, default mode, plugins and MCP servers do not
  apply) and with only its reading tools; Bash, Edit, Write, web tools and the rest are removed. Shapewall also offers it no way to
  write or run, and refuses every permission request on the spot, a read outside the project included; the answer says what was
  refused. It fails closed: a mode other than "default" or "plan" is switched or the agent is not started, an agent that reports
  no mode is not started, and managed settings that allow acting tools or run hooks stop `agent connect`. It still reads every
  file in the project folder, and its answers leave the machine. Edits, commands and approvals from the board are not in this
  release; for fixes, keep using `shapewall watch --remote --exec`.
- **Who may use it** follows the agent's audience, as for comments, and the board shows what is in effect. `--audience owner` asks
  the server to keep it to the person who connected it even if its audience there is widened later, and the machine refuses a job
  the server labels as someone else's; the machine cannot check that label, so it does not protect against a compromised server.
  A message by someone outside an agent's audience never reaches that agent, even in a shared thread, and a share link guest's
  text never does. Viewers, guests and public visitors have no chat.
- **Comments.** A comment sent to a connected agent by name is read and answered by it, in the comment's chat thread and as a reply
  on the comment. Comments sent to any agent stay with watchers, which can fix them. The board context that goes with a question
  follows the audience too: a comment is in it only when the person asking wrote it, the agent holds it, or its author is in the
  agent's audience and it was sent to an agent and not to another one.
- **Offline.** Chat to an agent that is offline is refused, with the reason in place of the message box. A thread stays with its
  agent and never moves by itself: the panel offers "Ask <other agent> instead", and the switch is written into the thread.
  Comments sent to an offline agent wait, as before.
- **Limits.** The daily turn budget is counted from the usage records, so deleting a thread gives nothing back. Turns cut off by a
  server stop are ended as interrupted when it starts again.
- **The console.** A project's Agents page says what each connected agent is (what runs, on which machine, since when it is
  connected, that it reads and answers only), and its Connect card leads with this server's `shapewall agent connect` command. The
  workspace overview shows the same.
- **Usage records and the audit log.** Every chat turn writes a usage record: who asked which agent, where, when, how it ended, and
  the model, effort and token counts only when the agent reports them (a cost only when the agent itself reports one; never message
  text). The audit log gains an agent connected, its link opened and closed (at most once a minute per agent when a link flaps), a
  chat thread created, deleted or switched to another agent, and a turn started or stopped.

Not in this release: edits, commands and approvals from the board; "Fix with <agent>" through chat; images in chat; editing or
regenerating a message; answer ratings; the model and effort menus; connecting one agent to every project at once (one connection
serves one project; connect again with `--as` for another).

**Compatibility.** `shapewall watch --remote` and `shapewall mcp --remote` work as before, with the same tokens. The token API now
tells a token that may take work which agent each comment was sent to (`agentId`: its own agent's id, or `null` for any agent).
There is a new token scope, `agent`: it opens the link of a connected agent and nothing else, and is granted only by approving
`shapewall agent connect`. The agent policy has a new number, `dailyTurns` (200 chat turns a day for a project by default).

**Upgrading a hosted server.** Back up first (`shapewall hosted backup`). Migration 13 adds three tables for chat (threads, messages,
turns) and one column, and changes nothing that exists: no token gains a scope and no agent changes its audience. To go back, restore
the backup with 0.4.0, or run 0.4.0 on the upgraded database: it ignores the new tables, so chat is gone from the board until you
upgrade again, and a connected agent shows as an ordinary agent whose token still works for comments. Details and the SQL to remove
the schema are in [Migration 13 and rollback](docs/hosted.md#migration-13-and-rollback).

## 0.4.0 - 2026-11-12

Agents on a hosted board are things you can see and choose. This is the first step towards connected agents and chat on hosted
boards; nothing changes on a local board.

- On a hosted server, every project token that may take work (the `claim` scope) is an **agent**: it has a name, an icon and a
  colour, a state (online, working, offline with when it was last seen) and a line saying whose work it takes. The board's Agent
  panel lists them with what each is working on and what waits for it, and the Agent button's tooltip names them ("Builder online,
  Fixer offline"). `shapewall watch --remote` and `shapewall mcp --remote` are those agents: they need no new flag and no new token.
- **Send to agent** on a thread is a split button, like "Fix with <agent>" on a local board. The main part names the project's
  default agent; the menu lists every agent with its state, and **Any agent** for whichever takes it first. A comment sent to one
  agent can only be taken by that agent: the project's other tokens do not see it, by list, by id or through MCP.
- A comment sent to an agent that is offline waits for it and says so on its thread and in the panel ("Waiting for Builder
  (offline, last seen 2 hours ago)"), with **Let any agent take it** and **Choose another**. Nothing is lost: when the agent is
  back it takes what was sent to it.
- Each agent says **who may send it work**: only the person who connected it, named members, or everyone the project's agent policy
  trusts. The server checks it when a comment is sent and again when the agent takes it. On the board, an agent you may not use is
  listed, greyed, with the reason. A new agent takes work only from the person who connected it, until an admin shares it.
- A project has a **default agent**, picked by an admin or owner: the one Send to agent names, and where a trusted member's new
  comment goes. Without one, comments go to any agent, as before.
- The console has an **Agents** page for each project: every agent with its state, last seen, audience, approval settings and the
  default; rename it and give it an icon and a colour (the editor the local Agents page uses); set the default; change who may use
  it; revoke it; and a **Connect an agent** card with this server's exact commands. **Agents** in the workspace menu lists every
  agent of the workspace with the project it serves and who connected it.
- Each agent has an approval rule and two roles, who may answer its approvals and who may change the rule (admins and owners, or
  owners only). The rule in effect is always "Always ask"; "Approve automatically" is listed as not available until an agent's own
  machine can allow it.
- An agent's replies on a thread show its icon. Renaming an agent renames its token: new replies use the new name, old ones keep
  theirs.
- Phones have the Agent panel now: **Agents** in the board's More menu opens it as a sheet, and a thread's sheet has the same Send
  to agent control.
- Every change is in the audit log with what it was before and after: an agent created or first seen, renamed, its look, the
  default, its audience, its approval settings, revoked, and a waiting comment released to any agent.
- The server now writes one usage record for each comment an agent takes (who asked, which agent, when, how it ended; never the
  comment or the answer). There is no page for it yet.

**Upgrading a hosted server.** Back up first (`shapewall hosted backup`). Migration 12 adds two tables and three columns and turns
every token that already has the `claim` scope into an agent that behaves exactly as before: it takes work from everyone the agent
policy trusts, and no project gets a default agent, so nothing is routed differently until you choose. Tokens made from this
release on start narrower, with only the person who made them: share such an agent on the project's Agents page if teammates'
comments should reach it. To go back, restore the backup with 0.3.4, or run 0.3.4 on the upgraded database: it ignores the new data,
which means a comment sent to one agent can be taken by any watcher, audiences are not enforced, and default agents, icons and
usage records are not shown until you upgrade again. Details and the SQL to remove the schema are in
[Migration 12 and rollback](docs/hosted.md#migration-12-and-rollback).

## 0.3.4 - 2026-11-12

- The agent's "Changed N files" card lists only the agent's work. Files Git ignores (by `.gitignore` as it is on disk, committed or
  not, `.git/info/exclude` and your global excludes) are never listed or counted, and Undo never touches them. Before, anything
  another program wrote inside the project folder during the turn showed up in the card (a dev server's data, a log), and Undo could
  have deleted those new files and rolled the changed ones back. Outside a Git repository the list works as before, and Shapewall's
  own folders (`.shapewall*`) are always left out.
- Hosted boards have the Agent button in the top bar, next to Comments and Checks, for people who can send comments to an agent. It
  opens a small panel: whether an agent is listening ("Agent online: <token name>", or "No agent is listening" with the command to
  connect one), what is running and what waits for you, each opening its comment. There is still no chat on hosted boards. Share
  link guests and public viewers do not get it.
- The sidebar has one search field on every board. On a board with no journeys the old "Filter pages" box was still shown under
  "Search the board".
- Esc is never swallowed by a tooltip. With the keyboard on a button inside a thread or a dialog (its tooltip showing), one Esc now
  closes the thread or dialog; before, the first Esc only closed the tooltip.
- Phone: in the drawing sheet every tool and ink is a full 44 px target; the tools are on one line and the inks, Undo and Clear on
  the next. In the journey bar each step has a 44 px target around its dot, and a journey with many steps scrolls sideways inside
  the bar.
- "Fix ready on branch" wears the attention colour everywhere, the same as on the toolbar: it waits for you to apply it.
- `shapewall settings` exits cleanly (code 0, after cleaning up) when it is stopped the moment it starts. Before, a Ctrl-C or a
  script's signal that arrived right as it printed its address could kill it outright.

## 0.3.3 - 2026-11-11

- Commenting goes one step at a time, and the board always says which step you are at. Pick: in comment mode the element under the
  mouse is outlined, now named in plain words ("Heading: Notes that keep up...", "Button: Start free") in place of a CSS selector.
  Write: once you click, picking is over. Nothing else lights up, the cursor is a normal one again, the element you picked keeps a
  solid outline, and the banner reads "Commenting on ..." with Cancel. A click elsewhere moves the comment only while it is still
  empty; once it has text, an image or a drawing it stays where it is and the composer nudges. Esc goes back exactly one step:
  from drawing to the comment, from the comment to picking, from picking out of comment mode.
- The comment box and an open thread keep off the element they are about: beside the pin on the side away from it, else below
  it, else above it. They only overlap it when it fills the canvas. Both cards can be dragged by their top line (the "#17 Home"
  row of a thread, the "Home · Desktop · ..." line of a new comment) to see the page or a drawing under them; a moved card stays
  where you put it while the canvas moves, never goes under the side panel, and is back at its pin the next time it opens.
- A comment you are writing is never thrown away by a stray click. With text, an image or a drawing in it, clicking another pin, a
  row in the comments list, a link to a comment or pressing C leaves it open (the box nudges); before, each of those dropped it
  without a word. An empty one makes way as before. Esc still cancels, but when the comment holds a drawing or images it asks
  first ("Discard this comment?"); Cancel never asks.
- Scrolling and zooming the board always work over a live page, and Ctrl/Cmd+wheel or a trackpad pinch never zooms the whole
  browser tab while the pointer is on the board. The cause was "Select text": once turned on for a page it gave that page the
  mouse for good, wheel included, with nothing on screen saying so (comment mode hid the problem). Select text now has two visible
  steps: on, and the board still scrolls and zooms over the page; click the page and it takes the mouse so you can select and
  copy, until the pointer leaves it or you press Esc. A note at the top says which step you are at, with Done. Ctrl/Cmd+wheel over
  the bars floating on the canvas zooms the board too, and over an open comment card it no longer zooms the browser.
- You can see that agents are working without hunting for the comment. The Agent button in the toolbar (the Comments button on
  boards without an agent chat, the More button on a phone) carries a mark for the whole board: a pulsing dot while an agent
  works, with the number when more than one does; a still dot in the attention colour when an agent needs your OK or a comment
  waits on a person; a green dot for a moment when the last one finishes. Its tooltip says it in words ("2 agents working: #17
  Home, #21 Settings", "Agent needs your OK on #21 Settings"), and when exactly one thing needs you, the button opens it. With
  reduced motion the dot does not pulse.
- Hosted boards say whether an agent is listening. A comment is only picked up while some machine runs `shapewall watch --remote`
  (or an MCP client) for the project; the same tooltip now reads "Agent online: <token name>" or "No agent is listening: comments
  wait until one is", and a thread whose comment was sent to the agent says so too when none is. The server keeps this in memory
  only (the token's name and when it was last heard, for 90 seconds), and tells members, never share link guests.
- Search moved out of the top bar into the sidebar: one field at the top of the expanded sidebar ("Search pages, journeys,
  comments", Ctrl/Cmd+K), a search icon when the sidebar is collapsed. It opens the same search as before, and Ctrl/Cmd+K still
  works from anywhere. The expanded sidebar no longer has a separate "Filter pages" box under its tabs. The top bar now keeps its
  shape: opening a journey only changes the Views button, in place (the journey's name and a clear button), where before the
  search box collapsed to a lone icon in the middle of the bar.
- An open comment closes when you go somewhere else: opening or stepping through a journey, going to a page from the search or the
  sidebar, switching to a screen size the comment is not on, entering compare, opening a page's history from its card. It stays
  open while you pan, zoom, use the comments list, or switch between Comments, Agent and Checks. The address drops the comment
  too, so a reload does not reopen it; a reply you had not sent is still there when you open the thread again. A new comment with
  something in it is never lost this way: it is put aside and a note offers it back ("Draft kept for Home", Reopen or Discard).
- The agent activity mark on the Agent button sits where the Comments count does, at the right end of the button, in the same size:
  a dot for one agent, a number for more. Its motion is a slow, small breath that stays inside the button (a working pin breathes
  the same way); the expanding ring is gone.
- A journey arrow that leads to a step off screen no longer runs out of the canvas like a stray line: it fades out at the edge and
  ends in a small chip with the step's number ("continues to step 2: Sign in" on hover); click the chip to go there. Arrows whose
  both ends are on screen are unchanged.
- A link that names both a comment and a journey opens the comment: its thread at its pin, the journey left out of the address.
- Keyboard focus is visible again on the controls that had lost their ring: the Comments, Agent and Checks buttons, the sidebar's
  items and its expand button, the page list, the journey bar's steps and more. They showed a tooltip but no outline when reached
  with Tab.
- A comment picked in the search (Ctrl/Cmd+K) puts the keyboard in its thread, so Tab reaches the reply box. Screen readers hear
  "Draw an arrow on the page" and "Draw freehand on the page" (they said "Draw a arrow", "Draw a pen").
- Esc closes the open thread first, also while the mouse rests on a pin and its preview is showing. A comment card you moved and
  then re-aimed at another element (while still empty) goes back beside its new pin.
- Drawing is clearly a mode. A bar at the top says "Drawing on Home · Desktop" and holds the tools, the inks, Undo, Clear and a
  Done button; the page you draw on is framed and the other pages step back; no element outlines appear under the pen. Entering it
  no longer moves the view (it did, to fit the page) unless the page is mostly off screen or drawn too small to draw on, and then
  the view goes back when you are done. Scrolling, Space and middle-drag still move the canvas while you draw. Done and Esc return
  to your comment with the drawing attached. In the composer the three tools are labelled "Draw". The bar never blocks the pen:
  where it sits over the top of the page a stroke can start on its label or between its buttons, and it fades back while you draw.
- The side panel (comments, agent, checks) can be dragged no wider than 560 px or 40% of the window, whichever is less. Before, it
  could take 60% of the window and cover most of the board; a wider width remembered from before comes back inside the limit. The
  comment box and an open thread stay on the canvas beside their pin, also when the panel is wide: before, they could end up on top
  of the panel.
- The board toolbar is one system: every control except the board name and Comment is the same quiet box (same height, corner,
  hairline), and Comments, Agent and Checks sit on one track like the screen sizes, with the open panel raised. Thin dividers
  separate the groups. Comment stays the one accent button. The status dot's tooltip says what it means ("Pages captured 3 hours
  ago").
- Hosted server: one board of a project can be removed. On the project page each board has "Remove board" (admins and owners, with
  a passkey check, behind a confirmation that names the board). It deletes that board's captures, history, comments and comment
  images from the server and frees their storage; the project, its other boards, tokens and share links stay. Pushing the same
  board id again brings the captures back but not the comments. Before, a board pushed by mistake stayed until the whole project
  was deleted.
- Hosted console, "Sign in a terminal": if you close the passkey check that Approve asks for, the page now says the login was not
  approved and why. Before, Approve looked as if it had done nothing.
- Agents have a name you choose and an icon. Connect asks for the name: the **Allow this?** confirmation has a Name field, filled in
  with "Claude Code", "Codex" and so on, so you can call it "Harry" before it is connected, and an optional icon. Later, **Edit** on
  each connected agent's row of the Agents page changes the name, the icon and a colour. Saving restarts nothing, runs no test, and
  works while the agent is answering. Before, the name could only be typed in the full settings form, the one-click Connect gave no
  chance to name an agent, and every agent showed two initials.
- Agent icons: twelve built-in avatars drawn for Shapewall, or a picture you upload (PNG, JPEG or WebP up to 2 MB, cropped to a
  square, re-encoded by the server and kept next to your agent settings; never an SVG). A connected Claude Code, Codex (the OpenAI
  mark), goose or Gemini CLI shows its product mark until you pick something else, and **Default** goes back to it; other agents
  and endpoints show initials. Sources and terms of the marks are in `THIRD_PARTY.md`.
- The name and icon show wherever the agent does: the Agents page and its default list, the chat header and its menu, the agent's
  answers, **Fix with <name>**, the batch of fixes and the `shapewall serve` start line. An agent's replies on a comment thread are
  signed with its name and marked as an agent's; replies written before keep the name they had. A command fixed with `--agent-acp`
  or `SHAPEWALL_AGENT_ACP` can be renamed too: the flag decides which agent runs, not what it is called. Only the owner on the
  machine that runs Shapewall can change any of it.
- Right after Connect, while a real agent is still starting for its connection test (several seconds; the test may take up to
  30), nothing answers "A connection test is running" any more. A name or an icon saved in that window is kept: for the agent
  being connected, Save waits ("Saving when the connection test finishes...") and then saves, or says that the agent did not
  connect; for another agent it saves at once and survives a failed test. The Agents page and the chat header say "Testing the
  connection" instead of looking finished; Test connection, Remove, Connect and the default are off with the reason until the
  test ends; a chat message or a Fix sent meanwhile says "Waiting for the connection test to finish" and then runs (the board now
  waits 45 seconds, longer than a test can last; it gave up after 30). Before, renaming an agent within seconds of connecting it
  failed with "A connection test is running. Wait for it, then save."
- Renaming an agent keeps the model and effort it last used: new chats start from them as before. They were remembered under the
  agent's name, so a rename started them over.
- Hosted server: a token name over 60 characters is refused when the token is made ("Token name: 1 to 60 characters."), as on a
  rename. Before, it was cut to 60 without a word.
- Hosted server: an API token can be renamed on the token lists (admins and owners, like revoking it), so a watcher shows up as
  "Harry" instead of "laptop (shapewall login)". The token itself, its scopes and what it already wrote do not change.
- Website contact page: the "Thanks, your message is on its way" heading no longer shows a focus rectangle, and the form's spacing
  is even (the character count sits beside the hint, above the field).

## 0.3.2 - 2026-11-11

- A comment or a reply can be a drawing or images with no text. Before, Post and Send stayed off until you typed something, and
  closing the thread threw the drawing away. A comment with no text, no image and no drawing is still refused. Where a line of text
  is needed (the comments list, notifications, `shapewall comments`, what an agent reads) such a comment shows as `(drawing)`,
  `(image)` or `(2 images)`; in `--json` its `body` is `""` and the `drawing` and `files` fields say what it has. The same on the
  hosted server and in the demo.
- A reply you started and did not send (its text, drawing and images) is still there when you close the thread and open it again. It
  is kept in the page only: a reload starts clean, and sending or emptying the reply clears it.
- Resolving a comment ends its agent status, however it is resolved (the board, `shapewall comments resolve`, the API, MCP): `queued`
  and `working` become `done`, and `needs-human` is cleared. Before, `comments resolve` left a comment showing
  `[resolved] [agent: working]`. Resolving such a comment now sends an agent status event after the resolved one. Reopening clears the
  status, as before.
- `shapewall comments add --selector` puts the pin in the middle of the element when the selector finds exactly one element in the
  latest capture, as a click there on the board would. Before, the pin always sat near the top-left corner. Without `--selector`, or
  when the selector finds no element or several, the pin stays near the corner and a note says so.
- New `shapewall comments selectors --page ID [--viewport NAME] [--text WORDS]` lists the selectors `--selector` takes, each with its
  element's text, from the latest capture. The error for a selector in the wrong form (a class, say) now names this command.
- Fix pressed right after Connect no longer comes back as "A connection test is running": a message sent while the connection
  test runs waits for it (up to 30 seconds) and then goes out.
- `shapewall init` names the board after what most page titles share ("Pricing -- Acme", "Blog -- Acme": "Acme"), and takes that
  name off each page's title. Before, the board got the home page's whole title, tagline included, and titles joined with ` -- ` kept
  the site name.
- `shapewall ci capture --allow-start` stops with a clear message when the site's URL already answers before `ci.start.serve` runs.
  Before, it captured whatever was serving that URL in place of the checkout, so a pull request could read "no visual changes" when
  it had some.
- `shapewall capture --env NAME` gives a login script that environment's `baseUrl`. Before, the script always got the first
  environment's, so a script that signs in to staging or production never saw their address. Page checks already did this.
- Pull request capture reports small real changes. A shot now counts as changed from 0.001% of its pixels (`ci.threshold` 0.00001);
  the default was 0.1%, which let a changed price or a renamed button on a tall page pass as "no visual changes". Set
  `"ci": { "threshold": 0.001 }` for the old behaviour.
- `npx shapewall doctor --install-browser` no longer shows Playwright's boxed warning about installing your project's dependencies
  first. It did not apply and read as a failure.

## 0.3.1 - 2026-11-10

- Starter agent: the push of the agent's branch no longer follows settings in the repository's Git config that would run another
  program. The transport is limited to https, http, ssh and local paths (no `ext::` or other remote helpers, whatever
  `protocol.*.allow` says), `remote.<name>.receivepack` is ignored, and the push is never signed. Your credential helper and ssh setup
  are still used: that is how the push reaches your remote.
- `shapewall init --ci` gives the comment job `contents: write` when the config has `"ci": { "images": "branch" }`, so the images
  branch can be pushed. Before, the generated workflow always had `contents: read` and the comment fell back to links.

## 0.3.0 - 2026-11-10

- Agent works on a branch: an option, off by default, that runs an ACP agent's fixes and chat turns in a copy of your checkout and
  commits them on a branch of their own. The comment reads "Fix ready on branch", and the chat offers Apply to my checkout, Open
  folder, Copy branch name and Discard. Apply recaptures the page with before and after; a conflict changes nothing. See
  "Work on a branch" in docs/agents.md.
- The Agents page of the Workspace Console has a How fixes run card: the Work on a branch switch with its branch prefix (the same
  setting as the chat's switch), and the batch fixes switch with its limit. A change to either shows in every open view.
- Batch fixes: an option, off by default, to fix several open comments one after another. In the comments panel choose Select, tick
  comments (or Select all, up to the limit) and Fix N with the agent; a dialog lists them first. Each comment is an ordinary fix with
  its own thread, approvals, recapture and Undo, and in branch mode its own branch. A card in the chat and a strip in the comments
  panel show "Fixing 2 of 5" and each comment's state, also after a reload. The batch waits for an approval, stops on Cancel and after
  two failures in a row. Set `"agent": { "batchFixes": { "enabled": true, "max": 5 } }` (at most 20) or use the Agents page. Not on
  the hosted server. See "Fix several comments at once" in docs/agents.md.
- `shapewall doctor` reports agent branches left in the project.
- Capture on pull requests: `shapewall init --ci` writes a GitHub Actions workflow that captures the base branch and the pull request,
  compares every page and screen size with the pixel diff, and keeps one comment on the pull request up to date ("Shapewall: 4 of 23
  pages changed") with the changed share and before, after and diff images. It builds and serves both sides from `ci.start` in the
  config, or captures a deploy preview URL. Pull requests from forks get the summary in the job summary instead. Turn it off by
  deleting the workflow, with `"ci": { "enabled": false }`, or with `[skip shapewall]` in the title. See docs/pull-requests.md.
- New commands: `shapewall ci capture-compare`, `ci capture`, `ci comment`, `ci enabled` and `ci wait`.
- Images on comments and replies: attach up to 4 (PNG, JPEG, WebP or GIF, 5 MB each) with a button, by pasting or by dropping them.
  The server checks each image by its bytes, strips its metadata and serves it only as an image; the thread shows thumbnails that open
  large. The comments list shows how many a thread has.
- Drawing on the page as part of a comment or reply: boxes, arrows and pen strokes in three inks, with Undo and Clear. The drawing
  shows over the page while its thread is open, and over "before" once the page is recaptured. On a phone you draw on the page in a
  full-screen sheet.
- Agents get the images and a picture of the drawing on its screenshot: in `comments --json` (`files.images`, `files.markup`), the MCP
  `get_comment` tool, `watch --exec` and Fix with agent.
- Hosted boards keep comment images in the database, count them against the storage quota and include them in exports and in
  `shapewall share`. Share link guests can draw but not attach images.
- The demo takes images and drawings in the browser and shows example comments with an image and a drawing, one of them with a fix
  ready on a branch. Its Agents page has the How fixes run card, and its scripted agent runs batch fixes.
- While you draw on a page, the collapsed sidebar's flyouts stay closed and the journey bar is hidden, so nothing covers the drawing
  bar.

## 0.2.4 - 2026-11-10

- The top bar's View button is now Views: pick a journey by name there, alongside links, compare and the minimap. An open journey
  shows its name in the top bar with a button to leave it. J and Shift+J step through journeys.
- An open journey's name comes before the search box in the top bar: the search becomes an icon and the name shows in full up to
  about 280 px.
- The sidebar has a Pages | Journeys switch, and collapsed, an icon for each; the Journeys icon shows a dot while a journey is open.
- Agent settings stay in sync everywhere: a change in another tab, the Agents page, `shapewall settings` or the agents file shows up
  in every open view without a reload, and never over unsaved typing.
- The demo's Agents page is the full page, with sample agents in every state.
- Releases are published to npm from CI with provenance.

## 0.2.3 - 2026-11-10

- The agent's model and thinking level are shown on a new chat before the first message, each with its own menu in the composer
  footer. Choices are kept per chat, and each answer shows the model it used.
- Agents has its own section in the workspace console, with connected agents and the chat connection on one page.
- The top bar shows which side panel is open, and the Comment button is filled only while comment mode is on.
- The board sidebar lists Account and security, like the console's.
- A calmer card when an agent is not signed in, with the command to run and a Check again button.
- Security reports can also go to hello@shapewall.com.

## 0.2.2 - 2026-11-10

- The collapsed sidebar opens flyouts: hover or click Pages for the full pages tree, or Workspace and Account for their sections,
  without expanding the whole sidebar.
- A new agent picker shows each connected agent with its state and your default. "Fix with agent" names the agent and, with more
  than one connected, lets you run a fix with another. Settings gains an Agents card to connect agents, pick the default and test them.
- The board's top bar is arranged in three groups: where you are and how you view it on the left, search in the centre, comment and
  panels on the right. It gives up space in a fixed order as the window narrows.
- Fixed: a brief flash of a few oversized cards before the board settled on its starting view.
- The demo has two scripted agents, so the picker can be tried there.
- A Contact link in the profile menu and beside About opens the contact page on shapewall.com.

## 0.2.1 - 2026-11-10

- On npm: `npm install --save-dev shapewall` or `npx shapewall`. Installing from GitHub still works for unreleased builds.
- Fixed: the `shapewall settings` page loads its theme script and icon when Shapewall is installed under a folder whose name starts
  with a dot (such as `~/.local`), so it follows your light or dark preference.
- Website: shapewall.com has a dark mode, with a System, Light and Dark choice.
- Docs: self-hosted multiplayer (`shapewall hosted`) is labelled beta, with what that means; the security docs list known limits.
- Security: a review of the starter agent, the MCP server and the remote client. `push` and `share` no longer follow symlinks out of
  the captures folder, `watch --remote` no longer writes through one, MCP results carry the same untrusted-data framing as
  `comments --json`, answers from a hosted server are size-capped, and the starter agent closes gaps in its limit caps, its
  pull-request guard and its cleanup. The security docs gain a Known limits section.
- The live HTML view keeps the colour scheme it was captured in instead of following the viewer's dark mode.
- Connecting an agent from the Agent panel and from Settings now gives one list of agents; a chat can switch to another connected
  agent when the first is not signed in, and a failed sign-in no longer posts on the comment.
- The comment-mode banner no longer covers the focused page's toolbar.
- Capture and `doctor` say when Chromium is installed but missing system libraries (bare Linux, containers, WSL).
- `init --base-url` finds your site's real pages (its sitemap, else the links on its pages) instead of writing sample pages.
- CI runs lint, unit tests, the build and the package check on every pull request.

## 0.2.0 - 2026-11-09

The first public release. Shapewall is now Apache 2.0 (it was MIT), with the self-hosted team server in `src/hosted` under the
Functional Source License 1.1 (Apache 2.0 after two years).

### Capture

- Your own viewports beside desktop, tablet and phone (`phone-landscape`, ...), with `layoutHeight`, `mobile`, `touch` and
  `userAgent`; a board can have its own set.
- Apps and games, not just landing pages: actions `tap`, `mouse`, `hold`, `keyDown`/`keyUp` and `waitForFunction`; `optional`,
  `viewports`, `timeout` and `force` on any action; a board `setup` that runs once per viewport and whose state the pages reuse;
  `localStorage` seeds; `block` request lists with a built-in `"analytics"` list; `reducedMotion`; per-page `timeout` and `frameHeight`.
- `shapewall auth record`: sign in by hand in a fresh browser and save the session for captures. Boards can have their own `auth`.
- Environments (`capture --env`) and a compare mode with pixel diffs; variants beside a page; previous captures kept per page
  (`versions`) for before and after and for page history.
- `shapewall sitemap` and `init --sitemap` fill the page list from a sitemap.
- Broken-link checks on every capture (`links --broken`, `--check-external`), `"expectStatus"` for pages that should answer with an
  error, `capture --json` for CI, and a named step in every capture failure.
- Capture warnings: API errors and HTTP 429s are counted beside the shots that still worked, and `capturePacing` slows captures down.
- A page scrolled by `scrollTo` or an in-page link is shot where it was scrolled to, not at the top.

### Board

- Journeys, with forks and branches, in the config or made on the board; **Links** draws the links between your pages.
- Page history with a pixel diff, before and after on resolved comments, "Go to page", page search.
- Comments: threads, @mentions, emoji reactions, reopen, search and filters, avatar pins with unread dots.
- Canvas navigation like Figma: wheel pans, Shift+wheel pans sideways, Ctrl/Cmd+wheel or a pinch zooms at the cursor.
- Light and dark themes, keyboard navigation, a phone layout with 44 px targets, installable as an app.
- A project dropdown that switches between the local projects you are serving; config edits apply without a restart.
- A Workspace Console and an About & Updates panel; updates stay manual ([docs/updates.md](docs/updates.md)).
- Optional local owner account with a passkey, recovery codes, sessions and a profile photo (`serve --accounts`).
- Your own other devices: `serve --tailscale` and `serve --lan` with pairing, and `shapewall devices` to approve and revoke.

### Agents

- `shapewall watch` hands each new comment to an agent exactly once; `shapewall mcp` gives agents tools; `comments add`, `reply`,
  `status`, `resolve` and `events --follow` cover shell-only agents and chat bots. `--for-agent` quotes comments as untrusted data.
- Chat on the board with your own agent: any OpenAI-compatible endpoint, or Claude Code, Codex, goose and Gemini CLI over ACP, with
  one-click connect for the CLIs found on your machine, approval cards with diffs, images, voice in and read aloud.
- Fix with agent: the agent changes the code in your checkout, the board recaptures the pages and shows before and after.
- A chat composer with `@` mentions, `/` commands, file attachments and queued follow-ups.
- The sandboxed starter agent for shared boards (`shapewall agent run|watch|doctor|build-image`): a container with one checkout, an
  egress allow list, budgets and a branch or pull request as its output.
- `shapewall settings`: change agent settings from the Shapewall computer without opening the board.
- Guides: [agent workflow](docs/agent-workflow.md), [recipes](docs/agent-recipes.md) and [hardening](docs/agent-hardening.md).

### Team server (self-hosted)

- `shapewall hosted`: passkey accounts with recovery codes, workspaces with four roles, invitations, an audit log, export and deletion.
- Share links for people without an account (view or comment, expiry, passcode), opt-in public projects, live presence and cursors.
- `shapewall share` moves a local project to the server; `login` and `push` upload captures; `comments`, `watch` and `mcp` take
  `--remote`; project-scoped agents with trusted dispatch, budgets and passkey approvals.
- Tailscale setup in one flag, optional Funnel for share links, `hosted --setup` for your own domain (Compose and Caddy), quotas,
  retention, `hosted backup` and `restore`, and moving the server to a new origin.

### Integrations

- GitHub connect: an issue from a comment, pull requests linked by `shapewall:12`, comments resolved when the PR merges.
- Notifications: signed webhook, Slack, Discord and email, with mentions routed per person.
- Page checks: reliability, SEO and social image probes (`shapewall checks`), Lighthouse lab audits (`shapewall audit`),
  accessibility and interaction audits, report comparisons and budgets ([docs/page-checks.md](docs/page-checks.md)).
- An optional bridge to agents in a Buzz chat channel ([docs/buzz.md](docs/buzz.md)).

### CLI and packaging

- `shapewall <command> --help`; unknown options are errors with a "did you mean" hint; errors name the bad value.
- `shapewall doctor` checks Node, the browser, the config, the port, notifications and the agent; `--install-browser` gets Chromium.
- `shapewall export` includes compare data and can let visitors comment in their own browser (`--browser-comments`).
- Runtime dependencies are pinned to exact versions, so an install from GitHub or a tarball gets what was tested.
- A Docker image on the pinned Playwright base, and `docker-compose.example.yml`.

### Security

- Comment JSON is marked `trust: "untrusted"`; board text reaches agents as quoted data, never as instructions.
- Local agent: a board opened without the private owner link can no longer chat with an ACP agent or approve its command cards.
- Config from a cloned repository is trusted less: `browser.executablePath` cannot point inside the project folder, capture prints a
  notice before it runs a login script named in the config, an email channel's `apiKeyEnv` must be `RESEND_API_KEY` or `SHAPEWALL_*`,
  and a `github.apiUrl` only receives your token when `SHAPEWALL_GITHUB_API_URL` is set to the same URL.
- Capture refuses a public hostname that resolves to a private address.
- Buzz bridge: no built-in signer file paths. It stays off until `signerFiles` (or `SHAPEWALL_BUZZ_SIGNER_CODEX` and
  `SHAPEWALL_BUZZ_SIGNER_CLAUDE`) names both files.
- Device pairing keeps at most five pending requests; a sixth replaces the oldest.
- Team server: an API token works only while its creator is still an admin or owner. **Send to agent** and **Approve agent run**
  refuse a comment edited since you opened it. Agents never receive share-link guests' replies unless run with `--include-guests`.
  Command approvals and denials are in the audit log. Only admins set an agent status from the board. Turning public projects off
  clears every public URL for good. The console and board APIs are rate limited per account (1200 requests a minute, 6000 for files).
- The live HTML sanitizer's CSS scans are linear in the input size.

## 0.1.0 - 2026-11-03

First version.

- `shapewall init`, `capture`, `serve`, `comments`, `variant` and `export` commands.
- Playwright capture at configurable desktop, tablet and phone viewports: fixed-frame PNG, thumbnail, and sanitized live HTML with
  inlined CSS (responsive rules kept), images and fonts.
- Three-layer live HTML sandbox: allowlist sanitizer, strict CSP (header and meta tag), `sandbox="allow-same-origin"` frame.
- React Flow board: groups, desktop/phone/both modes, thumbnails when zoomed out, live HTML when zoomed in or opened, minimap.
- Comments pinned to elements on live HTML (selector + text fallback), resolve, reopen, delete, filters, per-page notes.
- Variants beside their page.
- Phone layout with 44 px targets, a comments sheet, and Back closing the topmost overlay.
- Capture lock with stale-lock takeover; atomic JSON storage with a file lock for concurrent writers.
- Agent-friendly `shapewall comments --json` with selectors, positions and screenshot paths.
- Bundled demo site, unit and end-to-end tests, CI workflow.
