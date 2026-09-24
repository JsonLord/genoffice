import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import httpProxy from 'http-proxy'
import { handleApiRequest } from './api.mjs'

const PORT = Number(process.env.PORT || 7860)

// ─── Bearer token for the /api/v1 machine API ────────────────────────────
// Separate from Hugging Face's own infrastructure auth (Space visibility /
// OAuth), and separate from the Docs/Slides apps' own end-user auth: this
// gates the small, stable /api/v1 surface this proxy itself exposes for
// machine clients (e.g. the `cws` CLI).
//
// Prefer a COWORK_API_TOKEN Space secret. If unset, generate a random token
// and print it to the container logs (secure by default) so a deployed
// Space is never open by accident. Set COWORK_API_AUTH_DISABLED=true to
// explicitly turn auth off for local development only; never do this in a
// deployed Space.
const API_AUTH_DISABLED = process.env.COWORK_API_AUTH_DISABLED === 'true'
const API_TOKEN = API_AUTH_DISABLED
  ? null
  : process.env.COWORK_API_TOKEN || crypto.randomBytes(24).toString('base64url')

console.log('════════════════════════════════════════════════════════════')
if (API_AUTH_DISABLED) {
  console.log(' /api/v1 authentication is DISABLED (COWORK_API_AUTH_DISABLED=true)')
  console.log(' Do not set this in a deployed Space.')
} else {
  console.log(' /api/v1 bearer token:')
  console.log(' ' + API_TOKEN)
  if (process.env.COWORK_API_TOKEN) {
    console.log(' (from the COWORK_API_TOKEN secret — stable across restarts)')
  } else {
    console.log(' (random — regenerates on every restart; set a COWORK_API_TOKEN')
    console.log(' Space secret to pick your own and stop it from changing)')
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

  if (handleApiRequest(req, res, url, API_TOKEN)) {
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
