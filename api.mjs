// api.mjs — the /api/v1 REST surface for OpenUI Cowork: health, info,
// workspaces, plus the OpenAPI and cws discovery documents that describe it.
//
// Scope note: this proxy fronts two vendored, independently-developed apps
// (Casual Docs, Casual Slides), each with its own storage/auth model that
// lives in a separate upstream repo this deployment doesn't own or modify.
// Rather than guessing at (or reimplementing) their internal file/document
// APIs, "workspace" here maps to the one real, stable concept this proxy
// actually owns: which app is mounted where. Each app already exposes its
// own native REST surface directly through the proxy (e.g. Docs' own
// `/api/files`, `/api/rooms`) — this module does not wrap or duplicate that,
// since faithfully mirroring it would require the same guarantees as the
// upstream apps for endpoints this file's tests can't verify against real
// backends.
//
// Pure request handling, no dependency on the proxy/child-process machinery
// in server.mjs, so it can be unit- and integration-tested in isolation.

export const API_VERSION = 'v1'

// `nativeApiBase` records only what's already grounded in this proxy's own
// routing: Docs' own backend serves a REST-ish surface under `/api` at its
// mount (rooms, files, admin, me, tokens, mcp-proxy — all reachable through
// this proxy already). Slides' equivalent hasn't been audited, so it stays
// `null` rather than a guess.
//
// `documentCapabilities` is populated ONLY for what's actually been audited
// and wired up to a real backend operation (docsAdapter.mjs) — see
// docs/hf-space-docs-api-audit.md for the full audit against
// collab@9b2a9a2d4928358efa0d298d14a601915df6a724 (the pinned commit this
// deployment actually runs). Notably absent: any write capability — see
// docsAdapter.mjs's module comment for the specific upstream gap that makes
// "write a document's content" unsafe to advertise as a stable capability
// today. Slides has not been audited in this pass (out of scope — see
// project instructions), so it stays `[]`.
//
// Capability strings use the same `resource_method` spelling as the
// matching OpenAPI `operationId` (see buildOpenApiDocument) — e.g.
// "documents_get" here always means the `documents_get` operation — so a
// `cws` client can go from one to the other without a lookup table. That
// convention is dictated by the actual `cws` OpenAPI adapter (it splits an
// operationId on its LAST underscore into resource + single-word method;
// see the `cws` compatibility notes in api.test.mjs), not chosen freely.
export const WORKSPACES = [
  {
    id: 'docs',
    title: 'Casual Docs',
    kind: 'docx',
    mount: '/',
    description: 'Browser .docx editor with real-time co-editing.',
    nativeApiBase: '/api',
    documentCapabilities: ['documents_create', 'documents_get', 'documents_download'],
  },
  {
    id: 'slides',
    title: 'Casual Slides',
    kind: 'pptx',
    mount: '/slides',
    description: 'Browser .pptx editor.',
    nativeApiBase: null,
    documentCapabilities: [],
  },
]

// Top-level capabilities this deployment's OWN /api/v1 implements (as
// opposed to a workspace's documentCapabilities, which describe what's
// wired up for that specific app). Derived, not hand-maintained, so it
// can't drift from WORKSPACES.
const CAPABILITIES = [
  'workspaces',
  ...(WORKSPACES.some((w) => w.documentCapabilities.length > 0) ? ['documents'] : []),
]

export function findWorkspace(id) {
  return WORKSPACES.find((w) => w.id === id) || null
}

// Public `Workspace` DTO — only the fields declared in the OpenAPI schema.
// WORKSPACES carries internal bookkeeping (nativeApiBase, documentCapabilities)
// that belongs in toDiscoveryService/toServiceMetadata below, not here.
function toPublicWorkspace(ws) {
  return { id: ws.id, title: ws.title, kind: ws.kind, mount: ws.mount, description: ws.description }
}

// Discovery-document view of a workspace: how a client reaches the app
// itself, not how it authenticates or what it can do there.
function toDiscoveryService(ws) {
  return {
    id: ws.id,
    type: 'app',
    base_url: ws.mount,
    native_api: ws.nativeApiBase,
  }
}

// `/api/v1/workspaces/{id}/service` view: factual integration metadata
// only. `capabilities` lists only audited, wired-up operations (see
// WORKSPACES' documentCapabilities above). `openapi` stays `null` for every
// workspace: these operations are documented in THIS deployment's own
// top-level /openapi.json (under /workspaces/{id}/documents...), not in a
// separate per-app schema Docs or Slides publish themselves — neither app
// generates its own OpenAPI document today (see the audit doc).
function toServiceMetadata(ws) {
  return {
    id: ws.id,
    base_path: ws.mount,
    api_base: ws.nativeApiBase,
    openapi: null,
    capabilities: ws.documentCapabilities,
  }
}

export function apiError(res, status, code, message, details = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { code, message, details } }))
}

export function apiJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

// `token === null` means auth is explicitly disabled (local dev only — see
// COWORK_API_AUTH_DISABLED in server.mjs). Any other value must be matched
// exactly by the request's bearer token.
export function checkBearerAuth(req, token) {
  if (token === null) return true
  const auth = req.headers.authorization || ''
  const match = auth.match(/^Bearer\s+(.+)$/i)
  return !!match && match[1].trim() === token
}

export function buildDiscoveryDocument() {
  return {
    name: 'cowork',
    title: 'OpenUI Cowork',
    version: API_VERSION,
    api_version: API_VERSION,
    base_url: '/api/v1',
    schema: '/openapi.json',
    schema_type: 'openapi',
    auth: { type: 'bearer' },
    capabilities: CAPABILITIES,
    services: WORKSPACES.map(toDiscoveryService),
  }
}

// Path keys below are given in FULL from root (`/api/v1/...`), not
// relative to a `servers[].url` prefix, even though OpenAPI would normally
// let `servers: [{ url: '/api/v1' }]` carry that prefix. This is dictated
// by the real `cws` OpenAPI adapter (JsonLord/cli, src/discovery.rs
// build_url / src/openapi.rs convert_openapi_to_rest_description): when a
// service has a configured `base_url` — true for every self-hosted service,
// including the built-in "cowork" entry — the adapter uses that base_url
// verbatim as the request root and ignores this document's `servers[].url`
// entirely. A `servers: [{ url: '/api/v1' }]` + short paths document (this
// project's previous shape) resolved to `<base_url>/workspaces` instead of
// `<base_url>/api/v1/workspaces` — a live 404 confirmed against a real
// compiled `cws` build. `servers: [{ url: '/' }]` here is accurate (this
// API really is served from the deployment root) and paths carry the
// `/api/v1` prefix explicitly so the resolved URL is correct regardless.
export function buildOpenApiDocument() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'OpenUI Cowork API',
      version: API_VERSION,
      description:
        'Machine-readable API over the OpenUI Cowork deployment: which document/slide apps are mounted, ' +
        'and service liveness. Each app also exposes its own native REST surface directly through this ' +
        'proxy (see each workspace\'s "mount") for capabilities not yet unified here.',
    },
    servers: [{ url: '/' }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/api/v1/health': {
        get: {
          operationId: 'health_check',
          summary: 'Liveness probe',
          description: 'Returns service status without touching any backend app. Unauthenticated.',
          security: [],
          responses: {
            200: {
              description: 'Service is up',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/HealthStatus' } },
              },
            },
          },
        },
      },
      '/api/v1/info': {
        get: {
          operationId: 'info_get',
          summary: 'Deployment metadata and capabilities',
          description:
            'Describes enabled capabilities and mounted workspaces. Requires authentication.',
          responses: {
            200: {
              description: 'Deployment info',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Info' } } },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/api/v1/workspaces': {
        get: {
          operationId: 'workspaces_list',
          summary: 'List workspaces',
          description:
            'Each workspace is one of the apps mounted behind this proxy (Casual Docs, Casual Slides).',
          responses: {
            200: {
              description: 'Workspace list',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/WorkspaceList' } },
              },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/api/v1/workspaces/{workspace_id}': {
        get: {
          operationId: 'workspaces_get',
          summary: 'Get a workspace by ID',
          parameters: [
            {
              name: 'workspace_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace ID, e.g. "docs" or "slides".',
            },
          ],
          responses: {
            200: {
              description: 'Workspace',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Workspace' } },
              },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
            404: { $ref: '#/components/responses/NotFound' },
          },
        },
      },
      '/api/v1/workspaces/{workspace_id}/service': {
        get: {
          operationId: 'workspaces_service',
          summary: "Get integration metadata for a workspace's underlying app",
          description:
            'Factual integration metadata for the app backing this workspace: where its own ' +
            'native API lives, whether it publishes its own OpenAPI schema, and which ' +
            'capabilities have been audited and exposed so far. `openapi` and `capabilities` ' +
            'are empty until that app has been audited in a later pass — this endpoint never ' +
            'reports a capability the app has not actually been confirmed to support.',
          parameters: [
            {
              name: 'workspace_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace ID, e.g. "docs" or "slides".',
            },
          ],
          responses: {
            200: {
              description: 'Service integration metadata',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/WorkspaceService' } },
              },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
            404: { $ref: '#/components/responses/NotFound' },
          },
        },
      },
      '/api/v1/workspaces/{workspace_id}/documents': {
        post: {
          operationId: 'documents_create',
          summary: 'Create a document in a workspace',
          description:
            'Currently implemented for the "docs" workspace only, backed by Casual Docs\' own ' +
            'room creation. A document with a password can only be read back with that same ' +
            'password (see documents_download) — see docs/hf-space-docs-api-audit.md for ' +
            'why writing content is not yet exposed here.',
          parameters: [
            {
              name: 'workspace_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace ID. Only "docs" supports this operation today.',
            },
          ],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DocumentCreateRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Document created',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Document' } },
              },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
            404: { $ref: '#/components/responses/NotFound' },
            503: { $ref: '#/components/responses/ApiErrorResponse' },
          },
        },
      },
      '/api/v1/workspaces/{workspace_id}/documents/{document_id}': {
        get: {
          operationId: 'documents_get',
          summary: "Get a document's metadata",
          description: 'Currently implemented for the "docs" workspace only.',
          parameters: [
            {
              name: 'workspace_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace ID. Only "docs" supports this operation today.',
            },
            {
              name: 'document_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Document ID, as returned by documents_create.',
            },
          ],
          responses: {
            200: {
              description: 'Document metadata',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Document' } },
              },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
            404: { $ref: '#/components/responses/NotFound' },
          },
        },
      },
      '/api/v1/workspaces/{workspace_id}/documents/{document_id}/content': {
        get: {
          operationId: 'documents_download',
          summary: "Download a document's original content",
          description:
            "Returns the document's *original* uploaded content, not its live collaboratively-" +
            "edited state — Casual Docs has no HTTP endpoint for a room's current content; live " +
            'edits only exist as CRDT updates over its WebSocket. A document with edits since ' +
            'creation will not reflect them here. Currently implemented for the "docs" workspace ' +
            'only. See docs/hf-space-docs-api-audit.md.',
          parameters: [
            {
              name: 'workspace_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace ID. Only "docs" supports this operation today.',
            },
            {
              name: 'document_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Document ID, as returned by documents_create.',
            },
            {
              name: 'password',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description:
                'Required when documents_get reports needs_password: true for this document.',
            },
          ],
          responses: {
            200: {
              description: 'Document content bytes',
              content: {
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
                  schema: { type: 'string', format: 'binary' },
                },
              },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
            404: { $ref: '#/components/responses/NotFound' },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
      schemas: {
        HealthStatus: {
          type: 'object',
          required: ['status', 'service', 'api_version'],
          properties: {
            status: { type: 'string', example: 'ok' },
            service: { type: 'string', example: 'cowork' },
            api_version: { type: 'string', example: API_VERSION },
          },
        },
        Info: {
          type: 'object',
          properties: {
            service: { type: 'string' },
            api_version: { type: 'string' },
            capabilities: { type: 'array', items: { type: 'string' } },
            workspaces: { type: 'array', items: { $ref: '#/components/schemas/Workspace' } },
          },
        },
        Workspace: {
          type: 'object',
          required: ['id', 'title', 'kind', 'mount'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            kind: { type: 'string' },
            mount: { type: 'string' },
            description: { type: 'string' },
          },
        },
        WorkspaceList: {
          type: 'object',
          required: ['items'],
          properties: {
            items: { type: 'array', items: { $ref: '#/components/schemas/Workspace' } },
            nextPageToken: { type: 'string', nullable: true },
          },
        },
        WorkspaceService: {
          type: 'object',
          required: ['id', 'base_path', 'capabilities'],
          properties: {
            id: { type: 'string' },
            base_path: {
              type: 'string',
              description: 'Where the app itself is mounted behind this proxy.',
            },
            api_base: {
              type: 'string',
              nullable: true,
              description: "Where the app's own native API lives, if known and audited.",
            },
            openapi: {
              type: 'string',
              nullable: true,
              description: "Path to this app's own OpenAPI schema, once published.",
            },
            capabilities: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Audited, exposed capabilities of this app\'s native API, e.g. "documents_get".',
            },
          },
        },
        ApiError: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                details: { type: 'object' },
              },
            },
          },
        },
        DocumentCreateRequest: {
          type: 'object',
          properties: {
            password: {
              type: 'string',
              description: 'Optional. If set, documents_download requires this same password.',
            },
          },
        },
        Document: {
          type: 'object',
          required: ['id', 'needs_password'],
          properties: {
            id: { type: 'string' },
            needs_password: { type: 'boolean' },
            has_initial_content: {
              type: 'boolean',
              description: 'Whether content has ever been uploaded for this document.',
            },
            has_snapshot: { type: 'boolean' },
            active_clients: { type: 'integer' },
          },
        },
      },
      responses: {
        Unauthorized: {
          description: 'Missing or invalid bearer token',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        NotFound: {
          description: 'Resource not found',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        ApiErrorResponse: {
          description: 'Structured error',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      },
    },
  }
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
  })
}

// Maps a docsAdapter.mjs result (see its module comment) onto the HTTP
// response. `mapOk` turns a successful result into the response body/status.
function sendAdapterResult(res, result, mapOk) {
  if (result.unavailable) {
    apiError(res, 502, 'docs_unavailable', 'Could not reach the Docs backend.')
    return
  }
  if (result.error) {
    apiError(res, result.status, result.error.code, result.error.message)
    return
  }
  mapOk(result)
}

// Handles /api/v1/*, /openapi.json and /.well-known/cws.json. Returns true
// if it fully handled the request (synchronously, or asynchronously via a
// promise this function does not await — the caller doesn't need to wait
// for it), false if the caller should fall through to the app proxy
// routes. `token` is the expected bearer token, or `null` to disable auth
// entirely (see checkBearerAuth). `deps.docsAdapter` (docsAdapter.mjs) is
// required for the "docs" workspace's documents.* operations; other
// workspaces don't support them regardless of `deps`.
export function handleApiRequest(req, res, url, token, deps = {}) {
  const path = url.split('?')[0]

  if (path === '/openapi.json') {
    apiJson(res, 200, buildOpenApiDocument())
    return true
  }

  if (path === '/.well-known/cws.json') {
    apiJson(res, 200, buildDiscoveryDocument())
    return true
  }

  if (!path.startsWith('/api/v1/') && path !== '/api/v1') return false

  if (path === '/api/v1/health') {
    apiJson(res, 200, { status: 'ok', service: 'cowork', api_version: API_VERSION })
    return true
  }

  if (!checkBearerAuth(req, token)) {
    apiError(res, 401, 'unauthorized', 'Missing or invalid Authorization: Bearer <token>.')
    return true
  }

  if (path === '/api/v1/info') {
    apiJson(res, 200, {
      service: 'cowork',
      api_version: API_VERSION,
      capabilities: CAPABILITIES,
      workspaces: WORKSPACES.map(toPublicWorkspace),
    })
    return true
  }

  if (path === '/api/v1/workspaces') {
    apiJson(res, 200, { items: WORKSPACES.map(toPublicWorkspace), nextPageToken: null })
    return true
  }

  const serviceMatch = path.match(/^\/api\/v1\/workspaces\/([^/]+)\/service$/)
  if (serviceMatch) {
    const id = decodeURIComponent(serviceMatch[1])
    const ws = findWorkspace(id)
    if (!ws) {
      apiError(res, 404, 'workspace_not_found', 'Workspace not found.', { workspace_id: id })
    } else {
      apiJson(res, 200, toServiceMetadata(ws))
    }
    return true
  }

  const contentMatch = path.match(/^\/api\/v1\/workspaces\/([^/]+)\/documents\/([^/]+)\/content$/)
  if (contentMatch) {
    const [, workspaceId, documentId] = contentMatch.map(decodeURIComponent)
    if (req.method !== 'GET') {
      apiError(res, 405, 'method_not_allowed', 'Only GET is supported here.')
      return true
    }
    const ws = findWorkspace(workspaceId)
    if (!ws) {
      apiError(res, 404, 'workspace_not_found', 'Workspace not found.', {
        workspace_id: workspaceId,
      })
      return true
    }
    if (!ws.documentCapabilities.includes('documents_download') || !deps.docsAdapter) {
      apiError(
        res,
        404,
        'capability_not_available',
        'documents_download is not implemented for this workspace.',
        {
          workspace_id: workspaceId,
        },
      )
      return true
    }
    const password = new URL(url, 'http://internal').searchParams.get('password') || undefined
    deps.docsAdapter
      .getDocumentContent(documentId, { password })
      .then((result) =>
        sendAdapterResult(res, result, (ok) => {
          res.writeHead(200, { 'Content-Type': ok.contentType || 'application/octet-stream' })
          res.end(ok.buffer)
        }),
      )
      .catch(() =>
        apiError(res, 500, 'internal_error', 'Unexpected error reading document content.'),
      )
    return true
  }

  const documentMatch = path.match(/^\/api\/v1\/workspaces\/([^/]+)\/documents\/([^/]+)$/)
  if (documentMatch) {
    const [, workspaceId, documentId] = documentMatch.map(decodeURIComponent)
    if (req.method !== 'GET') {
      apiError(res, 405, 'method_not_allowed', 'Only GET is supported here.')
      return true
    }
    const ws = findWorkspace(workspaceId)
    if (!ws) {
      apiError(res, 404, 'workspace_not_found', 'Workspace not found.', {
        workspace_id: workspaceId,
      })
      return true
    }
    if (!ws.documentCapabilities.includes('documents_get') || !deps.docsAdapter) {
      apiError(
        res,
        404,
        'capability_not_available',
        'documents_get is not implemented for this workspace.',
        {
          workspace_id: workspaceId,
        },
      )
      return true
    }
    deps.docsAdapter
      .getDocument(documentId)
      .then((result) => sendAdapterResult(res, result, (ok) => apiJson(res, 200, ok.document)))
      .catch(() =>
        apiError(res, 500, 'internal_error', 'Unexpected error reading document metadata.'),
      )
    return true
  }

  const documentsMatch = path.match(/^\/api\/v1\/workspaces\/([^/]+)\/documents$/)
  if (documentsMatch) {
    const workspaceId = decodeURIComponent(documentsMatch[1])
    if (req.method !== 'POST') {
      apiError(res, 405, 'method_not_allowed', 'Only POST is supported here.')
      return true
    }
    const ws = findWorkspace(workspaceId)
    if (!ws) {
      apiError(res, 404, 'workspace_not_found', 'Workspace not found.', {
        workspace_id: workspaceId,
      })
      return true
    }
    if (!ws.documentCapabilities.includes('documents_create') || !deps.docsAdapter) {
      apiError(
        res,
        404,
        'capability_not_available',
        'documents_create is not implemented for this workspace.',
        {
          workspace_id: workspaceId,
        },
      )
      return true
    }
    readJsonBody(req)
      .then((body) => deps.docsAdapter.createDocument({ password: body.password }))
      .then((result) => sendAdapterResult(res, result, (ok) => apiJson(res, 200, ok.document)))
      .catch(() => apiError(res, 500, 'internal_error', 'Unexpected error creating document.'))
    return true
  }

  const workspaceMatch = path.match(/^\/api\/v1\/workspaces\/([^/]+)$/)
  if (workspaceMatch) {
    const id = decodeURIComponent(workspaceMatch[1])
    const ws = findWorkspace(id)
    if (!ws) {
      apiError(res, 404, 'workspace_not_found', 'Workspace not found.', { workspace_id: id })
    } else {
      apiJson(res, 200, toPublicWorkspace(ws))
    }
    return true
  }

  apiError(res, 404, 'not_found', 'No such API route.')
  return true
}
