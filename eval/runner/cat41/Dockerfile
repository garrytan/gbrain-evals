# Cat 41 harness image: pinned agent CLIs, pinned Bun, no gbrain.
# The gbrain build under test and the in-container driver are mounted read-only
# at run time (/opt/gbrain, /opt/cat41), so one image serves every build.
FROM node:24.18.0-bookworm-slim

ARG BUN_VERSION=1.4.2
ARG CLAUDE_CODE_VERSION=2.1.285
ARG CODEX_VERSION=0.160.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git unzip procps ripgrep jq python3 less util-linux \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" \
 && ln -sf /usr/local/bin/bun /usr/local/bin/bunx && bun --version

RUN npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && claude --version && codex --version

RUN useradd -m -s /bin/bash -u 2000 agent

LABEL org.gbrain-evals.cat41.bun="${BUN_VERSION}" \
      org.gbrain-evals.cat41.claude-code="${CLAUDE_CODE_VERSION}" \
      org.gbrain-evals.cat41.codex="${CODEX_VERSION}"
