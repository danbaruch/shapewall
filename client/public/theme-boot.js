// Applies the saved appearance to <html> before the first paint, so a dark or
// themed page never flashes light. A plain script (not a module, which would
// run after the first paint), loaded from 'self' so the strict CSPs allow it.
// client/src/lib/theme.js owns appearance after this (changes, System
// following the OS); test/theme.test.js keeps the two in step.
;(function () {
  var THEMES = ['default', 'ocean', 'forest', 'contrast']
  var saved = null
  try {
    saved = JSON.parse(window.localStorage.getItem('shapewall.appearance') || 'null')
  } catch (error) {
    saved = null
  }
  var mode = saved && (saved.mode === 'light' || saved.mode === 'dark') ? saved.mode : 'system'
  var theme = saved && THEMES.indexOf(saved.theme) >= 0 ? saved.theme : 'default'
  if (mode === 'system') {
    var dark = false
    try {
      dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    } catch (error) {
      dark = false
    }
    mode = dark ? 'dark' : 'light'
  }
  document.documentElement.setAttribute('data-mode', mode)
  document.documentElement.setAttribute('data-theme', theme)
})()
