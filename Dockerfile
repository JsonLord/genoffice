# OpenUI Cowork — HF Space image
#
# Combines three independently-built, open-source web apps behind one
# reverse proxy on a single port (HF Docker Spaces expose exactly one):
#
#   /            Casual Docs   (CasualOffice/docs)   — browser .docx editor
#   /slides/*    Casual Slides (CasualOffice/slides)  — browser .pptx editor
#   /chat/*      OpenCode      (sst/opencode)         — AI coding-agent chat,
#                                                        embedded as a sidebar
#                                                        iframe on the Docs page
#
# None of these apps ship as installable packages we can `npm install`, so
# each is built from source at a pinned commit (pins recorded in each git-pin
# RUN step below — bump them deliberately, don't float to a branch tip).
#
# Casual Sheets (CasualOffice/sheets) is deliberately NOT included here: it
# vendors a ~50-package forked rendering engine that needs its own separate
# build pass, documented upstream as OOM-prone even on dedicated CI runners.
# Combined with Docs + Slides + OpenCode in one image it made this build too
# heavy/fragile for the Space's current hardware tier.
#
# See server.mjs for the supervisor that spawns all child servers and proxies
# / rewrites paths between them (none of these apps have native "mount under
# a subpath" support, so the proxy strips path prefixes before forwarding).

FROM node:22

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Bun is only needed to build the Docs SPA (a static build artifact) — not
# used at runtime.
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
ENV PATH="/usr/local/bin:${PATH}"

RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

WORKDIR /build

# Shallow-fetch one pinned commit of a repo into a target directory. GitHub's
# smart-HTTP server allows fetching any reachable commit SHA (not just refs),
# so this stays a single shallow fetch even though we're not pinning a branch
# tip.
RUN printf '%s\n' \
    '#!/bin/sh' \
    'set -e' \
    'url="$1"; dest="$2"; sha="$3"' \
    'mkdir -p "$dest"' \
    'git init -q "$dest"' \
    'git -C "$dest" remote add origin "$url"' \
    'git -C "$dest" fetch -q --depth 1 origin "$sha"' \
    'git -C "$dest" checkout -q FETCH_HEAD' \
    > /usr/local/bin/clone-pin && chmod +x /usr/local/bin/clone-pin

# ── Casual Docs ─────────────────────────────────────────────────────────
# Pins: docs @ d1160518 (2026-09-04), collab @ 9b2a9a2d, design-book @ b75531b8
RUN clone-pin https://github.com/CasualOffice/docs.git \
      /build/docs d11605185698cfc4b16a83a975cfecc8056ac348
RUN clone-pin https://github.com/CasualOffice/collab.git \
      /build/docs/collab 9b2a9a2d4928358efa0d298d14a601915df6a724
RUN clone-pin https://github.com/CasualOffice/design-book.git \
      /build/docs/docx-editor/vendor/design-system b75531b8fb5e683f4606728167fb1e878b96cfe4

WORKDIR /build/docs/docx-editor
ENV VITE_COLLAB_ENABLED=true
RUN bun install --frozen-lockfile
RUN bun run build && bun run build:demo

WORKDIR /build/docs/collab
RUN npm install --omit=dev

# Runtime layout the collab server expects: it resolves the served SPA as
# `<this file's dir>/../../web/dist` — i.e. /app/docs/web/dist when the
# server itself lives at /app/docs/collab/src.
RUN mkdir -p /app/docs/web /app/docs/collab /app/docs/web/dist
RUN cp -a /build/docs/collab/. /app/docs/collab/
RUN cp -a /build/docs/docx-editor/examples/vite/dist/. /app/docs/web/dist/

# ── Casual Slides ───────────────────────────────────────────────────────
# Pins: slides @ 2762698e (2026-09-04), design-book @ b75531b8, univer-revamp @ 379769f7
RUN clone-pin https://github.com/CasualOffice/slides.git \
      /build/slides 2762698ebbc2e2986ef2103798bdd21187182de2
RUN clone-pin https://github.com/CasualOffice/design-book.git \
      /build/slides/design-book b75531b8fb5e683f4606728167fb1e878b96cfe4
RUN clone-pin https://github.com/CasualOffice/univer-revamp.git \
      /build/slides/univer-revamp 379769f723510452ee27efd624e40a3f68923a54

WORKDIR /build/slides
RUN pnpm install --no-frozen-lockfile
# Built at /slides/, not /: this image mounts Slides under a subpath behind
# the proxy (see server.mjs), so the SPA's own asset/script URLs need to
# carry that prefix. Collab (multiplayer) is left off for this deploy — its
# WebSocket client hardcodes a root-relative URL with no subpath awareness,
# which would collide with Docs' own /yjs socket once both are proxied from
# one origin.
ENV VITE_COLLAB_ENABLED=false
ENV PAGES_BASE=/slides/
RUN pnpm --filter @point/web build
RUN mkdir -p /app/slides/apps/web/dist /app/slides/apps/server
RUN cp -a /build/slides/apps/server/. /app/slides/apps/server/
RUN cp -a /build/slides/apps/web/dist/. /app/slides/apps/web/dist/
WORKDIR /app/slides/apps/server
RUN npm install --omit=dev

# ── OpenCode (AI coding-agent chat) ─────────────────────────────────────
RUN npm install -g opencode-ai@1.18.27

# ── Supervisor / reverse proxy ───────────────────────────────────────────
WORKDIR /app
RUN npm install --no-save http-proxy@1.18.1
COPY server.mjs ./

ENV PORT=7860
EXPOSE 7860

CMD ["node", "server.mjs"]
