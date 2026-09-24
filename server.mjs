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
  <div id="__oc_status" style="position:absolute;top:34px;left:0;right:0;bottom:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#9ca3af;font:13px system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box;background:#0b0d12;">
    <span>Loading chat…</span>
    <a href="/chat/" target="_blank" rel="noopener" style="display:none;color:#60a5fa;">Taking a while — open chat in a new tab</a>
  </div>
  <iframe id="__oc_iframe" src="/chat/" style="border:0;width:100%;height:calc(100% - 34px);background:#fff;"></iframe>
</div>
<script>
(function () {
  var tab = document.getElementById('__oc_tab');
  var panel = document.getElementById('__oc_panel');
  var close = document.getElementById('__oc_close');
  var iframe = document.getElementById('__oc_iframe');
  var status = document.getElementById('__oc_status');
  var fallbackLink = status.querySelector('a');
  var loaded = false;
  var opened = false;
  function markLoaded() {
    if (loaded) return;
    loaded = true;
    status.style.display = 'none';
  }
  function open() {
    panel.style.right = '0';
    if (!opened) {
      opened = true;
      setTimeout(function () {
        if (!loaded) fallbackLink.style.display = 'inline';
      }, 4000);
    }
  }
  function shut() { panel.style.right = '-420px'; }
  iframe.addEventListener('load', markLoaded);
  iframe.addEventListener('error', function () {
    status.querySelector('span').textContent = 'Chat failed to load.';
    fallbackLink.style.display = 'inline';
  });
  // The iframe starts navigating as soon as its src attribute is parsed —
  // before this script runs and attaches the 'load' listener above — so a
  // fast-loading document (the gate page is ~1KB) can finish and fire 'load'
  // before anyone is listening, leaving the status overlay stuck forever.
  // Same-origin, so contentDocument is readable: catch that race directly.
  try {
    if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') markLoaded();
  } catch (e) {}
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
// HTML emits root-absolute asset tags (Vite's default `base: '/'`). Rewrite
// them to carry the `/chat` prefix our proxy expects — the initial document
// and its script/link tags are the one place OpenCode's own path handling
// actually respects a prefix, since the browser fetches whatever literal
// URL the tag names.
//
// Its *runtime* API/WS calls are a different story: they're always built as
// `new URL(path, baseURL)` with a leading slash on `path`, which per the URL
// spec discards any path segment in baseURL and resolves against the bare
// origin — so no `defaultServerUrl` override in localStorage can make it
// call `/chat/api/...` instead of `/api/...` (tried; it instead broke
// OpenCode's own server-identity matching with an unrelated "Permission
// server not found" error). classifyRootPath()'s routing is what actually
// gets those calls to OpenCode correctly.
// A prior version of this proxy briefly wrote a *wrong* override into this
// same key (an earlier attempt at making OpenCode subpath-aware — reverted,
// see the comment above rewriteChatHtml). Any browser that loaded /chat
// during that window has the bad value stuck in localStorage indefinitely:
// it survives page refreshes and even hard-refreshes, since those clear
// cache/cookies but not localStorage. The app then keeps building its own
// client-side "server" identity around that stale URL — visible in the
// address bar as /server/<base64 of the stale URL>/session/... — and
// requests silently go nowhere. Since we can't reach into a visitor's
// browser to fix it, this scrubs the key back to unset (its correct,
// working default) on every /chat load, self-healing anyone still carrying
// the bad value forward without them needing to clear site data by hand.
const CHAT_CLEANUP_SCRIPT_BODY =
  'try{var k="opencode.settings.dat:defaultServerUrl";if(localStorage.getItem(k))localStorage.removeItem(k)}catch(e){}';
const CHAT_CLEANUP_SCRIPT_HASH = crypto.createHash('sha256').update(CHAT_CLEANUP_SCRIPT_BODY).digest('base64');

function rewriteChatHtml(html) {
  const withPrefixedAssets = html.replace(/((?:src|href)=")\/(?!\/)/g, '$1/chat/');
  const cleanupScript = `<script>${CHAT_CLEANUP_SCRIPT_BODY}</script>`;
  const headIdx = withPrefixedAssets.indexOf('<head>');
  if (headIdx === -1) return cleanupScript + withPrefixedAssets;
  const insertAt = headIdx + '<head>'.length;
  return withPrefixedAssets.slice(0, insertAt) + cleanupScript + withPrefixedAssets.slice(insertAt);
}

function allowCleanupScriptInCsp(csp) {
  if (!csp) return csp;
  const hashToken = `'sha256-${CHAT_CLEANUP_SCRIPT_HASH}'`;
  if (csp.includes(hashToken)) return csp;
  return csp.replace(/script-src([^;]*)/, (m, rest) => `script-src${rest} ${hashToken}`);
}

// Beyond its HTML tags, OpenCode's own bundled JS carries several hardcoded
// root-absolute asset paths — `new Worker("/assets/markdown.worker-*.js")`
// for its markdown/syntax-highlighting worker, plus onboarding images and
// icon sprites — that Vite emitted as plain string literals rather than
// import.meta.url-relative references. Those never go through the HTML tag
// rewrite above (they're not in a tag, they're inside already-loaded JS),
// so at runtime the browser requests them at bare root, our proxy routes
// bare /assets/* to Docs (Docs has its own /assets/ tree), and the request
// 404s — which is exactly what silently broke the worker and produced the
// "Js.onerror" crash reported for the deployed build. Rewrite the same way,
// just scoped to JS files instead of HTML tags.
function rewriteChatJs(js) {
  return js.replace(/"\/assets\//g, '"/chat/assets/');
}

proxy.on('proxyRes', (proxyRes, req, res) => {
  const mode = req.__rewriteMode;
  const contentType = proxyRes.headers['content-type'] || '';
  const isHtml = contentType.includes('text/html');
  const isChatJs = mode === 'chat-subpath' && /(?:java|ecma)script/i.test(contentType);
  if (!mode || (!isHtml && !isChatJs)) {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
    return;
  }
  const chunks = [];
  proxyRes.on('data', (c) => chunks.push(c));
  proxyRes.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf-8');
    const rewritten =
      mode === 'docs-sidebar' ? injectSidebar(text) : isChatJs ? rewriteChatJs(text) : rewriteChatHtml(text);
    const body = Buffer.from(rewritten, 'utf-8');
    const headers = { ...proxyRes.headers, 'content-length': Buffer.byteLength(body) };
    if (mode === 'chat-subpath' && headers['content-security-policy']) {
      headers['content-security-policy'] = allowCleanupScriptInCsp(headers['content-security-policy']);
    }
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

function isEitherAuthed(req) {
  return isChatAuthed(req) || isApiAuthed(req);
}

// OpenCode's client always builds request URLs as `new URL(path, baseURL)`
// with a leading slash on `path` — per the URL spec that discards ANY path
// segment already in baseURL and resolves against the bare origin. No
// localStorage/config override can make it call `/chat/api/...` instead of
// `/api/...`. Its real surface turned out to be dozens of bare top-level
// names with no shared prefix (/path, /vcs, /find, /log, /session, /project,
// /provider, /pty, /question, /sync, /tui, /config, /permission, /mcp,
// /global/*, /experimental/*, even /auth/:providerID) — an allowlist of
// OpenCode's paths is a moving target. Docs' own surface is the opposite:
// small, fixed, fully read from its source. So the default flips here:
// anything NOT explicitly Docs' own goes to OpenCode at root (auth-checked
// the same as /chat, since this bypasses that route entirely).
const DOCS_EXACT_PATHS = new Set([
  '/',
  '/home',
  '/embed',
  '/yjs',
  '/favicon.svg',
  '/logo.svg',
  '/og.png',
  '/robots.txt',
  '/sitemap.xml',
  '/llms.txt',
  '/404.html',
  '/auth/signup',
  '/auth/login',
  '/auth/logout',
  '/auth/me',
  '/auth/status',
  '/auth/change-password',
  '/auth/delete-account',
]);
const DOCS_PREFIXES = [
  '/document/',
  '/r/',
  '/assets/',
  '/fonts/',
  '/templates/',
  '/api/rooms',
  '/api/admin',
  '/api/me',
  '/api/files',
  '/api/tokens',
  '/api/mcp-proxy',
  '/files/',
  '/wopi/',
  '/auth/profile',
];
// Demo/fixture files Docs serves at its root (e.g. sample .docx templates) —
// caught by extension rather than by name, since the exact set can change
// with the build.
const DOCS_STATIC_EXTENSIONS = /\.(docx|svg|png|jpg|jpeg|ico|txt|xml|woff2?|css|js)$/i;

function isDocsOwnPath(path) {
  if (DOCS_EXACT_PATHS.has(path)) return true;
  if (DOCS_PREFIXES.some((p) => path.startsWith(p))) return true;
  if (DOCS_STATIC_EXTENSIONS.test(path)) return true;
  return false;
}

function classifyRootPath(url) {
  const path = url.split('?')[0];
  return isDocsOwnPath(path) ? 'docs' : 'opencode';
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

// OpenCode's own client sends a `directory` / `location[directory]` query
// param on several endpoints (/session, /session/status, /api/reference)
// that, reproduced locally against the exact same bundle build, is garbled
// — a control byte followed by a UTF-8 replacement character — regardless
// of the actual project directory or working-directory name. Most of those
// endpoints tolerate it and return 200 anyway, but /api/reference 500s on
// it, and that error appears to cascade into aborting the in-flight
// send-message request (the same "one failure kills unrelated pending
// requests" pattern behind the earlier markdown-worker crash) — the
// concrete cause of a message showing "thinking" and then never producing
// a reply. This is an upstream OpenCode bug, not something wrong with our
// proxying, so patch it at the edge: drop a garbled directory param before
// forwarding and let OpenCode fall back to its own default.
function sanitizeDirectoryQuery(url) {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return url;
  const path = url.slice(0, qIdx);
  const params = new URLSearchParams(url.slice(qIdx + 1));
  let changed = false;
  for (const key of ['directory', 'location[directory]']) {
    const val = params.get(key);
    if (val && /[\u0000-\u001f�]/.test(val)) {
      params.delete(key);
      changed = true;
    }
  }
  if (!changed) return url;
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
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
        '<li><code>/mcp-api/</code> — same OpenCode backend for MCP/API clients — send <code>Authorization: Bearer &lt;access code&gt;</code></li></ul>' +
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
    req.url = sanitizeDirectoryQuery(stripPrefix(url, '/chat'));
    req.__rewriteMode = 'chat-subpath';
    proxy.web(req, res, { target: CHAT_TARGET, selfHandleResponse: true });
    return;
  }

  // Programmatic/MCP access to OpenCode's API — same backend and access
  // code as /chat, but header-authed instead of cookie-authed since a
  // non-browser client can't run the sidebar's login form. No HTML rewrite
  // here: this path is for JSON/API calls, not for rendering the chat UI.
  //
  // Mounted at /mcp-api, NOT /api: OpenCode's own client hardcodes "/api" as
  // its internal protocol-version probe path (GET /api/health) — reusing
  // that prefix for this route intercepted OpenCode's own same-origin calls
  // (which can't carry our bearer header) and 401'd the chat UI into an
  // infinite retry loop.
  if (url === '/mcp-api' || url.startsWith('/mcp-api/')) {
    if (!isApiAuthed(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing or invalid Authorization: Bearer <access code>' }));
      return;
    }
    req.url = sanitizeDirectoryQuery(stripPrefix(url, '/mcp-api'));
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

  // OpenCode's own root-absolute API calls (see classifyRootPath above) —
  // gated the same as /chat since this bypasses that route entirely.
  if (classifyRootPath(url) === 'opencode') {
    if (!isEitherAuthed(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not authenticated — unlock the chat sidebar first' }));
      return;
    }
    req.url = sanitizeDirectoryQuery(url);
    proxy.web(req, res, { target: CHAT_TARGET, selfHandleResponse: true });
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
  if (url === '/mcp-api' || url.startsWith('/mcp-api/')) {
    if (!isApiAuthed(req)) {
      socket.destroy();
      return;
    }
    req.url = stripPrefix(url, '/mcp-api');
    proxy.ws(req, socket, head, { target: CHAT_TARGET });
    return;
  }
  if (url === '/slides' || url.startsWith('/slides/')) {
    req.url = stripPrefix(url, '/slides');
    proxy.ws(req, socket, head, { target: SLIDES_TARGET });
    return;
  }
  if (classifyRootPath(url) === 'opencode') {
    if (!isEitherAuthed(req)) {
      socket.destroy();
      return;
    }
    proxy.ws(req, socket, head, { target: CHAT_TARGET });
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
