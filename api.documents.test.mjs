// End-to-end tests for /api/v1/workspaces/{id}/documents... — the full
// request -> handleApiRequest -> docsAdapter -> fake Docs backend path a
// `cws`-style client would actually exercise, not just the adapter in
// isolation (see docsAdapter.test.mjs for that). Uses the real
// createDocsAdapter against a small fake Docs server, same as
// docsAdapter.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { handleApiRequest } from './api.mjs'
import { createDocsAdapter } from './docsAdapter.mjs'

const TOKEN = 'test-token-123'

function startFakeDocs() {
  const rooms = new Map()
  let nextId = 1

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://internal')
    const path = url.pathname

    if (req.method === 'POST' && path === '/api/rooms') {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {}
        const id = `room-${nextId++}`
        rooms.set(id, { password: body.password || null, seed: null })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ roomId: id, needsPassword: Boolean(body.password) }))
      })
      return
    }

    const infoMatch = path.match(/^\/api\/rooms\/([^/]+)\/info$/)
    if (req.method === 'GET' && infoMatch) {
      const room = rooms.get(infoMatch[1])
      if (!room) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'room_not_found' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: infoMatch[1],
          needsPassword: Boolean(room.password),
          hasSeed: room.seed !== null,
          hasSnapshot: false,
          clients: 0,
        }),
      )
      return
    }

    const seedMatch = path.match(/^\/api\/rooms\/([^/]+)\/seed$/)
    if (req.method === 'GET' && seedMatch) {
      const room = rooms.get(seedMatch[1])
      if (!room) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'room_not_found' }))
        return
      }
      if (room.password && req.headers['x-room-password'] !== room.password) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      if (room.seed === null) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'no_seed' }))
        return
      }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
      res.end(room.seed)
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        seedRoom: (id, buf) => {
          rooms.get(id).seed = buf
        },
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

async function makeGateway(docsAdapter) {
  const server = http.createServer((req, res) => {
    const url = req.url || '/'
    if (!handleApiRequest(req, res, url, TOKEN, { docsAdapter })) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'no such route' } }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

async function call(server, path, { method = 'GET', body, token = TOKEN, expectJson = true } = {}) {
  const { port } = server.address()
  const headers = { authorization: `Bearer ${token}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!expectJson) {
    return {
      status: res.status,
      buffer: Buffer.from(await res.arrayBuffer()),
      headers: res.headers,
    }
  }
  return { status: res.status, body: await res.json() }
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

test('cws-style walk: create -> get -> read content for the docs workspace', async () => {
  const fakeDocs = await startFakeDocs()
  const gateway = await makeGateway(createDocsAdapter({ baseUrl: fakeDocs.baseUrl }))
  try {
    const created = await call(gateway, '/api/v1/workspaces/docs/documents', { method: 'POST' })
    assert.equal(created.status, 200)
    assert.equal(created.body.needs_password, false)
    const id = created.body.id

    const fetched = await call(gateway, `/api/v1/workspaces/docs/documents/${id}`)
    assert.equal(fetched.status, 200)
    assert.deepEqual(fetched.body, {
      id,
      needs_password: false,
      has_initial_content: false,
      has_snapshot: false,
      active_clients: 0,
    })

    fakeDocs.seedRoom(id, Buffer.from('hello docx'))
    const content = await call(gateway, `/api/v1/workspaces/docs/documents/${id}/content`, {
      expectJson: false,
    })
    assert.equal(content.status, 200)
    assert.equal(content.buffer.toString(), 'hello docx')
    assert.match(content.headers.get('content-type'), /wordprocessingml/)
  } finally {
    await close(gateway)
    await fakeDocs.close()
  }
})

test('documents_create requires our own bearer auth (Docs backend never sees an unauthed caller)', async () => {
  const fakeDocs = await startFakeDocs()
  const gateway = await makeGateway(createDocsAdapter({ baseUrl: fakeDocs.baseUrl }))
  try {
    const res = await call(gateway, '/api/v1/workspaces/docs/documents', {
      method: 'POST',
      token: 'wrong',
    })
    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'unauthorized')
  } finally {
    await close(gateway)
    await fakeDocs.close()
  }
})

test('documents_get 404s document_not_found for an unknown id', async () => {
  const fakeDocs = await startFakeDocs()
  const gateway = await makeGateway(createDocsAdapter({ baseUrl: fakeDocs.baseUrl }))
  try {
    const res = await call(gateway, '/api/v1/workspaces/docs/documents/nope')
    assert.equal(res.status, 404)
    assert.equal(res.body.error.code, 'document_not_found')
  } finally {
    await close(gateway)
    await fakeDocs.close()
  }
})

test('documents_download requires the password on a protected document', async () => {
  const fakeDocs = await startFakeDocs()
  const gateway = await makeGateway(createDocsAdapter({ baseUrl: fakeDocs.baseUrl }))
  try {
    const created = await call(gateway, '/api/v1/workspaces/docs/documents', {
      method: 'POST',
      body: { password: 'hunter2' },
    })
    assert.equal(created.body.needs_password, true)
    fakeDocs.seedRoom(created.body.id, Buffer.from('secret'))

    const noPassword = await call(
      gateway,
      `/api/v1/workspaces/docs/documents/${created.body.id}/content`,
    )
    assert.equal(noPassword.status, 401)
    assert.equal(noPassword.body.error.code, 'document_password_required')

    const withPassword = await call(
      gateway,
      `/api/v1/workspaces/docs/documents/${created.body.id}/content?password=hunter2`,
      { expectJson: false },
    )
    assert.equal(withPassword.status, 200)
    assert.equal(withPassword.buffer.toString(), 'secret')
  } finally {
    await close(gateway)
    await fakeDocs.close()
  }
})

test("there is no write route: POST/PUT to a document's content 404s rather than writing", async () => {
  const fakeDocs = await startFakeDocs()
  const gateway = await makeGateway(createDocsAdapter({ baseUrl: fakeDocs.baseUrl }))
  try {
    const created = await call(gateway, '/api/v1/workspaces/docs/documents', { method: 'POST' })
    const putRes = await call(
      gateway,
      `/api/v1/workspaces/docs/documents/${created.body.id}/content`,
      {
        method: 'PUT',
        body: { bytes: 'nope' },
      },
    )
    assert.equal(putRes.status, 405)
    const postRes = await call(
      gateway,
      `/api/v1/workspaces/docs/documents/${created.body.id}/content`,
      {
        method: 'POST',
        body: { bytes: 'nope' },
      },
    )
    assert.equal(postRes.status, 405)
  } finally {
    await close(gateway)
    await fakeDocs.close()
  }
})

test('slides workspace does not support documents.* yet (no fake capability)', async () => {
  const gateway = await makeGateway(null)
  try {
    const create = await call(gateway, '/api/v1/workspaces/slides/documents', { method: 'POST' })
    assert.equal(create.status, 404)
    assert.equal(create.body.error.code, 'capability_not_available')

    const get = await call(gateway, '/api/v1/workspaces/slides/documents/anything')
    assert.equal(get.status, 404)
    assert.equal(get.body.error.code, 'capability_not_available')
  } finally {
    await close(gateway)
  }
})

test('unknown workspace 404s workspace_not_found before any capability check', async () => {
  const gateway = await makeGateway(null)
  try {
    const res = await call(gateway, '/api/v1/workspaces/nope/documents', { method: 'POST' })
    assert.equal(res.status, 404)
    assert.equal(res.body.error.code, 'workspace_not_found')
  } finally {
    await close(gateway)
  }
})

test('docs workspace still 404s capability_not_available when no adapter is wired up', async () => {
  const gateway = await makeGateway(null)
  try {
    const res = await call(gateway, '/api/v1/workspaces/docs/documents', { method: 'POST' })
    assert.equal(res.status, 404)
    assert.equal(res.body.error.code, 'capability_not_available')
  } finally {
    await close(gateway)
  }
})

test('a Docs outage surfaces as a structured 502, not a hang or a crash', async () => {
  const gateway = await makeGateway(createDocsAdapter({ baseUrl: 'http://127.0.0.1:1' }))
  try {
    const res = await call(gateway, '/api/v1/workspaces/docs/documents', { method: 'POST' })
    assert.equal(res.status, 502)
    assert.equal(res.body.error.code, 'docs_unavailable')
  } finally {
    await close(gateway)
  }
})
