import http from 'node:http'
import { spawn } from 'node:child_process'
import httpProxy from 'http-proxy'
import { handleApiRequest } from './api.mjs'
import { resolveApiAuth, FatalConfigError } from './config.mjs'
import { createDocsAdapter } from './docsAdapter.mjs'

const PORT = Number(process.env.PORT || 7860)

// ─── Bearer token for the /api/v1 machine API ────────────────────────────
// Separate from Hugging Face's own infrastructure auth (Space visibility /
// OAuth), and separate from the Docs/Slides apps' own end-user auth: this
// gates the small, stable /api/v1 surface this proxy itself exposes for
// machine clients (e.g. the `cws` CLI).
//
// resolveApiAuth (config.mjs) fails closed: in a deployed environment
// (SPACE_ID set by HF, or COWORK_ENV=production), COWORK_API_TOKEN is
// required and auth cannot be disabled — no auto-generated token, since one
// is only as secret as the container logs it's printed to. Auto-generation
// and COWORK_API_AUTH_DISABLED=true are dev-only conveniences.
let apiAuth
try {
  apiAuth = resolveApiAuth(process.env)
} catch (err) {
  if (!(err instanceof FatalConfigError)) throw err
  console.error('════════════════════════════════════════════════════════════')
  console.error(' FATAL: ' + err.message)
  console.error('════════════════════════════════════════════════════════════')
  process.exit(1)
}
const API_TOKEN = apiAuth.token

console.log('════════════════════════════════════════════════════════════')
if (apiAuth.disabled) {
  console.log(' /api/v1 authentication is DISABLED (COWORK_API_AUTH_DISABLED=true)')
  console.log(' Do not set this in a deployed Space.')
} else {
  console.log(' /api/v1 bearer token:')
  console.log(' ' + API_TOKEN)
  if (apiAuth.generated) {
    console.log(' (random — regenerates on every restart; set a COWORK_API_TOKEN')
    console.log(' Space secret to pick your own and stop it from changing)')
  } else {
    console.log(' (from the COWORK_API_TOKEN secret — stable across restarts)')
  }
}
console.log('════════════════════════════════════════════════════════════')

// ─── Child processes ──────────────────────────────────────────────────────
const children = []

function startChild(name, cmd, args, opts) {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    ...opts,
    env: { ...process.env, ...opts.env },
  })
  child.on('exit', (code, signal) => {
    console.error(`[${name}] exited (code=${code} signal=${signal}) — not restarting`)
  })
  children.push({ name, child })
  return child
}

startChild('docs', 'npm', ['start'], {
  cwd: '/app/docs/collab',
  env: { PORT: '8080', HOST: '127.0.0.1', CASUAL_FILE_EXT: '.docx', TRUST_PROXY: 'true' },
})

startChild('slides', 'npm', ['start'], {
  cwd: '/app/slides/apps/server',
  env: { PORT: '3002', HOST: '127.0.0.1', STATIC_DIR: '/app/slides/apps/web/dist' },
})

// ─── Reverse proxy ─────────────────────────────────────────────────────────
const DOCS_TARGET = { host: '127.0.0.1', port: 8080 }
const SLIDES_TARGET = { host: '127.0.0.1', port: 3002 }

// Adapter for the /api/v1 documents.* operations — talks to the same Docs
// backend the proxy above forwards to, over plain HTTP rather than through
// the proxy itself. See docsAdapter.mjs and docs/hf-space-docs-api-audit.md
// for what's actually implemented and why.
const docsAdapter = createDocsAdapter({ baseUrl: `http://${DOCS_TARGET.host}:${DOCS_TARGET.port}` })

const proxy = httpProxy.createProxyServer({ ws: true })
proxy.on('error', (err, req, res) => {
  console.error('proxy error:', err.message)
  if (res && !res.headersSent && typeof res.writeHead === 'function') {
    res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end('Bad gateway — the backend for this route is still starting up. Try again shortly.')
  }
})

function stripPrefix(url, prefix) {
  if (url === prefix) return '/'
  if (url.startsWith(prefix + '/')) return url.slice(prefix.length) || '/'
  return null
}

const server = http.createServer((req, res) => {
  const url = req.url || '/'

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }))
    return
  }

  if (handleApiRequest(req, res, url, API_TOKEN, { docsAdapter })) {
    return
  }

  if (url === '/api-docs') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' })
    res.end(
      '<!doctype html><title>OpenUI Cowork</title>' +
        '<body style="font:14px system-ui,sans-serif;max-width:640px;margin:40px auto;line-height:1.6">' +
        '<h1>OpenUI Cowork</h1>' +
        '<p>Two open-source apps behind one proxy:</p>' +
        '<ul><li><code>/</code> — Casual Docs (.docx editor)</li>' +
        '<li><code>/slides/</code> — Casual Slides (.pptx editor)</li></ul>' +
        '<p><code>/health</code> — liveness probe</p>' +
        '<p><code>/api/v1/*</code> — machine API for this deployment (bearer-authenticated; see ' +
        '<code>/.well-known/cws.json</code> and <code>/openapi.json</code>)</p></body>',
    )
    return
  }

  if (url === '/slides' || url.startsWith('/slides/')) {
    req.url = stripPrefix(url, '/slides')
    proxy.web(req, res, { target: SLIDES_TARGET })
    return
  }

  // Everything else (the Docs SPA, /yjs REST, /r/:roomId, …) goes to Docs.
  proxy.web(req, res, { target: DOCS_TARGET })
})

server.on('upgrade', (req, socket, head) => {
  const url = req.url || '/'
  if (url === '/slides' || url.startsWith('/slides/')) {
    req.url = stripPrefix(url, '/slides')
    proxy.ws(req, socket, head, { target: SLIDES_TARGET })
    return
  }
  // Docs' own /yjs collab socket, at the root.
  proxy.ws(req, socket, head, { target: DOCS_TARGET })
})

server.listen(PORT, () => {
  console.log(`OpenUI Cowork proxy listening on ${PORT}`)
})

process.on('SIGTERM', () => {
  for (const { child } of children) child.kill('SIGTERM')
  process.exit(0)
})
