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

- **The `/api/v1` surface is bearer-token gated.** Set `COWORK_API_TOKEN` as a Space secret to pin
  a stable token; otherwise a random one is generated at container startup and printed to the
  Space's container logs (Logs tab) — never shown in API responses or baked into the image. Set
  `COWORK_API_AUTH_DISABLED=true` to disable auth entirely for local development only — never do
  this in a deployed Space.

## API quickstart

```bash
curl https://<space-host>/api/v1/health
curl https://<space-host>/.well-known/cws.json
curl -H "Authorization: Bearer $COWORK_API_TOKEN" https://<space-host>/api/v1/workspaces
```

See `Dockerfile` and `server.mjs` for how the two apps are built (each from a pinned upstream
commit) and proxied, and `api.mjs` for the `/api/v1` implementation and its tests (`api.test.mjs`,
run with `node --test api.test.mjs`).
