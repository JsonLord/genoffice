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
  info), described by `/openapi.json`, with a discovery document at `/.well-known/cws.json` for
  machine clients such as the `cws` CLI

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
integration metadata for one workspace. Neither Docs' nor Slides' own APIs have been audited yet,
so `openapi` is `null` and `capabilities` is `[]` for both today; `api_base` for `docs` is `/api`
(grounded in this proxy's own routing — Docs' backend already serves `/api/rooms`, `/api/files`,
etc. there) and `null` for `slides` (not yet confirmed). Auditing each app's native API and
publishing a real per-app OpenAPI contract are deliberately separate, later passes — this registry
gives `cws` a stable place to look once that lands, without another change to the top-level schema.

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
resolve `workspaces.list` → call it with the bearer token → validate the JSON shape.
`COWORK_SMOKE_TOKEN` is optional on top of `COWORK_SMOKE_BASE_URL`: without it, the test still
verifies discovery/openapi/health but skips the authenticated call.

See `Dockerfile` and `server.mjs` for how the two apps are built (each from a pinned upstream
commit) and proxied, `config.mjs` for the fail-closed auth decision, and `api.mjs` for the
`/api/v1` implementation.
