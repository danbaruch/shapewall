import http from 'node:http'
import fs from 'node:fs'
import { BridgeError, loadBridgeConfig, privatePath, projectFor, within } from './config.js'

export function createBuzzClient(file, config) {
  const bridge = loadBridgeConfig(file)
  const root = fs.realpathSync(config.dir)
  // None of this private state may be served as captures, shell assets or a
  // source project's files, including a custom outputDir outside the root.
  if ([bridge.file, bridge.socketPath, bridge.stateDir].some((p) => within(p, config.outputDir)))
    throw new Error('Buzz private state must be outside capture/export data.')
  const available = (board) => {
    try {
      projectFor(bridge, root, board)
      return true
    } catch {
      return false
    }
  }
  return {
    available,
    request(action, board, body = {}) {
      projectFor(bridge, root, board)
      privatePath(bridge.socketPath, 'socket')
      return new Promise((resolve, reject) => {
        const request = http.request(
          { socketPath: bridge.socketPath, path: `/${action}`, method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (response) => {
            let output = ''
            response.on('data', (part) => {
              output += part
              if (Buffer.byteLength(output) > 8 * 1024 * 1024) request.destroy(new Error('Bridge response too large.'))
            })
            response.on('end', () => {
              try {
                const data = JSON.parse(output)
                if (response.statusCode !== 200)
                  return reject(
                    new BridgeError(
                      data.error?.code || 'bridge_unavailable',
                      data.error?.message || 'Buzz gateway unavailable.',
                      response.statusCode,
                    ),
                  )
                resolve(data)
              } catch {
                reject(new BridgeError('bridge_unavailable', 'Buzz gateway returned an invalid response.', 503))
              }
            })
            response.on('error', () =>
              reject(
                new BridgeError(
                  'bridge_unavailable',
                  'Buzz gateway disconnected. Delivery may be unknown; refresh receipts before sending again.',
                  503,
                ),
              ),
            )
          },
        )
        request.setTimeout(100000, () => request.destroy())
        request.on('error', () =>
          reject(
            new BridgeError(
              'bridge_unavailable',
              'Start the private Buzz gateway on this computer. Check receipts before retrying a send.',
              503,
            ),
          ),
        )
        request.end(JSON.stringify({ ...body, root, board }))
      })
    },
  }
}
