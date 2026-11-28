// What the solo engine's owner app (src/hosted/app.js consoleDeps.team) reads
// about team mode (src/hosted/solo/team.js), per request: whether it is on
// and the address the people invited reach. `get` returns the controller
// (app.locals.soloTeam) or nothing (a test app without one): off.
export function soloTeamView(get) {
  const status = () => {
    try {
      return get()?.status() || null
    } catch {
      return null
    }
  }
  return {
    on: () => status()?.on === true && typeof status()?.origin === 'string',
    origin: () => (status()?.on === true ? status()?.origin || null : null),
    // What the console shows: { on, origin, saved, problem }.
    view: () => {
      const now = status()
      return {
        on: now?.on === true,
        origin: now?.on === true ? now.origin || null : null,
        saved: now?.saved === true,
        problem: now?.problem || null,
        available: Boolean(get()),
      }
    },
  }
}
