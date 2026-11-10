import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Layout } from './components/layout.jsx'
import Home from './pages/Home.jsx'
import Features from './pages/Features.jsx'
import OpenSource from './pages/OpenSource.jsx'
import Privacy from './pages/Privacy.jsx'
import LegalTemplate from './pages/legal/LegalTemplate.jsx'
import NotFound from './pages/NotFound.jsx'
import { DocsLayout, DocPage } from './pages/Docs.jsx'
import { DOCS, REDIRECTS } from './routes.js'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/features" element={<Features />} />
        {Object.entries(REDIRECTS).map(([from, to]) => (
          <Route key={from} path={from} element={<RetiredPage to={to} />} />
        ))}
        <Route path="/open-source" element={<OpenSource />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/legal/terms" element={<LegalTemplate slug="terms" />} />
        <Route path="/legal/privacy" element={<LegalTemplate slug="privacy" />} />
        <Route path="/legal/subprocessors" element={<LegalTemplate slug="subprocessors" />} />
        <Route path="/legal/acceptable-use" element={<LegalTemplate slug="acceptable-use" />} />
        <Route path="/docs" element={<DocsLayout />}>
          {DOCS.map((doc) =>
            doc.path === '/docs' ? (
              <Route key={doc.path} index element={<DocPage doc={doc} />} />
            ) : (
              <Route key={doc.path} path={doc.path.slice('/docs/'.length)} element={<DocPage doc={doc} />} />
            ),
          )}
          <Route path="*" element={<NotFound inDocs />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}

function RetiredPage({ to }) {
  const { search, hash } = useLocation()
  return <Navigate to={{ pathname: to, search, hash }} replace />
}
