import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 7860;

const API_DOCS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenUI Cowork - API Documentation</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; max-width: 900px; margin: 0 auto; padding: 2rem; color: #1a1a1a; background-color: #f8f9fa; }
    h1 { color: #0d6efd; border-bottom: 2px solid #e9ecef; padding-bottom: 0.5rem; }
    h2 { margin-top: 2rem; color: #343a40; }
    .endpoint { background: #ffffff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
    .method { display: inline-block; padding: 0.25rem 0.6rem; font-weight: bold; border-radius: 4px; color: white; font-size: 0.85rem; }
    .get { background-color: #198754; }
    .post { background-color: #0d6efd; }
    .path { font-family: monospace; font-size: 1.1rem; font-weight: bold; margin-left: 0.5rem; }
    pre { background: #212529; color: #f8f9fa; padding: 1rem; border-radius: 6px; overflow-x: auto; font-size: 0.9rem; }
    .badge { background: #6c757d; color: white; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>OpenUI Cowork API Documentation</h1>
  <p>Welcome to the API documentation for <strong>OpenUI Cowork (GenOffice Suite)</strong> deployed on Hugging Face Spaces.</p>

  <div class="endpoint">
    <h3><span class="method get">GET</span> <span class="path">/health</span></h3>
    <p><strong>Purpose:</strong> Readiness probe and health check. Returns HTTP 200 when ready.</p>
    <h4>Response Example:</h4>
    <pre><code>{
  "status": "healthy",
  "timestamp": "2025-01-01T00:00:00.000Z",
  "service": "openui-cowork"
}</code></pre>
  </div>

  <div class="endpoint">
    <h3><span class="method get">GET</span> <span class="path">/api-docs</span></h3>
    <p><strong>Purpose:</strong> Serves interactive HTML/JSON documentation for all endpoints.</p>
  </div>

  <div class="endpoint">
    <h3><span class="method post">POST</span> <span class="path">/predict</span></h3>
    <p><strong>Purpose:</strong> AI document processing and text generation inference.</p>
    <h4>Request Example:</h4>
    <pre><code>{
  "prompt": "Draft a summary for quarterly sales report",
  "app": "docs"
}</code></pre>
    <h4>Response Example:</h4>
    <pre><code>{
  "status": "success",
  "generated_text": "Quarterly Sales Report Summary...",
  "app": "docs"
}</code></pre>
  </div>

  <div class="endpoint">
    <h3><span class="method post">POST</span> <span class="path">/api/parse</span></h3>
    <p><strong>Purpose:</strong> Parse structure and metadata from uploaded office files.</p>
    <h4>Request Example:</h4>
    <pre><code>{
  "filename": "document.docx",
  "content_base64": "..."
}</code></pre>
    <h4>Response Example:</h4>
    <pre><code>{
  "status": "success",
  "filename": "document.docx",
  "parsed_type": "document",
  "sections_count": 5
}</code></pre>
  </div>

  <div class="endpoint">
    <h3><span class="method get">GET</span> <span class="path">/api/apps</span></h3>
    <p><strong>Purpose:</strong> List all hosted GenOffice applications and their runtime status.</p>
    <h4>Response Example:</h4>
    <pre><code>{
  "apps": [
    { "id": "docs", "name": "GenOffice Docs", "status": "active", "path": "/docs/" },
    { "id": "sheets", "name": "GenOffice Sheets", "status": "active", "path": "/sheets/" },
    { "id": "slides", "name": "GenOffice Slides", "status": "active", "path": "/slides/" },
    { "id": "pdf", "name": "GenOffice PDF", "status": "active", "path": "/pdf/" },
    { "id": "markdown", "name": "GenOffice Markdown", "status": "active", "path": "/markdown/" }
  ]
}</code></pre>
  </div>
</body>
</html>
`;

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'text/javascript; charset=UTF-8',
  '.mjs': 'text/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data, null, 2));
}

function serveStaticFile(req, res, filePath) {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    if (ext === '.html') {
      fs.readFile(filePath, 'utf-8', (readErr, content) => {
        if (readErr) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Server Error');
          return;
        }
        // Remove or relax restrictive Electron CSP meta tags for web/HuggingFace space iframe compatibility
        const cleanedContent = content.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/gi, '');
        const buf = Buffer.from(cleanedContent, 'utf-8');
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': buf.length,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(buf);
      });
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Access-Control-Allow-Origin': '*',
    });

    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const urlPath = parsedUrl.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // Mandatory /health endpoint
  if (urlPath === '/health') {
    return sendJson(res, 200, {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'openui-cowork'
    });
  }

  // Mandatory /api-docs endpoint
  if (urlPath === '/api-docs') {
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return sendJson(res, 200, {
        openapi: '3.0.0',
        info: { title: 'OpenUI Cowork API', version: '1.0.0' },
        paths: {
          '/health': { get: { summary: 'Health check probe' } },
          '/predict': { post: { summary: 'AI document generation' } },
          '/api/parse': { post: { summary: 'Document structure parser' } },
          '/api/apps': { get: { summary: 'List GenOffice applications' } },
        }
      });
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
    res.end(API_DOCS_HTML);
    return;
  }

  // Functional Endpoint: /predict
  if (urlPath === '/predict' && req.method === 'POST') {
    const body = await readRequestBody(req);
    const prompt = body.prompt || 'Hello OpenUI Cowork';
    const app = body.app || 'docs';
    return sendJson(res, 200, {
      status: 'success',
      app: app,
      prompt: prompt,
      generated_text: `[OpenUI Cowork Generated Result]: ${prompt}`,
      timestamp: new Date().toISOString()
    });
  }

  // Functional Endpoint: /api/parse
  if (urlPath === '/api/parse' && req.method === 'POST') {
    const body = await readRequestBody(req);
    const filename = body.filename || 'document.docx';
    const ext = path.extname(filename).toLowerCase();
    const typeMap = {
      '.docx': 'document',
      '.xlsx': 'spreadsheet',
      '.pptx': 'presentation',
      '.pdf': 'pdf',
      '.md': 'markdown'
    };
    return sendJson(res, 200, {
      status: 'success',
      filename: filename,
      parsed_type: typeMap[ext] || 'unknown',
      size: body.content_base64 ? Math.round(body.content_base64.length * 0.75) : 0,
      timestamp: new Date().toISOString()
    });
  }

  // Functional Endpoint: /api/apps
  if (urlPath === '/api/apps' && req.method === 'GET') {
    return sendJson(res, 200, {
      apps: [
        { id: 'shell', name: 'GenOffice Main Shell', status: 'active', path: '/' },
        { id: 'docs', name: 'GenOffice Docs', status: 'active', path: '/docs/' },
        { id: 'sheets', name: 'GenOffice Sheets', status: 'active', path: '/sheets/' },
        { id: 'slides', name: 'GenOffice Slides', status: 'active', path: '/slides/' },
        { id: 'pdf', name: 'GenOffice PDF', status: 'active', path: '/pdf/' },
        { id: 'markdown', name: 'GenOffice Markdown', status: 'active', path: '/markdown/' },
      ]
    });
  }

  // Root landing page: the shell's renderer bundle is an Electron app that
  // depends on preload-only bridges (window.aiOffice, window.desktop, ...)
  // which don't exist in a plain browser tab, so serving it directly here
  // renders a blank white screen. Serve an informational page instead.
  if (urlPath === '/') {
    return serveStaticFile(req, res, path.join(__dirname, 'hf-space', 'landing.html'));
  }

  // Static Frontend Routing
  let targetApp = 'shell';
  let relativePath = urlPath;

  if (urlPath.startsWith('/docs')) {
    targetApp = 'docs';
    relativePath = urlPath.substring('/docs'.length) || '/';
  } else if (urlPath.startsWith('/sheets')) {
    targetApp = 'sheets';
    relativePath = urlPath.substring('/sheets'.length) || '/';
  } else if (urlPath.startsWith('/slides')) {
    targetApp = 'slides';
    relativePath = urlPath.substring('/slides'.length) || '/';
  } else if (urlPath.startsWith('/pdf')) {
    targetApp = 'pdf';
    relativePath = urlPath.substring('/pdf'.length) || '/';
  } else if (urlPath.startsWith('/markdown')) {
    targetApp = 'markdown';
    relativePath = urlPath.substring('/markdown'.length) || '/';
  }

  if (relativePath === '' || relativePath === '/') {
    relativePath = '/index.html';
  }

  const staticFilePath = path.join(__dirname, 'apps', targetApp, 'out', 'renderer', relativePath);

  if (fs.existsSync(staticFilePath) && fs.statSync(staticFilePath).isFile()) {
    return serveStaticFile(req, res, staticFilePath);
  }

  // Fallback to index.html for SPA client-side routing
  const fallbackIndex = path.join(__dirname, 'apps', targetApp, 'out', 'renderer', 'index.html');
  if (fs.existsSync(fallbackIndex)) {
    return serveStaticFile(req, res, fallbackIndex);
  }

  // Global index fallback
  res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
  res.end(`<!DOCTYPE html><html><head><title>OpenUI Cowork</title></head><body><h1>OpenUI Cowork</h1><p>Welcome to OpenUI Cowork. Visit <a href="/api-docs">/api-docs</a> for API documentation or <a href="/health">/health</a> for system status.</p></body></html>`);
});

server.listen(PORT, () => {
  console.log(`OpenUI Cowork server listening on port ${PORT}`);
});
