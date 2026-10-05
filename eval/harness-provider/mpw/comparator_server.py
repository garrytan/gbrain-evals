"""Install, start and stop the comparator's pinned current release.

The harness lock pins an older comparator server inside the harness venv (a
protobuf conflict keeps it there). The benchmark runs the comparator's
current release instead, as a separate server process:

  - `ensure_installed()` builds `.harness/comparator/<version>/venv` from
    `comparator.lock.json`: every requirement pinned by exact version and
    sha256, torch from the CPU wheel index, the local embedding and reranker
    weights fetched at pinned revisions into `.harness/comparator/<version>/hf`.
    The comparator's own package names are stored as `{key}-...` templates and
    filled from the harness registry key at runtime (see `names.py`).
  - `ComparatorServer` starts the server on a free loopback port with a clean
    environment, an isolated HOME (its embedded Postgres lives there) under
    the cell directory, Hugging Face offline, `.env` loading disabled, and its
    LLM pointed at a loopback base URL (the metering proxy, or a test stub).
    `stop()` terminates the process group, then reaps anything still running
    from the isolated HOME (the embedded Postgres runs in its own session and
    survives a SIGKILL of the server).

  python -m mpw.comparator_server install     install (idempotent) and print the paths
  python -m mpw.comparator_server check       exit 1 unless the install matches the lock
  python -m mpw.comparator_server describe    print the resolved configuration
  python -m mpw.comparator_server lock --version X.Y.Z
                                              regenerate comparator.lock.json (maintainers)
"""
from __future__ import annotations

import atexit
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from . import names

PROVIDER_DIR = Path(__file__).resolve().parents[1]
LOCK_PATH = PROVIDER_DIR / "comparator.lock.json"
REPO_ROOT = Path(os.environ.get("MPW_REPO_ROOT") or PROVIDER_DIR.parents[1]).resolve()
HARNESS_HOME = REPO_ROOT / ".harness"

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
PG_INSTANCE = "mpw"


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def fill(template: str) -> str:
    """Replace `{key}` / `{KEY}` with the comparator's registry key."""
    key = names.comparator_key()
    return template.replace("{key}", key).replace("{KEY}", key.upper().replace("-", "_"))


def env_prefix() -> str:
    return fill(read_lock()[0]["server"]["env_prefix"])


def read_lock(path: Path = LOCK_PATH) -> tuple[dict, str]:
    data = path.read_bytes()
    lock = json.loads(data)
    if lock.get("format") != "gbrain-evals-comparator-lock" or lock.get("schema_version") != 1:
        raise RuntimeError(f"{path} is not a schema 1 comparator lock")
    return lock, hashlib.sha256(data).hexdigest()


# ── Install ──────────────────────────────────────────────────────────────────


@dataclass
class Install:
    version: str
    lock_sha256: str
    home: Path
    venv: Path
    python: Path
    console_script: Path
    hf_home: Path
    models: dict
    defaults: dict
    torch_version: str
    install_seconds: float


def install_home(version: str) -> Path:
    return HARNESS_HOME / "comparator" / version


def render_requirements(lock: dict) -> str:
    lines = []
    for req in lock["requirements"]:
        spec = f"{fill(req['name'])}=={req['version']}"
        if req.get("marker"):
            spec += f" ; {req['marker']}"
        lines.append(" \\\n    ".join([spec] + [f"--hash=sha256:{h}" for h in req["hashes"]]))
    return "\n".join(lines) + "\n"


def _run(cmd: list[str], env: dict | None = None, cwd: Path | None = None) -> str:
    proc = subprocess.run(cmd, env={**os.environ, **(env or {})}, cwd=cwd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"{' '.join(map(str, cmd))} failed (exit {proc.returncode}): {proc.stderr[-3000:]}")
    return proc.stdout


_DEFAULTS_PROBE = """
import json, sys
cfg = __import__(sys.argv[1] + ".config", fromlist=["config"])
provider = cfg.DEFAULT_LLM_PROVIDER
print(json.dumps({
    "llm_provider": provider,
    "llm_model": cfg.PROVIDER_DEFAULT_MODELS.get(provider, cfg.DEFAULT_LLM_MODEL),
    "embeddings_provider": cfg.DEFAULT_EMBEDDINGS_PROVIDER,
    "embeddings_local_model": cfg.DEFAULT_EMBEDDINGS_LOCAL_MODEL,
    "reranker_provider": cfg.DEFAULT_RERANKER_PROVIDER,
    "reranker_local_model": cfg.DEFAULT_RERANKER_LOCAL_MODEL,
    "database_url": cfg.DEFAULT_DATABASE_URL,
    "retain_chunk_size": cfg.DEFAULT_RETAIN_CHUNK_SIZE,
    "retain_extraction_mode": cfg.DEFAULT_RETAIN_EXTRACTION_MODE,
    "retain_extract_causal_links": cfg.DEFAULT_RETAIN_EXTRACT_CAUSAL_LINKS,
    "enable_observations": cfg.DEFAULT_ENABLE_OBSERVATIONS,
    "tokenizer_encoding": getattr(cfg, "DEFAULT_TOKENIZER_ENCODING", None),
}))
"""

_FETCH_MODELS = """
import json, sys
from pathlib import Path
from huggingface_hub import snapshot_download
models, hub = json.loads(sys.argv[1]), Path(sys.argv[2])
for m in models.values():
    path = Path(snapshot_download(repo_id=m["repo"], revision=m["revision"], allow_patterns=m["files"]))
    missing = [f for f in m["files"] if not (path / f).exists()]
    if missing:
        raise SystemExit(f"{m['repo']}@{m['revision']}: missing {missing}")
    refs = hub / ("models--" + m["repo"].replace("/", "--")) / "refs"
    refs.mkdir(parents=True, exist_ok=True)
    (refs / "main").write_text(m["revision"])
"""


def _probe_defaults(python: Path, module: str) -> dict:
    return json.loads(_run([str(python), "-c", _DEFAULTS_PROBE, module], env={"PYTHON_DOTENV_DISABLED": "1"}))


def ensure_installed(log=lambda line: print(line, file=sys.stderr), check_only: bool = False) -> Install:
    lock, lock_sha = read_lock()
    version = lock["version"]
    home = install_home(version)
    venv = home / "venv"
    python = venv / "bin" / "python"
    hf_home = home / "hf"
    ready_path = home / "ready.json"

    def result(ready: dict) -> Install:
        return Install(
            version=version, lock_sha256=lock_sha, home=home, venv=venv, python=python,
            console_script=venv / "bin" / fill(lock["server"]["console_script"]), hf_home=hf_home,
            models=lock["models"], defaults=ready["defaults"], torch_version=ready["torch_version"],
            install_seconds=ready["install_seconds"],
        )

    if ready_path.exists():
        ready = json.loads(ready_path.read_text())
        if ready.get("lock_sha256") == lock_sha and python.exists():
            return result(ready)
    if check_only:
        raise RuntimeError(
            f"the comparator {version} server is not installed for this lock; run "
            "`python -m mpw.comparator_server install` from the harness venv (or `bun run harness:comparator`)"
        )
    if shutil.which("uv") is None:
        raise RuntimeError("uv is required to install the comparator server (https://docs.astral.sh/uv/)")

    started = time.monotonic()
    log(f"[comparator] installing the pinned {version} server into {venv} (CPU wheels, hash-checked)")
    shutil.rmtree(venv, ignore_errors=True)
    home.mkdir(parents=True, exist_ok=True)
    req_path = home / "requirements.lock.txt"
    req_path.write_text(render_requirements(lock))
    _run(["uv", "venv", "-q", "--allow-existing", "-p", lock["python"], str(venv)])
    _run(
        ["uv", "pip", "install", "-q", "--require-hashes", "--no-deps", "--torch-backend", lock["torch_backend"], "-r", str(req_path)],
        env={"VIRTUAL_ENV": str(venv), "UV_PYTHON": str(python)},
    )
    module = fill(lock["server"]["module"])
    installed = _run([str(python), "-c", f"import importlib.metadata as m; print(m.version({fill(lock['server']['package'])!r}))"]).strip()
    if installed != version:
        raise RuntimeError(f"installed comparator server is {installed}, the lock says {version}")
    torch = _run([str(python), "-c", "import torch; print(torch.__version__)"]).strip()
    if sys.platform != "darwin" and not torch.endswith("+cpu"):
        raise RuntimeError(f"torch installed as {torch}, expected a +cpu build")
    defaults = _probe_defaults(python, module)
    for role, key in (("embeddings", "embeddings_local_model"), ("reranker", "reranker_local_model")):
        if lock["models"][role]["repo"] != defaults[key]:
            raise RuntimeError(
                f"the lock pins {role} model {lock['models'][role]['repo']} but the {version} server defaults to "
                f"{defaults[key]}; regenerate comparator.lock.json"
            )
    log(f"[comparator] fetching pinned local model weights into {hf_home}")
    _run([str(python), "-c", _FETCH_MODELS, json.dumps(lock["models"]), str(hf_home / "hub")],
         env={"HF_HOME": str(hf_home), "HF_HUB_DISABLE_TELEMETRY": "1"})
    ready = {
        "lock_sha256": lock_sha,
        "version": version,
        "torch_version": torch,
        "defaults": defaults,
        "install_seconds": round(time.monotonic() - started, 1),
        "installed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    ready_path.write_text(json.dumps(ready, indent=2) + "\n")
    log(f"[comparator] installed in {ready['install_seconds']}s")
    return result(ready)


# ── Upstream and environment ────────────────────────────────────────────────

# Child env names the metering proxy hands out, per upstream provider
# (CONTRACTS.md table). The launcher passes the comparator label's values to
# the harness process with an `MPW_COMPARATOR_` prefix.
UPSTREAM_ENV = {"openai": ("OPENAI_BASE_URL", "OPENAI_API_KEY")}


@dataclass
class Upstream:
    """Where the comparator's LLM calls go. `base_url` must be loopback."""
    provider: str
    base_url: str
    api_key: str
    model: str | None = None

    def __post_init__(self):
        host = urlparse(self.base_url).hostname
        if host not in LOOPBACK_HOSTS:
            raise RuntimeError(
                f"the comparator's LLM base URL {self.base_url} is not loopback; every model request "
                "must go through the local metering proxy (or a test stub)"
            )


def upstream_from_env(env: dict | None = None, provider: str = "openai", model: str | None = None) -> Upstream:
    env = os.environ if env is None else env
    if provider not in UPSTREAM_ENV:
        raise RuntimeError(f"comparator LLM provider {provider!r} has no metering-proxy route here; supported: {sorted(UPSTREAM_ENV)}")
    base_name, key_name = (f"MPW_COMPARATOR_{n}" for n in UPSTREAM_ENV[provider])
    missing = [n for n in (base_name, key_name) if not env.get(n)]
    if missing:
        raise RuntimeError(
            f"{', '.join(missing)} not set: the launcher must pass the metering proxy's base URL and the "
            "comparator label's proxy token so the comparator's LLM calls are metered"
        )
    return Upstream(provider=provider, base_url=env[base_name], api_key=env[key_name], model=model)


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def server_env(install: Install, home: Path, port: int, pg_port: int, upstream: Upstream) -> dict[str, str]:
    p = env_prefix()
    model = upstream.model or (install.defaults["llm_model"] if upstream.provider == install.defaults["llm_provider"] else None)
    if not model:
        raise RuntimeError(f"no extraction model given for provider {upstream.provider!r} and it is not the server's default provider")
    env = {
        "PATH": f"{install.venv / 'bin'}:/usr/bin:/bin",
        "HOME": str(home),
        "TMPDIR": str(home / "tmp"),
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "VIRTUAL_ENV": str(install.venv),
        "PYTHONUNBUFFERED": "1",
        "PYTHON_DOTENV_DISABLED": "1",
        "HF_HOME": str(install.hf_home),
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "TOKENIZERS_PARALLELISM": "false",
        p + "HOST": "127.0.0.1",
        p + "PORT": str(port),
        p + "DATABASE_URL": f"pg0://{PG_INSTANCE}:{pg_port}",
        p + "LLM_PROVIDER": upstream.provider,
        p + "LLM_MODEL": model,
        p + "LLM_BASE_URL": upstream.base_url,
        p + "LLM_API_KEY": upstream.api_key,
        p + "SKIP_LLM_VERIFICATION": "true",
        p + "EMBEDDINGS_PROVIDER": "local",
        p + "EMBEDDINGS_LOCAL_MODEL": install.models["embeddings"]["repo"],
        p + "EMBEDDINGS_LOCAL_FORCE_CPU": "true",
        p + "RERANKER_PROVIDER": "local",
        p + "RERANKER_LOCAL_MODEL": install.models["reranker"]["repo"],
        p + "RERANKER_LOCAL_FORCE_CPU": "true",
        p + "OTEL_TRACES_ENABLED": "false",
    }
    return env


def describe(install: Install, upstream: Upstream | None = None) -> dict:
    """What the server calls and who pays for it. Goes into cell receipts."""
    d = install.defaults
    llm = {
        "provider": upstream.provider if upstream else d["llm_provider"],
        "model": (upstream.model if upstream and upstream.model else d["llm_model"]),
        "model_source": "explicit" if upstream and upstream.model else "server default",
        "base_url": upstream.base_url if upstream else None,
        "operations": ["fact extraction (retain)", "consolidation when observations are on", "reflect (agent mode)"],
    }
    return {
        "version": install.version,
        "lock_sha256": install.lock_sha256,
        "torch": install.torch_version,
        "install_seconds": install.install_seconds,
        "metered": [{"what": "LLM", **llm}],
        "local_compute": [
            {"what": "embeddings", "model": f"{install.models['embeddings']['repo']}@{install.models['embeddings']['revision']}", "device": "cpu"},
            {"what": "reranker", "model": f"{install.models['reranker']['repo']}@{install.models['reranker']['revision']}", "device": "cpu"},
            {"what": "database", "engine": "embedded PostgreSQL", "location": "isolated HOME under the cell directory"},
        ],
        "unmetered": [],
        "defaults": d,
    }


# ── Process lifecycle ───────────────────────────────────────────────────────


def _set_pdeathsig() -> None:
    """Ask Linux to SIGTERM the server if its parent dies (PR_SET_PDEATHSIG).

    The signal follows the forking thread, so `start()` only uses this from the
    main thread; elsewhere atexit and `stop()` do the reaping."""
    if sys.platform.startswith("linux"):
        import ctypes

        ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG


def processes_under(root: Path) -> list[int]:
    """Pids (not ours) whose command line names a path under `root`."""
    needle = str(root)
    me = os.getpid()
    if Path("/proc/self/cmdline").exists():
        commands = []
        for entry in Path("/proc").iterdir():
            if entry.name.isdigit():
                try:
                    commands.append((int(entry.name), (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")))
                except OSError:
                    pass
    else:
        out = subprocess.run(["ps", "-axww", "-o", "pid=,command="], capture_output=True, text=True).stdout
        commands = [(int(p), c) for p, _, c in (line.strip().partition(" ") for line in out.splitlines()) if p.isdigit()]
    return [pid for pid, cmd in commands if pid != me and needle in cmd]


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def reap_under(root: Path, grace_s: float = 10.0) -> list[int]:
    """SIGTERM, then SIGKILL, every process running from under `root`."""
    pids = processes_under(root)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + grace_s
    while time.monotonic() < deadline and any(_alive(p) for p in pids):
        time.sleep(0.2)
    for pid in pids:
        if _alive(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    return pids


@dataclass
class ComparatorServer:
    """One pinned comparator server with its own data directory."""
    data_dir: Path
    upstream: Upstream
    install: Install | None = None
    startup_timeout_s: float = 600.0
    stop_grace_s: float = 30.0
    port: int | None = None
    proc: subprocess.Popen | None = field(default=None, init=False)
    reaped: list[int] = field(default_factory=list, init=False)

    @property
    def home(self) -> Path:
        return Path(self.data_dir).resolve() / "home"

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def log_path(self) -> Path:
        return Path(self.data_dir).resolve() / "server.log"

    def start(self) -> "ComparatorServer":
        import httpx

        self.install = self.install or ensure_installed()
        (self.home / "tmp").mkdir(parents=True, exist_ok=True)
        self.reaped += reap_under(self.home)
        self.port = self.port or free_port()
        env = server_env(self.install, self.home, self.port, free_port(), self.upstream)
        log = open(self.log_path, "ab")
        try:
            self.proc = subprocess.Popen(
                [str(self.install.console_script), "--host", "127.0.0.1", "--port", str(self.port), "--no-access-log"],
                env=env, cwd=self.home, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                start_new_session=True,
                preexec_fn=_set_pdeathsig if threading.current_thread() is threading.main_thread() else None,
            )
        finally:
            log.close()
        atexit.register(self.stop)
        try:
            self._wait_healthy(httpx)
            self._check_version(httpx)
        except BaseException:
            self.stop()
            raise
        return self

    def _log_tail(self, n: int = 40) -> str:
        try:
            return "\n".join(self.log_path.read_text(errors="replace").splitlines()[-n:])
        except OSError:
            return ""

    def _wait_healthy(self, httpx) -> None:
        deadline = time.monotonic() + self.startup_timeout_s
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"comparator server exited with {self.proc.returncode} during startup:\n{self._log_tail()}")
            try:
                r = httpx.get(f"{self.url}/health", timeout=5)
                if r.status_code == 200 and r.json().get("status") == "healthy":
                    return
            except (httpx.HTTPError, ValueError):
                pass
            time.sleep(0.5)
        raise RuntimeError(f"comparator server not healthy after {self.startup_timeout_s}s:\n{self._log_tail()}")

    def _check_version(self, httpx) -> None:
        got = httpx.get(f"{self.url}/openapi.json", timeout=30).json()["info"]["version"]
        if got != self.install.version:
            raise RuntimeError(f"comparator server reports version {got}, the lock pins {self.install.version}")

    def stop(self) -> None:
        proc, self.proc = self.proc, None
        if proc is not None:
            if proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    proc.wait(self.stop_grace_s)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    proc.wait(30)
            atexit.unregister(self.stop)
        self.reaped += reap_under(self.home)

    def describe(self) -> dict:
        return {**describe(self.install, self.upstream), "url": self.url, "data_dir": str(Path(self.data_dir).resolve())}

    def __enter__(self) -> "ComparatorServer":
        return self.start()

    def __exit__(self, *_exc) -> None:
        self.stop()


# ── Lock generation (maintainers) ───────────────────────────────────────────

_PLATFORMS = re.compile(r"^(any|manylinux\w*_(x86_64|aarch64)|linux_(x86_64|aarch64)|macosx_\d+_\d+_(arm64|universal2))$")
_MODEL_WEIGHT_SKIP = (".bin", ".h5", ".msgpack", ".ot", ".onnx", ".pt", ".gguf")


def wheel_supported(filename: str, py: str = "3.12") -> bool:
    """Keep wheels for CPython `py` on Linux x86_64/aarch64 and macOS arm64."""
    parts = filename[:-len(".whl")].split("-")
    py_tags, abi, plats = parts[-3].split("."), parts[-2], parts[-1].split(".")
    cp = "cp" + py.replace(".", "")
    minor = int(py.split(".")[1])

    def py_ok(tag: str) -> bool:
        if tag in ("py3", f"py{py.replace('.', '')}") or tag == cp:
            return True
        return abi == "abi3" and tag.startswith("cp3") and int(tag[3:] or 0) <= minor

    return any(py_ok(t) for t in py_tags) and abi in ("none", "abi3", cp) and any(_PLATFORMS.match(p) for p in plats)


def _template_name(name: str, key: str) -> str:
    return "{key}" + name[len(key):] if name == key or name.startswith(key + "-") else name


def build_lock(version: str, models: dict[str, str], python: str = "3.12") -> dict:
    import tomllib

    from huggingface_hub import HfApi

    key = names.comparator_key()
    package = f"{key}-api"
    with tempfile.TemporaryDirectory() as tmp:
        req = Path(tmp) / "in.txt"
        req.write_text(f"{package}=={version}\n")
        out = Path(tmp) / "pylock.toml"
        _run(["uv", "pip", "compile", "-q", "--universal", "--torch-backend", "cpu", "--python-version", python, str(req), "-o", str(out)])
        pylock = tomllib.loads(out.read_text())
        uv_version = _run(["uv", "--version"]).strip()
    requirements = []
    for pkg in pylock["packages"]:
        wheels = [w for w in pkg.get("wheels", []) if wheel_supported(Path(urlparse(w["url"]).path).name, python)]
        hashes = sorted(w["hashes"]["sha256"] for w in wheels)
        if not hashes and pkg.get("sdist"):
            hashes = [pkg["sdist"]["hashes"]["sha256"]]
        if not hashes:
            continue
        entry = {"name": _template_name(pkg["name"], key), "version": pkg["version"], "hashes": hashes}
        if pkg.get("marker"):
            entry["marker"] = pkg["marker"]
        requirements.append(entry)
    api = HfApi()
    model_pins = {}
    for role, repo in models.items():
        info = api.model_info(repo, files_metadata=False)
        files = sorted(
            s.rfilename for s in info.siblings
            if ("/" not in s.rfilename or s.rfilename.startswith("1_Pooling/"))
            and not s.rfilename.endswith(_MODEL_WEIGHT_SKIP) and s.rfilename != ".gitattributes"
        )
        model_pins[role] = {"repo": repo, "revision": info.sha, "files": files}
    return {
        "format": "gbrain-evals-comparator-lock",
        "schema_version": 1,
        "note": (
            "The comparator's current release, run as a separate pinned server. `{key}` is the harness registry "
            "key resolved by mpw/names.py. Hashes cover CPython wheels for Linux x86_64/aarch64 and macOS arm64."
        ),
        "version": version,
        "python": python,
        "torch_backend": "cpu",
        "generated_with": uv_version,
        "server": {
            "package": "{key}-api",
            "package_sha256": _sha(package),
            "module": "{key}_api",
            "console_script": "{key}-api",
            "env_prefix": "{KEY}_API_",
        },
        "models": model_pins,
        "requirements": requirements,
    }


def main(argv: list[str]) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="python -m mpw.comparator_server")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("install")
    sub.add_parser("check")
    sub.add_parser("describe")
    lock_cmd = sub.add_parser("lock")
    lock_cmd.add_argument("--version", required=True)
    lock_cmd.add_argument("--embeddings-model", required=True)
    lock_cmd.add_argument("--reranker-model", required=True)
    args = parser.parse_args(argv)
    if args.cmd == "lock":
        lock = build_lock(args.version, {"embeddings": args.embeddings_model, "reranker": args.reranker_model})
        LOCK_PATH.write_text(json.dumps(lock, indent=1) + "\n")
        print(f"wrote {LOCK_PATH} ({len(lock['requirements'])} requirements)")
        return 0
    install = ensure_installed(check_only=args.cmd == "check")
    if args.cmd == "describe":
        print(json.dumps(describe(install), indent=2))
    else:
        print(json.dumps({"version": install.version, "venv": str(install.venv), "hf_home": str(install.hf_home),
                          "torch": install.torch_version, "lock_sha256": install.lock_sha256,
                          "install_seconds": install.install_seconds}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
