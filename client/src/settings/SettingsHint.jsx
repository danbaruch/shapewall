// How to unlock agent settings when this tab has no owner link: one wording,
// used by the chat panel, quick connect and the settings dialogs.

export const TOKEN_HINT =
  'On the computer running Shapewall, run shapewall settings --config FILE --open with this project’s config file to open agent settings. For a direct local board, you can also use the owner link printed by shapewall serve.'

export function SettingsHint() {
  return (
    <>
      On the computer running Shapewall, run <code className="break-words font-mono">shapewall settings --config FILE --open</code> with
      this project’s config file to open agent settings. For a direct local board, you can also use the owner link printed by{' '}
      <code className="font-mono">shapewall serve</code>.
    </>
  )
}
