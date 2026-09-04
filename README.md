---
title: OpenUI Cowork
sdk: docker
app_port: 7860
---

# OpenUI Cowork

Three open-source web apps behind one reverse proxy:

- `/` — [Casual Docs](https://github.com/CasualOffice/docs), a browser `.docx` editor with real-time co-editing
- `/slides/` — [Casual Slides](https://github.com/CasualOffice/slides), a browser `.pptx` editor
- `/chat/` — [OpenCode](https://github.com/sst/opencode), an AI coding-agent chat, also embedded as a
  collapsible sidebar on the Docs page

Casual Sheets is intentionally not included in this deployment — it vendors a large forked
rendering engine that needs its own separate build pass, which made the combined image too
heavy for this Space's hardware tier.

## Configuration

- **OpenCode needs an LLM key to respond.** Set `ANTHROPIC_API_KEY` (or another provider key
  OpenCode supports) as a Space secret.
- **The chat is access-code gated.** OpenCode has shell/file tool access inside this container,
  so `/chat` is protected by a random code generated at container startup and printed to the
  Space's container logs (Logs tab) — never shown to visitors or baked into the image.

See `Dockerfile` and `server.mjs` for how the three apps are built (each from a pinned upstream
commit) and proxied.
