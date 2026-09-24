// Compatibility test against the REAL `cws` (gws) OpenAPI adapter contract,
// not a hypothetical one. Grounded in reading
// JsonLord/cli@self-hosted-provider-adapter-15943772842016135528's
// src/openapi.rs (`add_operation_to_doc`) directly — this mirrors its exact
// operationId -> {resource, method} splitting logic in JS so a change to
// our operationIds that would silently break `cws`'s command generation
// fails a test here, without needing to compile Rust to catch it.
//
// The real algorithm (src/openapi.rs, paraphrased):
//   if operationId contains '_':
//     split on '_'; method = last segment; resource = everything before
//     the LAST underscore, rejoined with '_' (so the method must be a
//     single word, or it silently eats into the resource name)
//   else:
//     resource = first path segment that isn't "api"/"v1"/"v2"; method =
//     the operationId verbatim
//
// This is why every operationId in api.mjs is `resource_method` with a
// single-word method — see the WORKSPACES module comment in api.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOpenApiDocument, buildDiscoveryDocument } from './api.mjs'

function splitOperationIdLikeCws(operationId, pathSegments) {
  if (operationId.includes('_')) {
    const parts = operationId.split('_')
    const method = parts[parts.length - 1]
    const resource = parts.slice(0, -1).join('_')
    return { resource, method }
  }
  const derived = pathSegments.filter(
    (s) => s && !s.startsWith('{') && !['api', 'v1', 'v2'].includes(s),
  )
  return { resource: derived[0] || pathSegments[0] || 'default', method: operationId }
}

function collectOperations(doc) {
  const ops = []
  for (const [path, item] of Object.entries(doc.paths)) {
    const pathSegments = path.replace(/^\//, '').split('/')
    for (const [httpMethod, op] of Object.entries(item)) {
      ops.push({ path, httpMethod, pathSegments, operationId: op.operationId, op })
    }
  }
  return ops
}

// The exact resource/method tree `cws cowork <resource> <method>` will
// build from our current openapi.json. Changing this is changing the CLI
// contract — update deliberately, not as a side effect of an unrelated
// rename.
const EXPECTED_COMMAND_TREE = {
  health_check: { resource: 'health', method: 'check' },
  info_get: { resource: 'info', method: 'get' },
  workspaces_list: { resource: 'workspaces', method: 'list' },
  workspaces_get: { resource: 'workspaces', method: 'get' },
  workspaces_service: { resource: 'workspaces', method: 'service' },
  documents_create: { resource: 'documents', method: 'create' },
  documents_get: { resource: 'documents', method: 'get' },
  documents_download: { resource: 'documents', method: 'download' },
}

test('every operationId splits into the intended resource/method per the real cws algorithm', () => {
  const doc = buildOpenApiDocument()
  const ops = collectOperations(doc)
  assert.equal(
    ops.length,
    Object.keys(EXPECTED_COMMAND_TREE).length,
    'operation count should match the expected tree',
  )
  for (const { operationId, pathSegments } of ops) {
    const expected = EXPECTED_COMMAND_TREE[operationId]
    assert.ok(
      expected,
      `unexpected operationId "${operationId}" — add it to EXPECTED_COMMAND_TREE deliberately`,
    )
    const actual = splitOperationIdLikeCws(operationId, pathSegments)
    assert.deepEqual(
      actual,
      expected,
      `operationId "${operationId}" would generate "cws cowork ${actual.resource} ${actual.method}", expected "cws cowork ${expected.resource} ${expected.method}"`,
    )
  }
})

test('no two operations collide on the same (resource, method) pair', () => {
  const doc = buildOpenApiDocument()
  const ops = collectOperations(doc)
  const seen = new Set()
  for (const { operationId, pathSegments } of ops) {
    const { resource, method } = splitOperationIdLikeCws(operationId, pathSegments)
    const key = `${resource}/${method}`
    assert.ok(!seen.has(key), `"${key}" is produced by more than one operationId`)
    seen.add(key)
  }
})

// The adapter only captures a request/response schema when it's a $ref
// (see convert's `.schema_ref.as_deref()` guard in openapi.rs) — an inline
// schema there is silently dropped, degrading `cws schema` introspection
// and body validation without erroring. Every JSON request/response body
// in our schema must therefore be a $ref, not inline, or this is a silent
// regression.
test('every JSON request/response body is a $ref, not an inline schema (required for cws schema introspection)', () => {
  const doc = buildOpenApiDocument()
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [httpMethod, op] of Object.entries(item)) {
      const label = `${httpMethod.toUpperCase()} ${path} (${op.operationId})`
      const reqSchema = op.requestBody?.content?.['application/json']?.schema
      if (reqSchema) {
        assert.ok(reqSchema.$ref, `${label}: request body schema must be a $ref`)
      }
      for (const [status, response] of Object.entries(op.responses || {})) {
        const schema = response.content?.['application/json']?.schema
        if (schema) {
          assert.ok(schema.$ref, `${label} [${status}]: response schema must be a $ref`)
        }
      }
    }
  }
})

// Every $ref used anywhere in the document must resolve to a real schema —
// the adapter's `clean_schema_ref` strips the "#/components/schemas/"
// prefix and looks the name straight up; a typo'd ref would silently
// produce an unresolvable schema reference for `cws schema`.
test('every $ref resolves to a schema actually defined in components.schemas', () => {
  const doc = buildOpenApiDocument()
  const definedSchemas = new Set(Object.keys(doc.components.schemas))
  const refs = new Set()
  JSON.stringify(doc, (key, value) => {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/components/schemas/')) {
      refs.add(value.slice('#/components/schemas/'.length))
    }
    return value
  })
  assert.ok(refs.size > 0, 'sanity check: the document should contain at least one $ref')
  for (const ref of refs) {
    assert.ok(
      definedSchemas.has(ref),
      `$ref "${ref}" does not match any schema in components.schemas`,
    )
  }
})

// The executor's auto-pagination (--page-all) looks for a top-level
// "nextPageToken" string field (camelCase, Google Discovery style) and a
// "pageToken" query param to request the next page — NOT the snake_case
// "next_page_token"/"page_token" this project used before this was
// checked against the real executor. A mismatch here doesn't error; it
// just means --page-all silently never continues past page one.
test('list response pagination field is camelCase nextPageToken, matching the real executor', () => {
  const doc = buildOpenApiDocument()
  const workspaceListSchema = doc.components.schemas.WorkspaceList
  assert.ok('nextPageToken' in workspaceListSchema.properties)
  assert.ok(!('next_page_token' in workspaceListSchema.properties))
})

// The CLI's OpenAPI struct (OpenApiSpec/OpenApiOperation/...) never reads
// components.securitySchemes or a top-level `security` array — auth comes
// entirely from the CLI's own ServiceConfig (AuthType::Bearer, already
// hardcoded for the built-in "cowork" entry in src/config.rs). These
// fields are still valid OpenAPI and useful to OTHER tooling / human
// readers, so we keep them, but a test asserting the CLI "reads" them
// would be testing something that isn't true — this test instead pins
// down that the discovery document (which IS meant for humans/other
// clients per this project's own /.well-known/cws.json contract) still
// advertises bearer auth accurately.
test('discovery document advertises bearer auth (informational; cws does not parse OpenAPI security schemes)', () => {
  const discovery = buildDiscoveryDocument()
  assert.equal(discovery.auth.type, 'bearer')
})
