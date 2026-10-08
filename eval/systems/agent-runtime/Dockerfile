# Build from eval/systems: docker build -f agent-runtime/Dockerfile -t shootout-agent-runtime .
# The vendor image is agent-runtime 0.34.4 (Node); it ships python3 3.11, which runs the stdlib shim.
FROM letta/letta:0.34.4@sha256:8ee7fb697e7f08b121a487b48315d45c64b195c12418264b091371c9e8ab3a5c

COPY _shim/shim.py /app/_shim/shim.py
COPY agent-runtime/shim.py agent-runtime/capability.json /app/agent-runtime/

ENV LETTA_CODE_TELEM=0 \
    DO_NOT_TRACK=1 \
    DISABLE_AUTOUPDATER=1 \
    LETTA_LOCAL_BACKEND_EXPERIMENTAL=1 \
    SHIM_PORT=8700 \
    LETTA_APP_SERVER_PORT=4500 \
    LETTA_WS_TOKEN_FILE=/run/agent-runtime/token
WORKDIR /workspace
EXPOSE 8700 4500
CMD ["python3", "/app/agent-runtime/shim.py"]
