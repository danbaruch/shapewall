// The CSP nonce the server put in <meta name="sw-nonce">. get-nonce (used by
// react-style-singleton under Radix's scroll lock) reads __webpack_nonce__.
const meta = document.querySelector('meta[name="sw-nonce"]')
const nonce = meta?.getAttribute('content')
if (nonce && nonce !== '__SW_NONCE__') globalThis.__webpack_nonce__ = nonce
