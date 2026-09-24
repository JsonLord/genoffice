---
title: OpenUI Cowork
sdk: docker
app_port: 7860
---

# OpenUI Cowork

Two open-source web apps behind one reverse proxy:

- `/` — [Casual Docs](https://github.com/CasualOffice/docs), a browser `.docx` editor with real-time co-editing
- `/slides/` — [Casual Slides](https://github.com/CasualOffice/slides), a browser `.pptx` editor

Casual Sheets is intentionally not included in this deployment — it vendors a large forked
rendering engine that needs its own separate build pass, which made the combined image too
heavy for this Space's hardware tier.

An [OpenCode](https://github.com/sst/opencode) AI chat sidebar was tried at `/chat/` and
removed: its bundled web client has an upstream bug — reproduced locally across the entire
usable version range (1.14.51 through 1.18.32), independent of this proxy — where sending a
chat message races its own directory-resolution logic and the send gets silently cancelled
("thinking" forever, no reply). Not fixable from this repo; revisit if upstream fixes it.

See `Dockerfile` and `server.mjs` for how the two apps are built (each from a pinned upstream
commit) and proxied.
