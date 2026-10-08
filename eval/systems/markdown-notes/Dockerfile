# markdown-notes 0.23.2 shim image. Build from eval/systems:
#   docker build -f markdown-notes/Dockerfile -t shootout/markdown-notes:0.23.2 eval/systems
FROM python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3
COPY --from=ghcr.io/astral-sh/uv:0.12.3@sha256:2d890623d310b57771ce840f0da5eed5fc6d657da05ffaa45d82797b53fa3abc /uv /usr/local/bin/uv

ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_COMPILE_BYTECODE=1 \
    PATH=/app/markdown-notes/.venv/bin:$PATH \
    FASTEMBED_CACHE_PATH=/opt/fastembed

WORKDIR /app/markdown-notes
COPY markdown-notes/pyproject.toml markdown-notes/uv.lock ./
RUN uv sync --frozen --no-dev && bm --version

# Bake the recipe's local embedder into the image; at run time the container has no route to Hugging Face.
RUN BASIC_MEMORY_CONFIG_DIR=/tmp/bm-build python -c "import asyncio; \
from basic_memory.config import ConfigManager; \
from basic_memory.repository.embedding_provider_factory import create_embedding_provider; \
p = create_embedding_provider(ConfigManager().config); \
print(type(p).__name__, len(asyncio.run(p.embed_query('warm up'))))" \
    && rm -rf /tmp/bm-build \
    && test "$(cat /opt/fastembed/models--qdrant--bge-small-en-v1.5-onnx-q/refs/main)" = aa8f8b060edb00e03bfdd08813a2949946c8ba55

COPY _shim/shim.py /app/_shim/shim.py
COPY markdown-notes/shim.py markdown-notes/capability.json ./

ENV SHIM_PORT=8700 SHIM_CONFIG=recipe SHIM_DATA_DIR=/data \
    BASIC_MEMORY_INDEX_CHANGES=false \
    BASIC_MEMORY_NO_PROMOS=1 BASIC_MEMORY_AUTO_UPDATE=false \
    BASIC_MEMORY_LOGFIRE_ENABLED=false BASIC_MEMORY_LOGFIRE_SEND_TO_LOGFIRE=false \
    LITELLM_LOCAL_MODEL_COST_MAP=True LITELLM_TELEMETRY=False \
    HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1
VOLUME /data
EXPOSE 8700
CMD ["python", "shim.py"]
