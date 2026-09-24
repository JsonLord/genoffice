// Tests for the /api/v1 surface in api.mjs. Uses Node's built-in test
// runner and a real (but proxy/child-process-free) http.Server, so this
// exercises actual request/response handling — not just the pure functions.
// Run with: node --test api.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  handleApiRequest,
  buildOpenApiDocument,
  buildDiscoveryDocument,
  checkBearerAuth,
} from './api.mjs'

const TOKEN = 'test-token-123'

function makeServer(token = TOKEN) {
  const server = http.createServer((req, res) => {
    const url = req.url || '/'
    if (!handleApiRequest(req, res, url, token)) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'no such route' } }))
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

async function request(server, path, { method = 'GET', token } = {}) {
  const { port } = server.address()
  const headers = token ? { authorization: `Bearer ${token}` } : {}
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers })
  const body = await res.json()
  return { status: res.status, body }
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

test('GET /api/v1/health is unauthenticated and returns ok', async () => {
  const server = await makeServer()
  try {
    const { status, body } = await request(server, '/api/v1/health')
    assert.equal(status, 200)
    assert.deepEqual(body, { status: 'ok', service: 'cowork', api_version: 'v1' })
  } finally {
    await close(server)
  }
})

test('GET /.well-known/cws.json is unauthenticated and describes the API', async () => {
  const server = await makeServer()
  try {
    const { status, body } = await request(server, '/.well-known/cws.json')
    assert.equal(status, 200)
    assert.equal(body.name, 'cowork')
    assert.equal(body.base_url, '/api/v1')
    assert.equal(body.schema, '/openapi.json')
    assert.equal(body.schema_type, 'openapi')
    assert.equal(body.auth.type, 'bearer')
    assert.ok(!('secret' in body) && !JSON.stringify(body).match(/token/i))

    assert.ok(Array.isArray(body.services))
    const docs = body.services.find((s) => s.id === 'docs')
    const slides = body.services.find((s) => s.id === 'slides')
    assert.deepEqual(docs, { id: 'docs', type: 'app', base_url: '/', native_api: '/api' })
    assert.deepEqual(slides, { id: 'slides', type: 'app', base_url: '/slides', native_api: null })
  } finally {
    await close(server)
  }
})

test('GET /openapi.json is unauthenticated and is a valid-shaped OpenAPI document', async () => {
  const server = await makeServer()
  try {
    const { status, body } = await request(server, '/openapi.json')
    assert.equal(status, 200)
    assert.ok(body.openapi.startsWith('3.'))
    assert.ok(body.paths['/workspaces'])
    assert.ok(body.paths['/health'])
    assert.ok(body.paths['/workspaces/{workspace_id}/service'])
    assert.ok(body.paths['/workspaces/{workspace_id}/documents'])
    assert.ok(body.paths['/workspaces/{workspace_id}/documents/{document_id}'])
    assert.ok(body.paths['/workspaces/{workspace_id}/documents/{document_id}/content'])
    const opIds = Object.values(body.paths)
      .flatMap((methods) => Object.values(methods))
      .map((op) => op.operationId)
    assert.deepEqual(new Set(opIds).size, opIds.length, 'operationIds must be unique')
    for (const id of opIds) {
      assert.match(id, /^[a-z]+\.[a-z_]+$/, `operationId "${id}" should look like resource.action`)
    }
  } finally {
    await close(server)
  }
})

test('GET /api/v1/workspaces requires authentication', async () => {
  const server = await makeServer()
  try {
    const { status, body } = await request(server, '/api/v1/workspaces')
    assert.equal(status, 401)
    assert.equal(body.error.code, 'unauthorized')
  } finally {
    await close(server)
  }
})

test('GET /api/v1/workspaces rejects an invalid token', async () => {
  const server = await makeServer()
  try {
    const { status, body } = await request(server, '/api/v1/workspaces', { token: 'wrong' })
    assert.equal(status, 401)
    assert.equal(body.error.code, 'unauthorized')
  } finally {
    await close(server)
  }
})

test('GET /api/v1/workspaces lists workspaces with a valid token', async () => {
  const server = await makeServer()
  try {
    const { status, body } = await request(server, '/api/v1/workspaces', { token: TOKEN })
    assert.equal(status, 200)
    assert.ok(Array.isArray(body.items))
    assert.ok(body.items.some((w) => w.id === 'docs'))
    assert.ok(body.items.some((w) => w.id === 'slides'))
    assert.equal(body.next_page_token, null)
  } finally {
    await close(server)
  }
})

test('GET /api/v1/workspaces/{id} returns a single workspace', async () => {
  const server = await makeServer()
  try {
    const { status, body } = await request(server, '/api/v1/workspaces/docs', { token: TOKEN })
    assert.equal(status, 200)
    assert.equal(body.id, 'docs')
    assert.equal(body.mount, '/')
  } finally {
    await close(server)
  }
})

test('GET /api/v1/workspaces/{id} 404s on an unknown ID with a structured error', async () => {
  const server = await makeServer()
  try {
    const { status, body } = await request(server, '/api/v1/workspaces/does-not-exist', {
      token: TOKEN,
    })
    assert.equal(status, 404)
    assert.equal(body.error.code, 'workspace_not_found')
    assert.equal(body.error.details.workspace_id, 'does-not-exist')
  } finally {
    await close(server)
  }
})

test('GET /api/v1/workspaces/{id}/service reports docs as audited and slides as not yet', async () => {
  const server = await makeServer()
  try {
    const docs = await request(server, '/api/v1/workspaces/docs/service', { token: TOKEN })
    assert.equal(docs.status, 200)
    assert.deepEqual(docs.body, {
      id: 'docs',
      base_path: '/',
      api_base: '/api',
      openapi: null,
      capabilities: ['documents.create', 'documents.get', 'documents.read_content'],
    })
    assert.ok(
      !docs.body.capabilities.some((c) => c.includes('write')),
      'no write capability is exposed — see docsAdapter.mjs for the upstream password-bypass gap',
    )

    const slides = await request(server, '/api/v1/workspaces/slides/service', { token: TOKEN })
    assert.equal(slides.status, 200)
    assert.deepEqual(slides.body, {
      id: 'slides',
      base_path: '/slides',
      api_base: null,
      openapi: null,
      capabilities: [],
    })
  } finally {
    await close(server)
  }
})

test('GET /api/v1/workspaces/{id}/service requires authentication', async () => {
  const server = await makeServer()
  try {
    const { status, body } = await request(server, '/api/v1/workspaces/docs/service')
    assert.equal(status, 401)
    assert.equal(body.error.code, 'unauthorized')
  } finally {
    await close(server)
  }
})

test('GET /api/v1/workspaces/{id}/service 404s on an unknown workspace', async () => {
  const server = await makeServer()
  try {
    const { status, body } = await request(server, '/api/v1/workspaces/nope/service', {
      token: TOKEN,
    })
    assert.equal(status, 404)
    assert.equal(body.error.code, 'workspace_not_found')
  } finally {
    await close(server)
  }
})

test('GET /api/v1/info requires auth and reports capabilities', async () => {
  const server = await makeServer()
  try {
    const unauthed = await request(server, '/api/v1/info')
    assert.equal(unauthed.status, 401)

    const { status, body } = await request(server, '/api/v1/info', { token: TOKEN })
    assert.equal(status, 200)
    assert.equal(body.api_version, 'v1')
    assert.deepEqual(body.capabilities, ['workspaces'])
  } finally {
    await close(server)
  }
})

test('unknown /api/v1 route returns a structured 404', async () => {
  const server = await makeServer()
  try {
    const { status, body } = await request(server, '/api/v1/nope', { token: TOKEN })
    assert.equal(status, 404)
    assert.equal(body.error.code, 'not_found')
  } finally {
    await close(server)
  }
})

test('non-API paths fall through unhandled', () => {
  const res = { writeHead() {}, end() {} }
  const handled = handleApiRequest({ headers: {} }, res, '/slides/', TOKEN)
  assert.equal(handled, false)
})

test('checkBearerAuth: token === null disables auth entirely', () => {
  assert.equal(checkBearerAuth({ headers: {} }, null), true)
})

test('checkBearerAuth: rejects missing/garbled Authorization header', () => {
  assert.equal(checkBearerAuth({ headers: {} }, TOKEN), false)
  assert.equal(checkBearerAuth({ headers: { authorization: 'Basic abc' } }, TOKEN), false)
  assert.equal(checkBearerAuth({ headers: { authorization: `Bearer ${TOKEN}` } }, TOKEN), true)
})

// End-to-end walk a `cws`-style client would do: discover, fetch the
// schema, resolve an operation, call it, and validate the JSON shape.
test('integration: discovery -> schema -> operation -> call', async () => {
  const server = await makeServer()
  try {
    const discovery = await request(server, '/.well-known/cws.json')
    assert.equal(discovery.status, 200)

    const schema = await request(server, discovery.body.schema)
    assert.equal(schema.status, 200)

    const op = schema.body.paths['/workspaces'].get
    assert.equal(op.operationId, 'workspaces.list')

    const call = await request(server, `${discovery.body.base_url}/workspaces`, { token: TOKEN })
    assert.equal(call.status, 200)
    assert.ok(Array.isArray(call.body.items) && call.body.items.length > 0)
  } finally {
    await close(server)
  }
})

test('buildOpenApiDocument and buildDiscoveryDocument never mention the token value', () => {
  const openapi = JSON.stringify(buildOpenApiDocument())
  const discovery = JSON.stringify(buildDiscoveryDocument())
  assert.ok(!openapi.includes(TOKEN))
  assert.ok(!discovery.includes(TOKEN))
})
