#!/usr/bin/env node
import { main } from '../src/cli.js'
import { terminalSafe } from '../src/remote/terminal.js'
import { spawn } from 'node:child_process'
import { BUZZ_CREDENTIAL_NAMES, withoutBuzzCredentials } from '../src/buzz/environment.js'

// Buzz tool shells inherit agent credentials. Re-exec before starting any
// Shapewall server/gateway so its process environment never contains them.
if (BUZZ_CREDENTIAL_NAMES.some((name) => process.env[name] !== undefined)) {
  const child = spawn(process.execPath, process.argv.slice(1), { env: withoutBuzzCredentials(process.env), stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('error', () => {
    console.error('shapewall: could not start with a clean environment')
    process.exitCode = 1
  })
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0)
  })
} else
  main().then(
    (code) => {
      // `serve` keeps running (null); everything else exits with its code.
      if (code !== null) process.exitCode = code
    },
    (error) => {
      console.error(`shapewall: ${terminalSafe(error.message)}`)
      process.exitCode = 1
    },
  )
