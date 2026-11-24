// Renders the demo dashboard in the browser, like a single-page app would.
// Shapewall's live HTML keeps the rendered result and drops this script.
const notes = [
  { title: 'Q3 research plan', updated: '2 hours ago', status: 'Shared' },
  { title: 'Interview notes: onboarding', updated: 'Yesterday', status: 'Draft' },
  { title: 'Reading list', updated: '3 days ago', status: 'Shared' },
  { title: 'Weekly review', updated: 'Last week', status: 'Draft' },
]

const workspace = document.getElementById('workspace')
workspace.innerHTML = `
  <h1 style="font-size:30px;margin:0">Good morning</h1>
  <p class="meta">You have ${notes.length} recent notes.</p>
  <div class="stats">
    <div class="stat"><span class="meta">Notes</span><b>248</b></div>
    <div class="stat"><span class="meta">Linked this week</span><b>37</b></div>
    <div class="stat"><span class="meta">Shared spaces</span><b>4</b></div>
  </div>
  <table>
    <thead><tr><th>Note</th><th aria-sort="descending" data-testid="sort-updated">Updated &darr;</th><th>Status</th></tr></thead>
    <tbody>
      ${notes
        .map(
          (note) =>
            `<tr><td><a href="/app/note/">${note.title}</a></td><td>${note.updated}</td><td><span class="pill ${note.status === 'Draft' ? 'draft' : ''}">${note.status}</span></td></tr>`,
        )
        .join('')}
    </tbody>
  </table>
`
