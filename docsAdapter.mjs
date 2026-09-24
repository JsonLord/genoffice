// docsAdapter.mjs — a thin typed adapter over Casual Docs' own native API
// (the vendored `collab` server — CasualOffice/collab, reached at
// DOCS_TARGET in server.mjs; NOT the CasualOffice/docs frontend repo).
//
// This exists because collab's own HTTP surface returns Docs-internal
// shapes (camelCase, "seed"/"snapshot" jargon, no typed schema at all —
// hand-written Fastify routes with no route `schema`, so `@fastify/swagger`
// would have nothing to introspect). Rather than exposing that surface
// verbatim or guessing at a generic "files" contract, this translates the
// handful of operations actually audited against collab@9b2a9a2d into the
// stable `documents.*` DTOs described in api.mjs's OpenAPI document — the
// "internal persistence vs public API DTO" split the top-level API design
// calls for.
//
// AUDITED, ONLY WHAT'S HERE IS EXPOSED (see docs/hf-space-docs-api-audit.md
// for the full audit):
//   - documents.create        -> POST /api/rooms
//   - documents.get           -> GET  /api/rooms/:id/info
//   - documents.read_content  -> GET  /api/rooms/:id/seed
//
// Deliberately NOT implemented: writing a document's content. Docs' own
// POST /api/rooms/:id/seed and POST /api/rooms/:id/snapshot both skip the
// room-password check that their GET counterparts enforce — a room created
// WITH a password can still have its content silently overwritten by
// anyone who has the room id, without the password. Wrapping that in a
// "documents.write_content" capability would claim a safety guarantee
// (password-gated writes) the underlying operation doesn't actually have.
// Revisit once that's fixed upstream (CasualOffice/collab) or gated another
// way from our side.
//
// Also note: "read_content" returns the room's *original* uploaded seed
// bytes, not its live collaboratively-edited state — collab has no HTTP
// endpoint for a room's current content at all; live state only exists as
// Yjs CRDT updates over the /yjs WebSocket. A room with edits since its
// seed will not reflect them here. See the audit doc for why.

export const DOCS_DEFAULT_BASE_URL = 'http://127.0.0.1:8080'

export function createDocsAdapter({ baseUrl = DOCS_DEFAULT_BASE_URL, fetchImpl = fetch } = {}) {
  async function request(path, init) {
    try {
      return await fetchImpl(`${baseUrl}${path}`, init)
    } catch (err) {
      return { networkError: err }
    }
  }

  // documents.create -> POST /api/rooms
  async function createDocument({ password } = {}) {
    const res = await request('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(password ? { password } : {}),
    })
    if (res.networkError) return { unavailable: true }
    const body = await res.json().catch(() => null)
    if (res.status === 200 && body) {
      return {
        status: 200,
        document: { id: body.roomId, needs_password: Boolean(body.needsPassword) },
      }
    }
    if (res.status === 503) {
      return {
        status: 503,
        error: { code: 'capacity_full', message: 'Docs has no room capacity left.' },
      }
    }
    return { status: 502, error: { code: 'docs_error', message: 'Unexpected response from Docs.' } }
  }

  // documents.get -> GET /api/rooms/:id/info
  async function getDocument(id) {
    const res = await request(`/api/rooms/${encodeURIComponent(id)}/info`)
    if (res.networkError) return { unavailable: true }
    const body = await res.json().catch(() => null)
    if (res.status === 404) {
      return { status: 404, error: { code: 'document_not_found', message: 'Document not found.' } }
    }
    if (res.status === 200 && body) {
      return {
        status: 200,
        document: {
          id: body.id,
          needs_password: Boolean(body.needsPassword),
          has_initial_content: Boolean(body.hasSeed),
          has_snapshot: Boolean(body.hasSnapshot),
          active_clients: body.clients ?? 0,
        },
      }
    }
    return { status: 502, error: { code: 'docs_error', message: 'Unexpected response from Docs.' } }
  }

  // documents.read_content -> GET /api/rooms/:id/seed
  async function getDocumentContent(id, { password } = {}) {
    const headers = {}
    if (password) headers['x-room-password'] = password
    const res = await request(`/api/rooms/${encodeURIComponent(id)}/seed`, { headers })
    if (res.networkError) return { unavailable: true }
    if (res.status === 404) {
      return {
        status: 404,
        error: { code: 'document_content_not_found', message: 'This document has no content yet.' },
      }
    }
    if (res.status === 401) {
      return {
        status: 401,
        error: {
          code: 'document_password_required',
          message: 'A correct password is required for this document.',
        },
      }
    }
    if (res.status === 200) {
      const buffer = Buffer.from(await res.arrayBuffer())
      return { status: 200, buffer, contentType: res.headers.get('content-type') }
    }
    return { status: 502, error: { code: 'docs_error', message: 'Unexpected response from Docs.' } }
  }

  return { createDocument, getDocument, getDocumentContent }
}
