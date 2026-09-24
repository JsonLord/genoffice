// Optional smoke test against a *deployed* OpenUI Cowork instance (e.g. the
// live Hugging Face Space), walking the same path a `cws`-style client
// would: discover -> fetch schema -> resolve an operation -> call it ->
// validate the JSON shape.
//
// Off by default: it depends on live network access and a running
// deployment, neither guaranteed in CI or in a sandboxed session. Enable
// with:
//
//   COWORK_SMOKE_BASE_URL=https://leon4gr45-openui-cowork.hf.space \
//   COWORK_SMOKE_TOKEN=<bearer token> \
//   node --test api.smoke.test.mjs
//
// COWORK_SMOKE_TOKEN is optional on top of that: without it, this still
// verifies discovery/openapi/health but skips the authenticated call.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const BASE_URL = process.env.COWORK_SMOKE_BASE_URL
const TOKEN = process.env.COWORK_SMOKE_TOKEN

test(
  'smoke: deployed Cowork instance is discoverable and callable',
  { skip: !BASE_URL && 'set COWORK_SMOKE_BASE_URL to enable (e.g. the live HF Space URL)' },
  async (t) => {
    const discoveryRes = await fetch(new URL('/.well-known/cws.json', BASE_URL))
    assert.equal(discoveryRes.status, 200)
    const discovery = await discoveryRes.json()
    assert.equal(discovery.name, 'cowork')
    assert.equal(discovery.schema_type, 'openapi')
    assert.ok(Array.isArray(discovery.services))

    const schemaRes = await fetch(new URL(discovery.schema, BASE_URL))
    assert.equal(schemaRes.status, 200)
    const schema = await schemaRes.json()
    // Paths are absolute from root (/api/v1/...), not relative to
    // `servers[].url` — see the "cws CLI compatibility" section in
    // README.md for why (the real cws adapter ignores servers[].url
    // whenever a base_url override is configured, which it always is).
    const listOp = schema.paths?.['/api/v1/workspaces']?.get
    assert.ok(listOp, 'workspaces_list operation should exist in the deployed schema')
    assert.equal(listOp.operationId, 'workspaces_list')

    const healthRes = await fetch(new URL('/api/v1/health', BASE_URL))
    assert.equal(healthRes.status, 200)
    const health = await healthRes.json()
    assert.equal(health.status, 'ok')

    await t.test(
      'authenticated workspaces_list call',
      { skip: !TOKEN && 'set COWORK_SMOKE_TOKEN to also test the authenticated call' },
      async () => {
        const listUrl = new URL(discovery.base_url + '/workspaces', BASE_URL)
        const res = await fetch(listUrl, { headers: { authorization: `Bearer ${TOKEN}` } })
        assert.equal(res.status, 200)
        const body = await res.json()
        assert.ok(Array.isArray(body.items) && body.items.length > 0)
      },
    )
  },
)
