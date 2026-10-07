# gbrain-defaults: gbrain at a frozen commit, installed the documented way, behind the shim protocol.
# Build context is the repository root (the shared shim base is copied in):
#   docker build -f eval/systems/gbrain-defaults/Dockerfile --build-arg GBRAIN_SHA=<sha> .
# Bun >= 1.4.0 (gbrain's engines floor) lives in this image only; the harness host keeps its own Bun.
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS bun
FROM python:3.12-slim@sha256:02108f5d322dd89f1c9e552442c25acb0543dfdbc455693a5599624f20d9155d
ARG GBRAIN_SHA=c5fb0201d1960a0a5a81c35d77718311b03154b7
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ENV BUN_INSTALL=/opt/bun PATH=/opt/bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin PYTHONUNBUFFERED=1 GBRAIN_SHA=${GBRAIN_SHA}
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
 && bun install -g "github:garrytan/gbrain#${GBRAIN_SHA}" \
 && gbrain --version \
 && useradd --uid 10001 --create-home --shell /usr/sbin/nologin gbrain \
 && mkdir -p /data /app/_shim /app/gbrain-defaults && chown gbrain:gbrain /data
COPY eval/systems/_shim/shim.py /app/_shim/shim.py
COPY eval/systems/gbrain-defaults/shim.py eval/systems/gbrain-defaults/capability.json /app/gbrain-defaults/
USER gbrain
VOLUME /data
EXPOSE 8700
WORKDIR /app/gbrain-defaults
CMD ["python3", "shim.py"]
