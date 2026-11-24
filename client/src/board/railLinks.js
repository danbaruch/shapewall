// The account page sits beside the workspace in the same console: "/w/<id>"
// becomes "/account", and the demo's "console.html#/w/<id>" keeps its file.
export const accountUrlFor = (consoleUrl) => String(consoleUrl).replace(/\/w\/[^/#?]+.*$/, '/account')
