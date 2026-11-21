/**
 * GBRAIN_F6_EXTRACTION_MODEL in the gbrain-defaults shim (BG1's dev loop, --extraction-model), keyless and without
 * Docker or gbrain: the install sets facts.extraction_model before anything else touches the brain, reads it back and
 * requires `gbrain models --json` to resolve it; every serve start checks the resolution again; the capabilities' f6
 * block records the model; unset, none of this happens. A fake adapter answers gbrain's CLI from memory, the test env
 * holds no provider key, and the proxy base is a dead local port.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const SHIM = `${ROOT}/eval/systems/gbrain-defaults/shim.py`;
const PIN = 'fbf608cf86ea7b2b912ce80151f856a1a47e9533';
const OPUS = 'anthropic:claude-opus-5-5';

const FAKE = `
import importlib.util, json, os, sys, threading, types
spec = importlib.util.spec_from_file_location("gbrain_defaults_shim", SHIM_PATH)
shim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shim)
KEY = "facts.extraction_model"

class Proc:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout, self.returncode, self.stderr = stdout, returncode, stderr

class Fake(shim.GbrainDefaultsAdapter):
    """The adapter with gbrain's CLI in memory: config set/get from a dict, init, models, search modes and doctor canned.
    \`resolves\` is what models --json reports for facts.extraction_model (default: the configured value, else gbrain's
    measured default); \`readback\` overrides config get."""
    def __init__(self, resolves=None, readback=None):
        self.lock = threading.RLock()
        self.active, self.mcp, self.serve_session, self.reference = None, None, None, None
        self.record = {"versions": {}}
        self.config, self.calls, self.receipts_seen = {}, [], []
        self.resolves, self.readback = resolves, readback or {}
    def receipt(self, kind, **f): self.receipts_seen.append(kind)
    def cli(self, *args, timeout_s=600, check=True):
        self.calls.append(list(args))
        if args[:2] == ("config", "set"):
            self.config[args[2]] = args[3]; return Proc()
        if args[:2] == ("config", "get"):
            return Proc(self.readback.get(args[2], self.config.get(args[2], "")) + "\\n")
        if args[0] == "apply-migrations": return Proc()
        if args[0] == "--version": return Proc("gbrain 0.60.753.0\\n")
        raise AssertionError(args)
    def cli_json(self, *args, timeout_s=600):
        self.calls.append(list(args))
        if args[0] == "init": return {"status": "success", "engine": "pglite", "notices": []}
        if args[:2] == ("search", "modes"): return {"active_mode": "balanced", "resolved": {}}
        if args[0] == "models":
            got = self.resolves if self.resolves is not None else self.config.get(KEY, "anthropic:claude-haiku-5-5")
            return {"tiers": {}, "per_task": [{"key": KEY, "resolved": got}]}
        if args[0] == "doctor": return {"checks": [{"name": "connection", "status": "ok", "message": "Connected, 0 pages"}]}
        raise AssertionError(args)
    def capture_tools(self, surface_args):
        self.calls.append(["tools/list"]); return list(shim.STARTER_CALLS)
    def start_mcp(self, surface_args):
        self.calls.append(["serve", *surface_args])
        return types.SimpleNamespace(close=lambda *a: None)
    @staticmethod
    def list_tools(mcp): return list(shim.STARTER_CALLS + shim.FULL_SURFACE_CALLS + shim.F6_CALLS)

def run(code):
    out = {}
    try:
        exec(code, globals(), out)
        print(json.dumps({"ok": out.get("result")}))
    except shim.ShimError as e:
        print(json.dumps({"error": {"kind": e.kind, "message": str(e)}}))
run(sys.argv[1])
`;

/** process.env without any provider or Ubicloud key, so nothing here could authenticate to a provider even by mistake. */
const keyless = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^UBI|_TOKEN$/.test(k)));

/** Run a Python body against the shim in a fresh data directory; the body assigns `result`. */
function shim(body: string, env: Record<string, string> = {}): any {
  const data = mkdtempSync(join(tmpdir(), 'gbrain-xm-'));
  const r = Bun.spawnSync(['python3', '-c', FAKE.replace('SHIM_PATH', JSON.stringify(SHIM)), body], { cwd: ROOT,
    env: { ...keyless(), SHIM_DATA: data, GBRAIN_HOME: join(data, 'home'), GBRAIN_BIN: '/bin/false', GBRAIN_PROXY_BASE: 'http://127.0.0.1:9/gbrain-defaults',
      GBRAIN_F6: '1', GBRAIN_F6_EXTRACT_CAP_USD: '10', GBRAIN_SHA: PIN, GBRAIN_LAUNCH_SHA: PIN, ...env } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString());
}

const SET = { GBRAIN_F6_EXTRACTION_MODEL: OPUS };
const INSTALL = 'f = Fake(RESOLVES, READBACK); m = f.install_brain(); result = {"calls": f.calls, "meta": {k: m.get(k) for k in ("extraction_model", "f6_posture")}, "tasks": m["resolved"]["model_tasks"], "receipts": f.receipts_seen}';
const install = (env: Record<string, string>, resolves = 'None', readback = 'None') => shim(INSTALL.replace('RESOLVES', resolves).replace('READBACK', readback), env);

describe('the install sets facts.extraction_model before the brain is used', () => {
  test('set: config set then config get, after the F6 posture and before models, tools/list and doctor; recorded in the install', () => {
    const r = install(SET).ok;
    const at = (pred: (c: string[]) => boolean) => r.calls.findIndex(pred);
    const set = at((c: string[]) => c[0] === 'config' && c[1] === 'set' && c[2] === 'facts.extraction_model');
    expect(r.calls[set]).toEqual(['config', 'set', 'facts.extraction_model', OPUS]);
    expect(r.calls[set + 1]).toEqual(['config', 'get', 'facts.extraction_model']);
    expect(at((c: string[]) => c[2] === 'facts.default_visibility')).toBeLessThan(set);
    for (const later of ['models', 'tools/list', 'doctor']) expect(at((c: string[]) => c[0] === later)).toBeGreaterThan(set);
    expect(r.meta.extraction_model).toEqual({ key: 'facts.extraction_model', set: OPUS, read_back: OPUS });
    expect(r.tasks['facts.extraction_model']).toBe(OPUS);
    expect(r.receipts).toEqual(['install']);
  });

  test('unset: the install never touches facts.extraction_model and records nothing new', () => {
    const r = install({}).ok;
    expect(r.calls.some((c: string[]) => c.includes('facts.extraction_model'))).toBe(false);
    expect(r.meta.extraction_model).toBeNull();
    expect(r.tasks['facts.extraction_model']).toBe('anthropic:claude-haiku-5-5');
  });

  test('a value that reads back differently, or that gbrain resolves to another model, fails the realization', () => {
    const back = install(SET, 'None', '{"facts.extraction_model": "anthropic:claude-haiku-5-5"}');
    expect(back.error.kind).toBe('product_error');
    expect(back.error.message).toContain("facts.extraction_model reads back 'anthropic:claude-haiku-5-5' after config set 'anthropic:claude-opus-5-5'");
    const resolved = install(SET, '"anthropic:claude-haiku-5-5"');
    expect(resolved.error.kind).toBe('product_error');
    expect(resolved.error.message).toContain("gbrain resolves facts.extraction_model to 'anthropic:claude-haiku-5-5', not GBRAIN_F6_EXTRACTION_MODEL 'anthropic:claude-opus-5-5'");
  });
});

describe('every serve start and the capability record', () => {
  const START = `os.makedirs(os.path.join(shim.HOME, ".gbrain")); open(os.path.join(shim.HOME, ".gbrain", "config.json"), "w").write("{}")
f = Fake(RESOLVES); r = f.resolve_config(); f.reference = {"resolved_sha256": shim.sha256_text(shim.canonical(r))}
f.start_serve(); result = f.serve_session["surface"]`;
  test('serve starts only while gbrain resolves the set model; unset, the check is off', () => {
    expect(shim(START.replace('RESOLVES', '"anthropic:claude-opus-5-5"'), SET).ok).toBe('full');
    const stale = shim(START.replace('RESOLVES', '"anthropic:claude-haiku-5-5"'), SET);
    expect(stale.error.message).toContain('gbrain resolves facts.extraction_model to');
    expect(shim(START.replace('RESOLVES', '"anthropic:claude-haiku-5-5"')).ok).toBe('full');
  });

  test("the f6 block records the model beside extract_cap_usd, and leaves it out when unset", () => {
    const f6 = (env: Record<string, string>) => shim('result = Fake().capabilities()["f6"]', env).ok;
    const set = f6(SET);
    expect(set).toMatchObject({ enabled: true, extract_cap_usd: 10, extraction_model: OPUS });
    expect(Object.keys(set).indexOf('extraction_model')).toBe(Object.keys(set).indexOf('extract_cap_usd') + 1);
    expect('extraction_model' in f6({})).toBe(false);
  });
});
