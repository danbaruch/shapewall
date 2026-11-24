// The Brackwell world's own content for the demo backend (world.js): earlier
// chats, agent feedback and the first board conversation. Brackwell is a
// fictional field operations app; everything here is made up. fixtures.js
// picks these when the export says demoApp "brackwell", and keeps the Lumen
// ones otherwise.

export function chats({ today, yesterday, ask, answer, tool, robin, jo }) {
  return [
    {
      id: 'chat-seedreleasenote1',
      owner: robin,
      messages: [
        ask('msg_chat1a', today, 'Draft release notes for route planning'),
        answer(
          'msg_chat1b',
          today - 0.02,
          "**Route planning (staging)**\n\n- Dispatch can plan a technician's day as one route, in drive order.\n- Late jobs show in red on the map and the list.\n- Unassigned jobs sit in their own lane until someone takes them.\n\nIt is only on staging so far; want a version for the public changelog once it ships?",
          [tool('seed-chat1-tool', 'Read the comments on Route plan', '1 open, agent working')],
        ),
      ],
    },
    {
      id: 'chat-seedalttextaudt1',
      owner: robin,
      messages: [
        ask('msg_chat2a', yesterday, 'Which list screens still have no empty state?'),
        answer(
          'msg_chat2b',
          yesterday - 0.02,
          'From the latest captures: Work orders, Customers, Search and Home have one. Projects, Purchase orders and Time off do not; they show an empty table. Want me to queue one instruction per screen?',
          [tool('seed-chat2-tool', 'Checked the captured screens', '146 screens')],
        ),
      ],
    },
    {
      id: 'chat-seedonboardflow1',
      owner: robin,
      edited: true,
      messages: [
        ask('msg_chat3c', 96, 'Walk the "Work order to paid invoice" journey on phone and desktop'),
        answer(
          'msg_chat3d',
          95.97,
          '1. **Work orders to new job:** the same on both.\n2. **Assign:** on a phone the dialog covers the map, so dispatchers lose the context.\n3. **Technician app:** checklist, photos and signature fit at 390 px.\n4. **Invoice:** the phone hides the line items behind a tap.\n\nThe biggest gap is step 2: a bottom sheet instead of a dialog would keep the map visible.',
        ),
      ],
      branch: [
        ask('msg_chat3a', 97, 'Compare creating a work order on phone and desktop'),
        answer('msg_chat3b', 96.98, 'The form is the same five fields on both; the phone stacks them in one column.'),
      ],
    },
    {
      id: 'chat-seedemptystates1',
      owner: robin,
      archived: true,
      messages: [
        ask('msg_chat4a', 170, 'Ideas for the empty state on Customers?'),
        answer(
          'msg_chat4b',
          169.98,
          'One line on what a customer is for, an Import from spreadsheet button, and Add customer as the main action.',
        ),
      ],
    },
    {
      id: 'chat-seedjosquestion1',
      owner: jo,
      messages: [
        ask('msg_chat5a', yesterday + 3, 'Is the sidebar the same on every app screen?'),
        answer(
          'msg_chat5b',
          yesterday + 2.98,
          'Yes. Every app screen has the same ten sidebar items; phones show five of them as a tab bar.',
        ),
      ],
    },
  ]
}

// [handle, rating, reasons, note, agent, hours, question, answer, messageId, threadId]
export function ratings({ demoAgent, codingAgent }) {
  return [
    [
      'robin',
      'up',
      [],
      '',
      demoAgent,
      4.9,
      'What is still open on the work orders screens?',
      'Four instructions are open on Work orders: two queued, one with the agent, one waiting on you.',
      'msg_seed2',
      'board',
    ],
    [
      'sam',
      'down',
      ['ignored'],
      'I asked for a layout, it only listed the comments.',
      demoAgent,
      20,
      'Suggest a phone layout for the revenue report',
      'Revenue has one resolved comment. Here are the comments on the screen.',
      'msg_rated01',
      'board',
    ],
    [
      'robin',
      'up',
      [],
      'Small change, and it explained it.',
      codingAgent,
      28,
      'Do what this comment asks in the project.',
      'Added a bulk Assign button to the selection bar on Work orders and recaptured the screen.',
      'msg_rated02',
      'comment-1',
    ],
    [
      'jo',
      'down',
      ['wrong'],
      'Yearly is 29, not 35.',
      demoAgent,
      46,
      'What does the Pro plan cost yearly?',
      'The Pro plan is 35 per seat a month, billed yearly.',
      'msg_rated03',
      'board',
    ],
    [
      'priya',
      'down',
      ['slow', 'other'],
      '',
      codingAgent,
      70,
      'Check the technician app on a phone',
      'The job screen fits at 390 px, but the Navigate button sat below the checklist.',
      'msg_rated04',
      'board',
    ],
    [
      'robin',
      'down',
      ['unsafe'],
      'It wanted to rewrite the whole stylesheet for one legend.',
      codingAgent,
      94,
      'Do what this comment asks in the project.',
      'I will rewrite styles.css to use new map tokens everywhere.',
      'msg_rated05',
      'comment-3',
    ],
    [
      'jo',
      'up',
      [],
      '',
      demoAgent,
      118,
      'Which screens have no phone capture?',
      'Every screen has a phone capture.',
      'msg_rated06',
      'board',
    ],
    [
      'sam',
      'up',
      [],
      'Exactly the copy I needed.',
      demoAgent,
      140,
      'Suggest a shorter empty state line for Projects',
      'Try: "No projects yet. Group related jobs into one to track budget and dates."',
      'msg_rated07',
      'board',
    ],
  ]
}

export function thread(at) {
  return [
    { id: 'msg_seed1', role: 'user', text: 'What is still open on the work orders screens?', attachments: [], createdAt: at(5) },
    {
      id: 'msg_seed2',
      role: 'assistant',
      text: 'Four instructions are open on Work orders. The error state reuse is with the agent; "Complete requires a signature" waits on you; the projects bulk select and the low-stock reorder are queued. Bulk Assign and the Download PDF button were done and resolved. Want me to start on the queued ones?',
      cards: [
        {
          id: 'seed-tool-1',
          kind: 'tool',
          name: 'list_comments',
          label: 'Read the comments on Work orders',
          state: 'done',
          detail: '4 open, 2 resolved',
        },
      ],
      model: 'scripted',
      status: 'done',
      createdAt: at(4.99),
    },
  ]
}

// Search and share previews (checks.js) for the marketing screens.
export const SEO_PAGES = {
  home: {
    title: 'Brackwell -- every job, on time, on one screen',
    description:
      'Brackwell schedules, dispatches and invoices field work for mechanical, electrical and facilities teams. Technicians get an app that works offline.',
    image: ['#1d4ed8', '#1e3a8a', '#93c5fd'],
  },
  product: {
    title: 'Product -- Brackwell',
    description: '',
    image: ['#0f766e', '#134e4a', '#5eead4'],
    findings: ['seo-description'],
  },
  pricing: {
    title: 'Pricing for field service teams of every size, from two vans to a hundred technicians -- Brackwell',
    description:
      'Start with Starter for small crews. Pro adds dispatch, routes and the customer portal; Enterprise adds single sign-on, audit logs, custom roles and a named contact for larger companies.',
    image: ['#7c3aed', '#4c1d95', '#c4b5fd'],
    findings: ['seo-title-long', 'seo-description-long'],
  },
  'feat-scheduling': {
    title: 'Product -- Brackwell',
    description: 'Drag jobs onto a week, see conflicts in red and keep every technician busy.',
    canonical: '/product/',
    image: null,
    findings: ['canonical-elsewhere', 'seo-ogimage'],
  },
  changelog: {
    title: 'Changelog -- Brackwell',
    description: 'Every improvement to Brackwell, newest first.',
    robots: 'noindex',
    image: ['#1d4ed8', '#1e3a8a', '#93c5fd'],
    findings: ['search-noindex'],
  },
  customers: {
    title: 'Customers -- Brackwell',
    description: 'How mechanical and facilities teams run their day on Brackwell.',
    image: ['#b45309', '#78350f', '#fcd34d'],
  },
  story: {
    title: 'Northgate Mechanical -- Brackwell',
    description: 'How mechanical and facilities teams run their day on Brackwell.',
    image: 'broken',
    findings: ['social-image-failed'],
  },
  contact: {
    title: 'Contact',
    description: 'Talk to us.',
    image: null,
    findings: ['seo-title-short', 'seo-description-short', 'seo-ogimage'],
  },
}
export const SEO_DUPLICATE_TITLES = ['product', 'feat-scheduling']
export const SEO_DUPLICATE_DESCRIPTIONS = ['customers', 'story']
