# Casual Docs API audit (for the /api/v1 `docs` workspace)

Audit of the vendored Docs backend this HF Space actually runs, done to decide what
`/api/v1/workspaces/docs/service` can honestly claim in `capabilities`. Scope: `docs` only, per
project instructions — Slides is a separate, later pass.

**What "Docs" actually is at runtime.** The Dockerfile clones two separate upstream repos into
the `docs` mount: `CasualOffice/docs` (the frontend SPA — build-only, ships no server) and
`CasualOffice/collab` (`@casualoffice/collab`, pinned at
`9b2a9a2d4928358efa0d298d14a601915df6a724`) — a Fastify server that is the actual backend
`server.mjs` proxies to at `DOCS_TARGET`. All findings below are against that pinned commit.

## What's live in _this_ deployment today

`collab`'s own README documents auth/personal-files/admin as configurable via env vars. This
deployment's `Dockerfile`/`server.mjs` sets only `CASUAL_FILE_EXT` and `TRUST_PROXY` for the docs
child process — none of `CASUAL_PERSONAL_MODE`, `CASUAL_JWT_SECRET`, `CASUAL_ADMIN_USERNAME`,
`CASUAL_ADMIN_PASSWORD`, or `CASUAL_STORAGE` are set. That silently turns off most of the surface
`collab` is capable of:

| Route family                                                                              | Mounted here?          | Why                                                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/rooms`, `GET /api/rooms/:id/info`, `GET`/`POST /api/rooms/:id/{seed,snapshot}` | **Yes, always**        | Anonymous, no gating env needed. This is the app's real primary flow — the frontend's `/r/:roomId` share-link editor.                                        |
| `/wopi/files/:id[/contents]`, `GET /api/files`, `GET /api/me`, `POST /api/tokens`         | Yes, but **anonymous** | JWT auth for these routes is opt-in via `CASUAL_JWT_SECRET`; unset here, so `resolveAuth()` falls through to anonymous for all of them (`wopi.ts`).          |
| `/auth/*`, personal `/files`, `/shares`                                                   | **No**                 | Gated behind `CASUAL_PERSONAL_MODE` (`auth/personal.ts:readModeFromEnv`, default `'none'`); not mounted at all when off (`index.ts`).                        |
| `/api/admin/*`                                                                            | Effectively no         | Every route 503s unless `CASUAL_ADMIN_USERNAME` + `CASUAL_ADMIN_PASSWORD` + `CASUAL_JWT_SECRET` are ALL set (`admin/routes.ts:isAdminConfigured`); none are. |
| `POST /api/mcp-proxy`                                                                     | Yes, anonymous         | A same-origin SSRF-guarded relay for the browser MCP client, unrelated to file/document storage — not a documents capability, not exposed here.              |

So "documents" in this deployment means **rooms**, not files or personal accounts. A room is
identified by a 60-bit CSPRNG id (`rooms.ts:makeRoomId`), unguessable but knowledge-of-id is the
entire access model for an unprotected room — this is by design (the app's actual sharing model,
"anyone with the link"), not a defect.

## Storage backend

`CASUAL_STORAGE` is unset → `createHost()` defaults to `MemoryHost` (`host/index.ts`,
`host/memory.ts`): an in-process `Map`, wiped on every container restart, no filesystem access at
all. No path-traversal surface exists in the active backend. (`LocalHost` — the filesystem-backed
option, not active here — does sanitize `fileId` before building a path (`host/local.ts:safeName`,
strips everything but `[A-Za-z0-9._-]`); noted for completeness in case `CASUAL_STORAGE=local` is
ever set for this deployment.)

## Findings

1. **(Real gap, upstream) Room-password bypass on write.** `GET /api/rooms/:id/seed` and
   `GET /api/rooms/:id/snapshot` both call `checkRoomPassword()` before serving content
   (`index.ts`). Their `POST` counterparts — the routes that _set_ that content — call neither:
   anyone who knows a room id can overwrite a password-protected room's seed/snapshot without ever
   supplying the password. The `POST /seed` handler's own comment ("No auth: the owner is the only
   client who knows the freshly-minted roomId at this instant... theoretical... not worth more
   machinery") only justifies the _unprotected_-room case; it doesn't address a room created WITH
   a password. **Consequence for this audit:** no `documents.write_content` (or `files.write`)
   capability is exposed — advertising one would claim a password-gated write guarantee the
   backend doesn't enforce. Revisit once fixed upstream in `CasualOffice/collab`, or gated another
   way from our side.
2. **(Informational) WOPI/`/api/files`/`/api/tokens` are anonymous by default.** Not a bug in
   isolation — `wopi.ts` documents this as intentional back-compat "opt-in to auth by setting
   `CASUAL_JWT_SECRET`" — but worth flagging because it means these routes, reachable directly at
   this Space's root today (e.g. `GET /api/files`), give any caller read/write over every file the
   in-memory host holds, no isolation, no auth. Not wrapped in `/api/v1` here — `documents.*`
   below is built on the room API instead, which has no comparable listing/global-access route.
3. **(Informational) `/api/rooms` list omits ids on purpose.** `GET /api/rooms` returns per-room
   counts _without_ ids — deliberately, per its own comment, to avoid handing out the full set of
   shared documents. So there is no `documents.list` capability to expose; this isn't something
   we chose to omit, the backend doesn't support it.
4. **No path traversal in the active backend.** `MemoryHost` is a `Map`; room/file ids never touch
   a filesystem path in this deployment's configuration.
5. **`/api/mcp-proxy` is a real SSRF-relevant surface** (basic private-IP-literal blocklist, no
   DNS-rebinding defence) but it's unrelated to documents/files and out of scope for this audit's
   capability set.

## What `/api/v1` exposes as a result (`docsAdapter.mjs`)

| Capability               | Backed by                 | Notes                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documents.create`       | `POST /api/rooms`         | Optional `password` in the request body, passed straight through.                                                                                                                                                                                                                                                                                          |
| `documents.get`          | `GET /api/rooms/:id/info` | Metadata only — no content.                                                                                                                                                                                                                                                                                                                                |
| `documents.read_content` | `GET /api/rooms/:id/seed` | Returns the room's **original uploaded seed**, not its live collaboratively-edited state — collab has no HTTP endpoint for a room's _current_ content; live edits exist only as Yjs CRDT updates over `/yjs`. A room with edits since creation will not reflect them via this endpoint. Password-gated correctly (finding 1 is about the write side only). |

No write/delete capability is exposed, per finding 1. `openapi` stays `null` on the `docs` service
metadata: `collab` has no route `schema`s for `@fastify/swagger` (or any OpenAPI generator) to
introspect, and these operations are documented in this deployment's own top-level
`/openapi.json` instead of a separate per-app document.
