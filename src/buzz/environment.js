export const BUZZ_CREDENTIAL_NAMES = ['BUZZ_PRIVATE_KEY', 'BUZZ_AUTH_TAG', 'BUZZ_RELAY_URL']

export function withoutBuzzCredentials(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !BUZZ_CREDENTIAL_NAMES.includes(name)))
}

export function requireCleanBuzzEnvironment(env = process.env) {
  if (BUZZ_CREDENTIAL_NAMES.some((name) => env[name] !== undefined))
    throw new Error('Launch Shapewall without inherited Buzz credential variables. Use the shapewall CLI clean launcher.')
}

export const signerBaseEnvironment = () => ({ HOME: os.homedir(), PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' })
import os from 'node:os'
