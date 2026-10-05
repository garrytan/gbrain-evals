# Build from eval/systems: docker build -f cognee/Dockerfile -t shootout-cognee .
FROM python:3.12-slim@sha256:02108f5d322dd89f1c9e552442c25acb0543dfdbc455693a5599624f20d9155d
COPY --from=ghcr.io/astral-sh/uv:0.12.3@sha256:2d890623d310b57771ce840f0da5eed5fc6d657da05ffaa45d82797b53fa3abc /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never \
    PATH=/app/cognee/.venv/bin:$PATH \
    TIKTOKEN_CACHE_DIR=/opt/tiktoken
WORKDIR /app/cognee
COPY cognee/pyproject.toml cognee/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project \
 && python -c "import tiktoken; [tiktoken.get_encoding(e) for e in ('cl100k_base', 'o200k_base')]"

COPY _shim/shim.py /app/_shim/shim.py
COPY cognee/shim.py cognee/capability.json /app/cognee/

ENV TELEMETRY_DISABLED=1 \
    LITELLM_LOCAL_MODEL_COST_MAP=True \
    HF_HUB_OFFLINE=1 \
    GRAPH_EXTRACTOR=llm \
    GLINER_AUTO_INSTALL=false \
    LLM_PROVIDER=openai \
    EMBEDDING_PROVIDER=openai \
    DATA_ROOT_DIRECTORY=/data/cognee_data \
    SYSTEM_ROOT_DIRECTORY=/data/cognee_system \
    LOG_LEVEL=WARNING \
    SHIM_PORT=8700
EXPOSE 8700
CMD ["python", "/app/cognee/shim.py"]
