# MemPalace 3.10.0 shim image (raw and hybrid modes, LLM rerank off). Build from the repository root:
#   docker build -f docs/comparison-systems/ext-verbatim-session/Dockerfile -t shootout/mempalace:3.10.0 .
FROM python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3
COPY --from=ghcr.io/astral-sh/uv:0.12.3@sha256:2d890623d310b57771ce840f0da5eed5fc6d657da05ffaa45d82797b53fa3abc /uv /usr/local/bin/uv

ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_COMPILE_BYTECODE=1 \
    PATH=/app/mempalace/.venv/bin:$PATH \
    ANONYMIZED_TELEMETRY=False

WORKDIR /app/mempalace
COPY docs/comparison-systems/ext-verbatim-session/pyproject.toml docs/comparison-systems/ext-verbatim-session/uv.lock ./
RUN uv sync --frozen --no-dev && python -c "import mempalace.version as v; assert v.__version__ == '3.10.0', v.__version__"

# The vendor's LoCoMo benchmark script at the pinned commit; the shim imports its corpus and scoring helpers.
RUN mkdir vendor && python -c "import hashlib, urllib.request; \
url = 'https://raw.githubusercontent.com/MemPalace/mempalace/22fd87f09c19d5ffb2d6966486483353937931c0/benchmarks/locomo_bench.py'; \
data = urllib.request.urlopen(url, timeout=60).read(); \
assert hashlib.sha256(data).hexdigest() == 'ba7178748a14bd1c7667f2479d486bf37a8d19e6a8a810b27bd7bc4b40c8aad2'; \
open('vendor/locomo_bench.py', 'wb').write(data)"

# Bake ChromaDB's default embedder (all-MiniLM-L6-v2 ONNX; chromadb checks the archive's sha256 itself) so the
# container needs no network at run time, and check that mempalace's own default `minilm` embedder gives the same
# vector as the ChromaDB default the vendor benchmark uses.
RUN python -c "import numpy as np; \
from chromadb.utils.embedding_functions import DefaultEmbeddingFunction; \
from mempalace.embedding import get_embedding_function; \
a = np.asarray(DefaultEmbeddingFunction()(['warm up the verbatim palace'])[0]); \
b = np.asarray(get_embedding_function(device='cpu', model='minilm')(['warm up the verbatim palace'])[0]); \
cos = float(a @ b / np.linalg.norm(a) / np.linalg.norm(b)); print('dims', a.shape[0], 'cosine', cos); \
assert a.shape[0] == 384 and cos > 0.9999" \
    && test -f /root/.cache/chroma/onnx_models/all-MiniLM-L6-v2/onnx/model.onnx

COPY eval/systems/_shim/shim.py /app/_shim/shim.py
COPY docs/comparison-systems/ext-verbatim-session/shim.py docs/comparison-systems/ext-verbatim-session/capability.json ./

ENV SHIM_PORT=8700 SHIM_CONFIG=recipe SHIM_DATA_DIR=/data \
    HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1
VOLUME /data
EXPOSE 8700
CMD ["python", "shim.py"]
