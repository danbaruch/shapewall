// Which OS user is on the other end of a loopback connection (Linux), for the
// solo engine's sign-in gate (src/hosted/solo/signin.js). The check lives in
// the core (src/peer-uid.js), shared with the local board's account session.
export { peerUids, sameUserPeer } from '../../peer-uid.js'
