// Id formats shared by the hosted server and its clients (push, remote
// comments, watch, MCP). Kept outside src/hosted so the Apache-2.0 client code
// does not depend on the FSL-licensed server.

export const ID_PATTERNS = {
  workspace: /^ws_[a-f0-9]{24}$/,
  project: /^pr_[a-f0-9]{24}$/,
  user: /^us_[a-f0-9]{24}$/,
  token: /^tk_[a-f0-9]{24}$/,
  invite: /^iv_[a-f0-9]{24}$/,
  push: /^ps_[a-f0-9]{24}$/,
}
