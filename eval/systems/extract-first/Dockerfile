# extract-first OSS 2.2.1 shim image. Build from eval/systems:
#   docker build -f extract-first/Dockerfile -t shootout/extract-first:2.2.1 eval/systems
FROM python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3
COPY --from=ghcr.io/astral-sh/uv:0.12.3@sha256:2d890623d310b57771ce840f0da5eed5fc6d657da05ffaa45d82797b53fa3abc /uv /usr/local/bin/uv

ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_COMPILE_BYTECODE=1 \
    PATH=/app/extract-first/.venv/bin:$PATH \
    FASTEMBED_CACHE_PATH=/opt/fastembed

WORKDIR /app/extract-first
COPY extract-first/pyproject.toml extract-first/uv.lock ./
RUN uv sync --frozen --no-dev

# Bake the BM25 sparse encoder (Qdrant/bm25) that extract-first's Qdrant backend loads, and check the spaCy model loads;
# at run time the container has no route to Hugging Face. fastembed 0.8.1's offline path insists that every file in
# its Qdrant/bm25 description exists, and two never existed upstream (mock.file and tamil.txt), so they are created
# empty; only english.txt is read for English text. huggingface_hub refuses an offline load from a partial snapshot,
# so the whole (small) repository is fetched at the pinned commit. The build then loads it offline as the shim does.
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('Qdrant/bm25', cache_dir='/opt/fastembed')" \
    && test "$(cat /opt/fastembed/models--Qdrant--bm25/refs/main)" = 22b8d2af71a76161e18dd432d2cee0eefa66e412 \
    && python -c "import pathlib, fastembed.sparse.bm25 as b; \
d = next(m for m in b.supported_bm25_models if m.model == 'Qdrant/bm25'); \
root = pathlib.Path('/opt/fastembed/models--Qdrant--bm25/snapshots/22b8d2af71a76161e18dd432d2cee0eefa66e412'); \
made = [f for f in [d.model_file, *d.additional_files] if not (root / f).exists()]; \
[(root / f).touch() for f in made]; print('placeholders', made)" \
    && HF_HUB_OFFLINE=1 python -c "import spacy; spacy.load('en_core_web_sm'); \
from fastembed import SparseTextEmbedding; \
print('bm25 offline ok', len(list(SparseTextEmbedding(model_name='Qdrant/bm25').embed(['warm up']))))"

COPY _shim/shim.py /app/_shim/shim.py
COPY extract-first/shim.py extract-first/capability.json ./

ENV SHIM_PORT=8700 SHIM_CONFIG=recipe SHIM_DATA_DIR=/data MEM0_DIR=/data/extract-first \
    MEM0_TELEMETRY=false HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 \
    QDRANT_HOST=qdrant QDRANT_PORT=6333 MEM0_CHUNK_TURNS=2
VOLUME /data
EXPOSE 8700
CMD ["python", "shim.py"]
