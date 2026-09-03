FROM node:22-slim

# Install system dependencies and latest Rust toolchain
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    build-essential \
    python3 \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Rust toolchain via rustup (supports 2024 edition)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /app

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

# Copy full source codebase
COPY . .

# Install dependencies and build all workspaces
RUN npm install --ignore-scripts
RUN npm run build:all

ENV PORT=7860
EXPOSE 7860

CMD ["node", "server.mjs"]
