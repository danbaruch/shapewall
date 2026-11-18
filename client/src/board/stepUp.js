// Sends a hosted request, and asks for the passkey only when the server says
// this workspace wants it again (403 reauth_required): then it is asked for
// and the same request goes once more. Asking first would make approval
// impossible where the workspace does not require a passkey, or where the
// server has passkeys off (tailnet sign-in): there the server refuses the
// passkey prompt itself.
export async function sendWithStepUp(send, confirm) {
  try {
    return await send()
  } catch (failure) {
    if (failure?.code !== 'reauth_required') throw failure
    await confirm()
    return send()
  }
}
