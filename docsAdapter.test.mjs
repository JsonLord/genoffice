// Tests for docsAdapter.mjs against a small fake Docs (collab) backend that
// replicates the exact response shapes audited in
// docs/hf-space-docs-api-audit.md (collab@9b2a9a2d4928358efa0d298d14a601915df6a724):
//   POST /api/rooms                -> { roomId, needsPassword }
//   GET  /api/rooms/:id/info       -> { id, needsPassword, hasSeed, hasSnapshot, clients } | 404
//   GET  /api/rooms/:id/seed       -> raw bytes | 401 (wrong/missing password) | 404 (no seed)
//
// This is a fake server, not a mock of fetch, so the adapter's real HTTP
// handling (headers, status codes, JSON/binary parsing) is exercised
// end-to-end.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createDocsAdapter } from './docsAdapter.mjs'

function startFakeDocs() {
  const rooms = new Map() // id -> { needsPassword, password, seed: Buffer | null }
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
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        // Test-only hook so a test can seed a room's content directly,
        // matching what POST /api/rooms/:id/seed would otherwise do.
        seedRoom: (id, buf) => {
          rooms.get(id).seed = buf
        },
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

test('createDocument: creates an open room and returns the mapped DTO', async () => {
  const fake = await startFakeDocs()
  try {
    const adapter = createDocsAdapter({ baseUrl: fake.baseUrl })
    const result = await adapter.createDocument()
    assert.equal(result.status, 200)
    assert.equal(result.document.needs_password, false)
    assert.ok(result.document.id)
  } finally {
    await fake.close()
  }
})

test('createDocument: with a password, needs_password is true', async () => {
  const fake = await startFakeDocs()
  try {
    const adapter = createDocsAdapter({ baseUrl: fake.baseUrl })
    const result = await adapter.createDocument({ password: 'hunter2' })
    assert.equal(result.status, 200)
    assert.equal(result.document.needs_password, true)
  } finally {
    await fake.close()
  }
})

test('getDocument: maps a live room to the Document DTO', async () => {
  const fake = await startFakeDocs()
  try {
    const adapter = createDocsAdapter({ baseUrl: fake.baseUrl })
    const created = await adapter.createDocument()
    const result = await adapter.getDocument(created.document.id)
    assert.equal(result.status, 200)
    assert.deepEqual(result.document, {
      id: created.document.id,
      needs_password: false,
      has_initial_content: false,
      has_snapshot: false,
      active_clients: 0,
    })
  } finally {
    await fake.close()
  }
})

test('getDocument: 404s with document_not_found for an unknown id', async () => {
  const fake = await startFakeDocs()
  try {
    const adapter = createDocsAdapter({ baseUrl: fake.baseUrl })
    const result = await adapter.getDocument('nope')
    assert.equal(result.status, 404)
    assert.equal(result.error.code, 'document_not_found')
  } finally {
    await fake.close()
  }
})

test('getDocumentContent: returns the seeded bytes with content type', async () => {
  const fake = await startFakeDocs()
  try {
    const adapter = createDocsAdapter({ baseUrl: fake.baseUrl })
    const created = await adapter.createDocument()
    fake.seedRoom(created.document.id, Buffer.from('pretend docx bytes'))
    const result = await adapter.getDocumentContent(created.document.id)
    assert.equal(result.status, 200)
    assert.equal(result.buffer.toString(), 'pretend docx bytes')
    assert.match(result.contentType, /wordprocessingml/)
  } finally {
    await fake.close()
  }
})

test('getDocumentContent: 404s document_content_not_found when never seeded', async () => {
  const fake = await startFakeDocs()
  try {
    const adapter = createDocsAdapter({ baseUrl: fake.baseUrl })
    const created = await adapter.createDocument()
    const result = await adapter.getDocumentContent(created.document.id)
    assert.equal(result.status, 404)
    assert.equal(result.error.code, 'document_content_not_found')
  } finally {
    await fake.close()
  }
})

test('getDocumentContent: 401s document_password_required without the right password', async () => {
  const fake = await startFakeDocs()
  try {
    const adapter = createDocsAdapter({ baseUrl: fake.baseUrl })
    const created = await adapter.createDocument({ password: 'hunter2' })
    fake.seedRoom(created.document.id, Buffer.from('secret'))

    const noPassword = await adapter.getDocumentContent(created.document.id)
    assert.equal(noPassword.status, 401)
    assert.equal(noPassword.error.code, 'document_password_required')

    const wrongPassword = await adapter.getDocumentContent(created.document.id, {
      password: 'wrong',
    })
    assert.equal(wrongPassword.status, 401)

    const rightPassword = await adapter.getDocumentContent(created.document.id, {
      password: 'hunter2',
    })
    assert.equal(rightPassword.status, 200)
    assert.equal(rightPassword.buffer.toString(), 'secret')
  } finally {
    await fake.close()
  }
})

test('adapter reports unavailable rather than throwing when Docs is unreachable', async () => {
  // Nothing listens on this port.
  const adapter = createDocsAdapter({ baseUrl: 'http://127.0.0.1:1' })
  const create = await adapter.createDocument()
  assert.equal(create.unavailable, true)
  const get = await adapter.getDocument('x')
  assert.equal(get.unavailable, true)
  const content = await adapter.getDocumentContent('x')
  assert.equal(content.unavailable, true)
})
