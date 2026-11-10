// The chat's agent picker (header.jsx ProfilePicker), from the thread's
// `profiles` (src/agent/routes.js): every connected agent once, by name. The
// default connection is listed only when it is not one of the profiles
// (`sameAs` names the profile it runs); a thread on the default then shows
// that profile as chosen.
//
// { show, value, options: [{ id, label, configured }] }. `value` is what the
// picker shows; choosing it again changes nothing (see `choice`).
export function pickerProfiles(thread) {
  const profiles = Array.isArray(thread?.profiles) ? thread.profiles : []
  const current = thread?.profileId || 'default'
  const fallback = profiles.find((profile) => profile.id === 'default')
  const options = profiles
    .filter((profile) => !(profile.id === 'default' && profile.sameAs))
    .map((profile) => ({
      id: profile.id,
      label: profile.label || (profile.id === 'default' ? 'Default connection' : profile.id),
      configured: profile.configured !== false,
    }))
  const value = current === 'default' && fallback?.sameAs ? fallback.sameAs : current
  const known = options.some((option) => option.id === value)
  return { show: profiles.length > 0 && (options.length > 1 || !known), value, known, options }
}

// The profile id to save for a pick, or null when it is what the thread
// already uses (the default shown as its profile included).
export function choice(thread, picked) {
  const { value } = pickerProfiles(thread)
  return picked === value ? null : picked
}
