---
title: OpenUI Cowork
sdk: docker
app_port: 7860
---

# OpenUI Cowork

Two open-source web apps behind one reverse proxy, plus a small machine-readable API:

- `/` — [Casual Docs](https://github.com/CasualOffice/docs), a browser `.docx` editor with real-time co-editing
- `/slides/` — [Casual Slides](https://github.com/CasualOffice/slides), a browser `.pptx` editor
- `/api/v1/*` — a stable, bearer-authenticated REST API over this deployment (workspaces, health,
  info, and an audited `documents_*` surface for the `docs` workspace), described by
  `/openapi.json`, with a discovery document at `/.well-known/cws.json` for machine clients such
  as the `cws` CLI

Casual Sheets is intentionally not included in this deployment — it vendors a large forked
rendering engine that needs its own separate build pass, which made the combined image too
heavy for this Space's hardware tier.

An [OpenCode](https://github.com/sst/opencode) AI chat sidebar was tried at `/chat/` and
removed: its bundled web client has an upstream bug — reproduced locally across the entire
usable version range (1.14.51 through 1.18.32), independent of this proxy — where sending a
chat message races its own directory-resolution logic and the send gets silently cancelled
("thinking" forever, no reply). Not fixable from this repo; revisit if upstream fixes it.
Driving this deployment programmatically now goes through `/api/v1` and each app's own existing
REST API (e.g. Casual Docs' `/api/files`, `/api/rooms`), not through an embedded agent with
shell/file access inside the container.

## Configuration

- **The `/api/v1` surface is bearer-token gated, and fails closed when deployed.** Hugging Face
  sets `SPACE_ID` on every running Space automatically; whenever that's set (or `COWORK_ENV=production`
  for a non-HF deployment), `COWORK_API_TOKEN` **must** be set as a secret or the container refuses
  to start — there is no auto-generated fallback and `COWORK_API_AUTH_DISABLED` is rejected outright
  in that mode, since a generated token is only as secret as the container logs it's printed to,
  which isn't good enough for a public deployment.
  - **Local development only:** if neither `SPACE_ID` nor `COWORK_ENV=production` is set, a missing
    `COWORK_API_TOKEN` falls back to a random token printed to stdout at startup, and
    `COWORK_API_AUTH_DISABLED=true` disables auth entirely. Never rely on either in a deployed Space.

## API quickstart

```bash
curl https://<space-host>/api/v1/health
curl https://<space-host>/.well-known/cws.json
curl -H "Authorization: Bearer $COWORK_API_TOKEN" https://<space-host>/api/v1/workspaces
curl -H "Authorization: Bearer $COWORK_API_TOKEN" https://<space-host>/api/v1/workspaces/docs/service
```

## Sub-service discovery

`/api/v1/workspaces` and `/.well-known/cws.json`'s `services` array both describe the apps mounted
behind this proxy (currently `docs` and `slides`) as a registry — where each is mounted, and where
its own native API lives, if known. `GET /api/v1/workspaces/{id}/service` returns that same
integration metadata for one workspace, including which capabilities have actually been audited
and wired up:

- **`docs`** — audited (see [`docs/hf-space-docs-api-audit.md`](docs/hf-space-docs-api-audit.md)).
  `capabilities: ["documents_create", "documents_get", "documents_download"]`, backed by
  Casual Docs' real room API through a thin typed adapter (`docsAdapter.mjs`). No write/delete
  capability is exposed — the audit found that Docs' own room-content write routes skip the
  password check their read routes enforce, so a "safe, stable" write claim wouldn't be true.
- **`slides`** — not audited in this pass (out of scope here), `capabilities: []`.

`api_base` for `docs` is `/api` (Docs' own native routes, still reachable directly through this
proxy — e.g. `GET /api/rooms` — for anything not yet wrapped above) and `null` for `slides`.
`openapi` is `null` for both: neither app publishes its own OpenAPI schema, and the `documents_*`
operations above are documented in this deployment's own top-level `/openapi.json` instead.

## Documents API (docs workspace)

```bash
# Create a document (room). Optional {"password": "..."} in the body.
curl -X POST -H "Authorization: Bearer $COWORK_API_TOKEN" \
  https://<space-host>/api/v1/workspaces/docs/documents

# Get its metadata
curl -H "Authorization: Bearer $COWORK_API_TOKEN" \
  https://<space-host>/api/v1/workspaces/docs/documents/<id>

# Read its original content (NOT live collaborative edits — see the audit doc)
curl -H "Authorization: Bearer $COWORK_API_TOKEN" \
  "https://<space-host>/api/v1/workspaces/docs/documents/<id>/content?password=<if set>"
```

## Tests

```bash
npm run test:hf-space-api        # api.test.mjs + config.test.mjs — in-process, no network, run in CI
npm run test:hf-space-api-smoke  # api.smoke.test.mjs — against a live deployment, opt-in only
```

The smoke test is off by default (skipped with no assertions run) since it needs live network
access and a running deployment — neither guaranteed in CI. Enable it against the deployed Space:

```bash
COWORK_SMOKE_BASE_URL=https://leon4gr45-openui-cowork.hf.space \
COWORK_SMOKE_TOKEN=<bearer token> \
npm run test:hf-space-api-smoke
```

It walks the same path a `cws`-style client would: `/.well-known/cws.json` → `/openapi.json` →
resolve `workspaces_list` → call it with the bearer token → validate the JSON shape.
`COWORK_SMOKE_TOKEN` is optional on top of `COWORK_SMOKE_BASE_URL`: without it, the test still
verifies discovery/openapi/health but skips the authenticated call.

## `cws` CLI compatibility

This API's shape (operation IDs, path prefixes, pagination field name) is dictated by the actual
adapter in [JsonLord/cli](https://github.com/JsonLord/cli)
(`self-hosted-provider-adapter-...` branch's `src/openapi.rs`/`src/discovery.rs`/`src/executor.rs`),
not by a hypothetical convention — verified by running a real compiled build of that CLI against a
local instance of this API, not just by reading its source:

- **Operation IDs are `resource_method`, one underscore, single-word method.** The adapter splits
  an `operationId` on its _last_ underscore into `{resource}_{method}`; a multi-word method (e.g.
  the earlier `documents.read_content` this project used before checking) gets silently absorbed
  into the resource name instead of erroring. Every operationId here (`workspaces_list`,
  `documents_download`, etc.) follows this — see `cws-compat.test.mjs`, which mirrors the exact
  split algorithm and fails if a future change would break `cws`'s command generation.
- **OpenAPI paths are absolute from root (`/api/v1/...`), not relative to `servers[].url`.** The
  adapter combines a configured `base_url` with this document's paths but ignores `servers[].url`
  whenever `base_url` is set — true for every self-hosted service, `cowork` included. A
  `servers: [{url: "/api/v1"}]` + short-path document (this project's original shape) resolved to
  `<base_url>/workspaces` instead of `<base_url>/api/v1/workspaces` — a live 404, confirmed against
  a real build before this was fixed. `servers` here is `[{url: "/"}]` and every path carries the
  `/api/v1` prefix explicitly.
- **List responses paginate with camelCase `nextPageToken`** (Google Discovery convention, which
  the executor's `--page-all` flag looks for verbatim), not `next_page_token`.
- **Only `$ref`-based request/response schemas are captured** by the adapter — an inline schema is
  silently dropped (no error, just no schema for `cws schema` to show). Every request/response body
  in `api.mjs` is a named `$ref` for this reason.
- **A real, blocking bug was found and fixed upstream, not worked around here:**
  `fetch_discovery_document` tried its embedded fallback spec for the `cowork` service _before_
  ever fetching the configured `schema_url` — since that fallback always "succeeds" (it's a
  hardcoded constant), the live schema was dead code. Fixed in
  [JsonLord/cli#3](https://github.com/JsonLord/cli/pull/3), which also updates
  `tests/fixtures/cowork_openapi.json` to a verified snapshot of this API's real `/openapi.json`
  instead of an old hypothetical shape.

Quickstart once that fix is in place (the CLI's built-in `[services.cowork]` entry already points
at this Space and reads its token from a `COWORK_TOKEN` env var — separate from this deployment's
own `COWORK_API_TOKEN` secret, same value):

```bash
export COWORK_TOKEN=<the same value as this Space's COWORK_API_TOKEN secret>
cws cowork workspaces list
cws cowork workspaces get --params '{"workspace_id":"docs"}'
cws cowork documents create --params '{"workspace_id":"docs"}'
cws cowork documents download --params '{"workspace_id":"docs","document_id":"<id>"}'
cws schema cowork.workspaces.list
```

See `Dockerfile` and `server.mjs` for how the two apps are built (each from a pinned upstream
commit) and proxied, `config.mjs` for the fail-closed auth decision, `api.mjs` for the `/api/v1`
implementation, `docsAdapter.mjs` for the Docs documents\_\* adapter, and
[`docs/hf-space-docs-api-audit.md`](docs/hf-space-docs-api-audit.md) for the audit behind it.
