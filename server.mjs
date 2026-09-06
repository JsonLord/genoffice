import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import httpProxy from 'http-proxy';

const PORT = Number(process.env.PORT || 7860);

// ─── Access code for the embedded OpenCode chat ──────────────────────────
// OpenCode is a coding agent with shell/file tool access in this container.
// Its own server has no auth by default (OPENCODE_SERVER_PASSWORD unset —
// it's only ever reached through this proxy, never exposed directly), so
// this process gates every /chat request itself with a code.
//
// Prefer a CHAT_ACCESS_CODE Space secret if one is set, so the code is
// stable across restarts — HF Spaces sleep after idle and redeploy on every
// push, and each restart used to mint a brand-new random code with no
// signal to the owner, silently invalidating whatever code they'd copied
// from an earlier log. Falls back to a random one (freshly printed to
// stdout every boot) when no secret is set.
const CHAT_ACCESS_CODE = process.env.CHAT_ACCESS_CODE || crypto.randomBytes(9).toString('base64url');
const CHAT_COOKIE = 'oc_auth';

console.log('════════════════════════════════════════════════════════════');
console.log(' OpenCode chat/API access code:');
console.log(' ' + CHAT_ACCESS_CODE);
if (process.env.CHAT_ACCESS_CODE) {
  console.log(' (from the CHAT_ACCESS_CODE secret — stable across restarts)');
} else {
  console.log(' (random — regenerates on every restart; set a CHAT_ACCESS_CODE');
  console.log(' Space secret to pick your own and stop it from changing)');
}
console.log('════════════════════════════════════════════════════════════');

// ─── Child processes ──────────────────────────────────────────────────────
const children = [];

function startChild(name, cmd, args, opts) {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    ...opts,
    env: { ...process.env, ...opts.env },
  });
  child.on('exit', (code, signal) => {
    console.error(`[${name}] exited (code=${code} signal=${signal}) — not restarting`);
  });
  children.push({ name, child });
  return child;
}

startChild('docs', 'npm', ['start'], {
  cwd: '/app/docs/collab',
  env: { PORT: '8080', HOST: '127.0.0.1', CASUAL_FILE_EXT: '.docx', TRUST_PROXY: 'true' },
});

startChild('slides', 'npm', ['start'], {
  cwd: '/app/slides/apps/server',
  env: { PORT: '3002', HOST: '127.0.0.1', STATIC_DIR: '/app/slides/apps/web/dist' },
});

// OpenAI-compatible provider, sourced from Space secrets. `{env:VAR}` is
// OpenCode's own config-time substitution syntax (applied to the raw config
// text before it's parsed) — passing it through literally here, rather than
// reading process.env ourselves, means a secret rotated in the Space
// settings takes effect on the next container restart without editing this
// file, and an unset secret degrades to an empty string instead of a crash.
const OPENCODE_CONFIG_CONTENT = JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  provider: {
    'openai-compatible': {
      npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: '{env:COMPATIBLE_URL}',
        apiKey: '{env:COMPATIBLE_API_KEY}',
      },
      models: {
        '{env:COMPATIBLE_MODEL}': {},
      },
    },
  },
  model: 'openai-compatible/{env:COMPATIBLE_MODEL}',
});

startChild('opencode', 'opencode', ['serve', '--hostname', '127.0.0.1', '--port', '4096'], {
  cwd: '/app',
  env: { OPENCODE_CONFIG_CONTENT },
});

// ─── Reverse proxy ─────────────────────────────────────────────────────────
const DOCS_TARGET = { host: '127.0.0.1', port: 8080 };
const SLIDES_TARGET = { host: '127.0.0.1', port: 3002 };
const CHAT_TARGET = { host: '127.0.0.1', port: 4096 };

const proxy = httpProxy.createProxyServer({ ws: true });
proxy.on('error', (err, req, res) => {
  console.error('proxy error:', err.message);
  if (res && !res.headersSent && typeof res.writeHead === 'function') {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad gateway — the backend for this route is still starting up. Try again shortly.');
  }
});

// Injects a collapsible OpenCode chat sidebar into any HTML page the Docs
// app serves (its own index.html, SPA-fallback pages, etc.) — Docs itself
// knows nothing about this; we splice it into the response in flight.
const SIDEBAR_HTML = `
<div id="__oc_tab" style="position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:2147483000;background:#111827;color:#fff;padding:10px 8px;border-radius:8px 0 0 8px;cursor:pointer;font:600 12px system-ui,sans-serif;writing-mode:vertical-rl;box-shadow:-2px 0 8px rgba(0,0,0,.2);">AI Chat</div>
<div id="__oc_panel" style="position:fixed;top:0;right:-420px;width:400px;height:100vh;z-index:2147483001;background:#0b0d12;box-shadow:-4px 0 16px rgba(0,0,0,.35);transition:right .2s ease;">
  <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#111827;color:#fff;font:600 13px system-ui,sans-serif;">
    <span>OpenCode</span>
    <span id="__oc_close" style="cursor:pointer;opacity:.7;padding:2px 6px;">✕</span>
  </div>
  <iframe id="__oc_iframe" src="/chat/" style="border:0;width:100%;height:calc(100% - 34px);background:#fff;"></iframe>
</div>
<script>
(function () {
  var tab = document.getElementById('__oc_tab');
  var panel = document.getElementById('__oc_panel');
  var close = document.getElementById('__oc_close');
  function open() { panel.style.right = '0'; }
  function shut() { panel.style.right = '-420px'; }
  tab.addEventListener('click', open);
  close.addEventListener('click', shut);
})();
</script>
`;

function injectSidebar(html) {
  const idx = html.lastIndexOf('</body>');
  if (idx === -1) return html;
  return html.slice(0, idx) + SIDEBAR_HTML + html.slice(idx);
}

// OpenCode's UI bundle has no concept of being mounted under a subpath: its
// HTML emits root-absolute asset tags (Vite's default `base: '/'`), and its
// JS resolves its own API/WS base URL as `location.origin` (no path) unless
// a `defaultServerUrl` override is sitting in localStorage before its entry
// module runs. Both are fixed here rather than upstream: rewrite absolute
// `src="/…"`/`href="/…"` tags to carry the `/chat` prefix our proxy expects,
// and inject a pre-boot script that points the app's own API client back at
// `/chat` (same trick self-hosted opencode.ai-style deployments would need).
function rewriteChatHtml(html) {
  const withPrefixedAssets = html.replace(/((?:src|href)=")\/(?!\/)/g, '$1/chat/');
  const bootScript =
    '<script>try{localStorage.setItem("opencode.settings.dat:defaultServerUrl",location.origin+"/chat")}catch(e){}</script>';
  const headIdx = withPrefixedAssets.indexOf('<head>');
  if (headIdx === -1) return bootScript + withPrefixedAssets;
  const insertAt = headIdx + '<head>'.length;
  return withPrefixedAssets.slice(0, insertAt) + bootScript + withPrefixedAssets.slice(insertAt);
}

proxy.on('proxyRes', (proxyRes, req, res) => {
  const mode = req.__rewriteMode;
  const contentType = proxyRes.headers['content-type'] || '';
  if (!mode || !contentType.includes('text/html')) {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
    return;
  }
  const chunks = [];
  proxyRes.on('data', (c) => chunks.push(c));
  proxyRes.on('end', () => {
    const html = Buffer.concat(chunks).toString('utf-8');
    const rewritten = mode === 'docs-sidebar' ? injectSidebar(html) : rewriteChatHtml(html);
    const body = Buffer.from(rewritten, 'utf-8');
    const headers = { ...proxyRes.headers, 'content-length': Buffer.byteLength(body) };
    res.writeHead(proxyRes.statusCode, headers);
    res.end(body);
  });
});

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function isChatAuthed(req) {
  return readCookie(req, CHAT_COOKIE) === CHAT_ACCESS_CODE;
}

// Same access code as the chat sidebar, but via `Authorization: Bearer …`
// instead of a cookie — for external MCP/API clients that can set a header
// but can't run the sidebar's browser login form.
function isApiAuthed(req) {
  const auth = req.headers.authorization || '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  return !!bearer && bearer[1].trim() === CHAT_ACCESS_CODE;
}

function chatGateHtml(error) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>OpenCode — locked</title>
<style>body{font:14px system-ui,sans-serif;background:#0b0d12;color:#e5e7eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{max-width:280px;text-align:center}input{width:100%;padding:8px;margin:12px 0;border-radius:6px;border:1px solid #333;background:#111827;color:#fff;box-sizing:border-box}
button{width:100%;padding:8px;border-radius:6px;border:0;background:#2563eb;color:#fff;cursor:pointer}
.err{color:#fff;background:#7f1d1d;border-radius:6px;padding:8px;font-size:13px;font-weight:600;margin-bottom:8px}</style></head>
<body><div class="box">
${error ? '<p class="err">✗ Incorrect code — that exact value was rejected.</p>' : ''}
<p>Enter the access code from the Space's <em>current</em> container logs (a restart mints a new one unless a CHAT_ACCESS_CODE secret is set).</p>
<form method="POST" action="/chat-auth">
<input name="code" autofocus placeholder="access code" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
<button type="submit">Unlock</button>
</form></div></body></html>`;
}

function stripPrefix(url, prefix) {
  if (url === prefix) return '/';
  if (url.startsWith(prefix + '/')) return url.slice(prefix.length) || '/';
  return null;
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }));
    return;
  }

  if (url === '/api-docs') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
    res.end(
      '<!doctype html><title>OpenUI Cowork</title>' +
        '<body style="font:14px system-ui,sans-serif;max-width:640px;margin:40px auto;line-height:1.6">' +
        '<h1>OpenUI Cowork</h1>' +
        '<p>Three open-source apps behind one proxy:</p>' +
        '<ul><li><code>/</code> — Casual Docs (.docx editor)</li>' +
        '<li><code>/slides/</code> — Casual Slides (.pptx editor)</li>' +
        '<li><code>/chat/</code> — OpenCode AI chat (browser sidebar, cookie-gated by an access code)</li>' +
        '<li><code>/api/</code> — same OpenCode backend for MCP/API clients — send <code>Authorization: Bearer &lt;access code&gt;</code></li></ul>' +
        '<p><code>/health</code> — liveness probe</p>' +
        '<p>The access code for both is printed to the container logs at startup.</p></body>',
    );
    return;
  }

  if (req.method === 'POST' && url === '/chat-auth') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const code = (params.get('code') || '').trim();
      if (code === CHAT_ACCESS_CODE) {
        res.writeHead(302, {
          'Set-Cookie': `${CHAT_COOKIE}=${encodeURIComponent(code)}; Path=/; HttpOnly; SameSite=Lax`,
          Location: '/chat/',
        });
        res.end();
      } else {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=UTF-8' });
        res.end(chatGateHtml(true));
      }
    });
    return;
  }

  if (url === '/chat' || url.startsWith('/chat/')) {
    if (!isChatAuthed(req)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
      res.end(chatGateHtml(false));
      return;
    }
    req.url = stripPrefix(url, '/chat');
    req.__rewriteMode = 'chat-subpath';
    proxy.web(req, res, { target: CHAT_TARGET, selfHandleResponse: true });
    return;
  }

  // Programmatic/MCP access to OpenCode's API — same backend and access
  // code as /chat, but header-authed instead of cookie-authed since a
  // non-browser client can't run the sidebar's login form. No HTML rewrite
  // here: this path is for JSON/API calls, not for rendering the chat UI.
  if (url === '/api' || url.startsWith('/api/')) {
    if (!isApiAuthed(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing or invalid Authorization: Bearer <access code>' }));
      return;
    }
    req.url = stripPrefix(url, '/api');
    proxy.web(req, res, { target: CHAT_TARGET, selfHandleResponse: true });
    return;
  }

  if (url === '/slides' || url.startsWith('/slides/')) {
    req.url = stripPrefix(url, '/slides');
    // selfHandleResponse: true on every route here — the shared `proxyRes`
    // listener below is the only thing allowed to write `res` (registering
    // it per-listener AND leaving http-proxy's own default auto-pipe active
    // for routes that skip the flag would double-write the response).
    proxy.web(req, res, { target: SLIDES_TARGET, selfHandleResponse: true });
    return;
  }

  // Everything else (including the SPA itself, /yjs REST, /r/:roomId, …)
  // goes to Docs at the root, with the sidebar spliced into HTML responses.
  req.__rewriteMode = 'docs-sidebar';
  proxy.web(req, res, { target: DOCS_TARGET, selfHandleResponse: true });
});

server.on('upgrade', (req, socket, head) => {
  const url = req.url || '/';
  if (url === '/chat' || url.startsWith('/chat/')) {
    if (!isChatAuthed(req)) {
      socket.destroy();
      return;
    }
    req.url = stripPrefix(url, '/chat');
    proxy.ws(req, socket, head, { target: CHAT_TARGET });
    return;
  }
  if (url === '/api' || url.startsWith('/api/')) {
    if (!isApiAuthed(req)) {
      socket.destroy();
      return;
    }
    req.url = stripPrefix(url, '/api');
    proxy.ws(req, socket, head, { target: CHAT_TARGET });
    return;
  }
  if (url === '/slides' || url.startsWith('/slides/')) {
    req.url = stripPrefix(url, '/slides');
    proxy.ws(req, socket, head, { target: SLIDES_TARGET });
    return;
  }
  // Docs' own /yjs collab socket, at the root.
  proxy.ws(req, socket, head, { target: DOCS_TARGET });
});

server.listen(PORT, () => {
  console.log(`OpenUI Cowork proxy listening on ${PORT}`);
});

process.on('SIGTERM', () => {
  for (const { child } of children) child.kill('SIGTERM');
  process.exit(0);
});
