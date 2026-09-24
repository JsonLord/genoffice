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
// this proxy already, unaudited beyond that). Slides' equivalent hasn't
// been audited, so it stays `null` rather than a guess — see
// `/api/v1/workspaces/{id}/service` and the README for how this fills in
// over later passes.
export const WORKSPACES = [
  {
    id: 'docs',
    title: 'Casual Docs',
    kind: 'docx',
    mount: '/',
    description: 'Browser .docx editor with real-time co-editing.',
    nativeApiBase: '/api',
  },
  {
    id: 'slides',
    title: 'Casual Slides',
    kind: 'pptx',
    mount: '/slides',
    description: 'Browser .pptx editor.',
    nativeApiBase: null,
  },
]

export function findWorkspace(id) {
  return WORKSPACES.find((w) => w.id === id) || null
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
// only. `openapi` and `capabilities` stay empty/null until that app's own
// API has actually been audited in a later pass — see api.mjs's module
// comment and the README's "Sub-service integration status" section.
function toServiceMetadata(ws) {
  return {
    id: ws.id,
    base_path: ws.mount,
    api_base: ws.nativeApiBase,
    openapi: null,
    capabilities: [],
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
    capabilities: ['workspaces'],
    services: WORKSPACES.map(toDiscoveryService),
  }
}

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
    servers: [{ url: '/api/v1' }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/health': {
        get: {
          operationId: 'health.check',
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
      '/info': {
        get: {
          operationId: 'info.get',
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
      '/workspaces': {
        get: {
          operationId: 'workspaces.list',
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
      '/workspaces/{workspace_id}': {
        get: {
          operationId: 'workspaces.get',
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
      '/workspaces/{workspace_id}/service': {
        get: {
          operationId: 'workspaces.service',
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
            next_page_token: { type: 'string', nullable: true },
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
                'Audited, exposed capabilities of this app\'s native API, e.g. "files.read".',
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
      },
    },
  }
}

// Handles /api/v1/*, /openapi.json and /.well-known/cws.json. Returns true
// if it fully handled the request, false if the caller should fall through
// to the app proxy routes. `token` is the expected bearer token, or `null`
// to disable auth entirely (see checkBearerAuth).
export function handleApiRequest(req, res, url, token) {
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
      capabilities: ['workspaces'],
      workspaces: WORKSPACES,
    })
    return true
  }

  if (path === '/api/v1/workspaces') {
    apiJson(res, 200, { items: WORKSPACES, next_page_token: null })
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

  const workspaceMatch = path.match(/^\/api\/v1\/workspaces\/([^/]+)$/)
  if (workspaceMatch) {
    const id = decodeURIComponent(workspaceMatch[1])
    const ws = findWorkspace(id)
    if (!ws) {
      apiError(res, 404, 'workspace_not_found', 'Workspace not found.', { workspace_id: id })
    } else {
      apiJson(res, 200, ws)
    }
    return true
  }

  apiError(res, 404, 'not_found', 'No such API route.')
  return true
}
