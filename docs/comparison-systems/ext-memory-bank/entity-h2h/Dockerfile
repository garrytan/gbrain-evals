# Shim image for Hindsight, entity-h2h configuration: hindsight-client 1.2.1 from this directory's lock, the pinned
# adapter (../shim.py) unchanged, plus entity_h2h.py (GET /entities). The server runs unmodified from the vendor image.
# Build context is the repository root:
#   docker build -f docs/comparison-systems/ext-memory-bank/entity-h2h/Dockerfile .
FROM ghcr.io/astral-sh/uv:0.9.5@sha256:f459f6f73a8c4ef5d69f4e6fbbdb8af751d6fa40ec34b39a1ab469acd6e289b7 AS uv
FROM python:3.12-slim@sha256:02108f5d322dd89f1c9e552442c25acb0543dfdbc455693a5599624f20d9155d
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PROJECT_ENVIRONMENT=/app/venv UV_PYTHON_DOWNLOADS=never UV_COMPILE_BYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app/hindsight
COPY docs/comparison-systems/ext-memory-bank/entity-h2h/pyproject.toml docs/comparison-systems/ext-memory-bank/entity-h2h/uv.lock ./
RUN uv sync --locked --no-install-project --no-dev && /app/venv/bin/python -c "import importlib.metadata as m; assert m.version('hindsight-client') == '1.2.1'"
COPY eval/systems/_shim/shim.py /app/_shim/shim.py
COPY docs/comparison-systems/ext-memory-bank/shim.py ./hindsight_shim.py
COPY docs/comparison-systems/ext-memory-bank/entity-h2h/entity_h2h.py docs/comparison-systems/ext-memory-bank/entity-h2h/capability.json ./
USER nobody
EXPOSE 8700
CMD ["/app/venv/bin/python", "entity_h2h.py"]
