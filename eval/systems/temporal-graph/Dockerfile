# Shim image for temporal-graph: graphiti-core 0.30.2 runs in this process; Neo4j runs from its own pinned image.
# Build context is eval/systems so the shared shim base is copied in: docker build -f temporal-graph/Dockerfile ..
FROM ghcr.io/astral-sh/uv:0.9.5@sha256:f459f6f73a8c4ef5d69f4e6fbbdb8af751d6fa40ec34b39a1ab469acd6e289b7 AS uv
FROM python:3.12-slim@sha256:02108f5d322dd89f1c9e552442c25acb0543dfdbc455693a5599624f20d9155d
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PROJECT_ENVIRONMENT=/app/venv UV_PYTHON_DOWNLOADS=never UV_COMPILE_BYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app/temporal-graph
COPY temporal-graph/pyproject.toml temporal-graph/uv.lock ./
RUN uv sync --locked --no-install-project --no-dev && /app/venv/bin/python -c "import importlib.metadata as m; assert m.version('graphiti-core') == '0.30.2'"
COPY _shim/shim.py /app/_shim/shim.py
COPY temporal-graph/shim.py temporal-graph/capability.json ./
USER nobody
EXPOSE 8700
CMD ["/app/venv/bin/python", "shim.py"]
