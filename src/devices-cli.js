import { Devices } from './server/devices.js'
export function devicesCommand(config, positional, flags, out, env = process.env) {
  const devices = new Devices(config.dir, { env })
  const [action = 'list', id] = positional
  if (action === 'list') {
    const list = devices.list()
    if (flags.json) out(JSON.stringify(list, null, 2))
    else {
      for (const item of list.devices) out(`${item.id}  ${item.name} (last seen ${new Date(item.lastSeenAt).toISOString()})`)
      for (const item of list.pending) out(`Pending ${item.code.slice(0, 4)}-${item.code.slice(4)}  ${item.name} (${item.ip})`)
      if (!list.devices.length && !list.pending.length) out('No paired devices or pending requests for this project.')
    }
  } else if (['approve', 'deny'].includes(action)) {
    if (!id) throw new Error(`devices ${action} needs the code shown on the device.`)
    const result = devices.decide(id, action === 'approve')
    out(`${result.name}: ${result.state}`)
  } else if (action === 'revoke') {
    if (!id && !flags.all) throw new Error('devices revoke needs a device id or --all.')
    out(`Revoked ${devices.revoke(flags.all ? '--all' : id)} device(s).`)
  } else throw new Error('devices: use list, approve CODE, deny CODE, or revoke ID|--all.')
}
