// Build-time renderer for scripts/prerender.mjs: each route as HTML, hydrated in the browser by src/main.jsx.
import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom'
import App from './App.jsx'

export function render(path) {
  return renderToString(
    <StrictMode>
      <StaticRouter location={path}>
        <App />
      </StaticRouter>
    </StrictMode>,
  )
}
