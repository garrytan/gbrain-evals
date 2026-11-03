# Shim image for Graphiti graphiti-core 0.31.2 with its shipped defaults (SHIM_CONFIG=shipped-0.31); Neo4j runs from its own pinned image.
# The adapter is the pinned bundle's ../shim.py, unchanged, copied in as graphiti_shim.py; shipped.py only replaces how
# the Graphiti instance is built. Build context is the repository root:
#   docker build -f docs/comparison-systems/ext-temporal-graph/shipped-0.31/Dockerfile .
FROM ghcr.io/astral-sh/uv:0.9.5@sha256:f459f6f73a8c4ef5d69f4e6fbbdb8af751d6fa40ec34b39a1ab469acd6e289b7 AS uv
FROM python:3.12-slim@sha256:02108f5d322dd89f1c9e552442c25acb0543dfdbc455693a5599624f20d9155d
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PROJECT_ENVIRONMENT=/app/venv UV_PYTHON_DOWNLOADS=never UV_COMPILE_BYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app/graphiti
COPY docs/comparison-systems/ext-temporal-graph/shipped-0.31/pyproject.toml docs/comparison-systems/ext-temporal-graph/shipped-0.31/uv.lock ./
RUN uv sync --locked --no-install-project --no-dev && /app/venv/bin/python -c "import importlib.metadata as m; assert m.version('graphiti-core') == '0.31.2'"
COPY eval/systems/_shim/shim.py /app/_shim/shim.py
COPY docs/comparison-systems/ext-temporal-graph/shim.py ./graphiti_shim.py
COPY docs/comparison-systems/ext-temporal-graph/shipped-0.31/shipped.py docs/comparison-systems/ext-temporal-graph/shipped-0.31/capability.json ./
USER nobody
EXPOSE 8700
CMD ["/app/venv/bin/python", "shipped.py"]
