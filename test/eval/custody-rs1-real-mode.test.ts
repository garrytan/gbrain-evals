/**
 * RS1 custody scripts (GST-1154): rs1_mint.py's real-mode steps that mint.sh gives no metering proxy. Keyless: BEAM is
 * replaced by a recording stub, no proxy runs and nothing reaches a provider.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { priceRequest, reservationUsd } from '../../eval/runner/budget-ledger.ts';

const REPO = resolve(import.meta.dir, '../..');
const seedLine = (name: string) => ['rs1', 'seed', 'v1'].join('-') + ':' + createHash('sha256').update(name).digest('hex');

const roots: string[] = [];
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), `rs1-${name}-`)); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...env }, timeout: 60_000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('rs1_mint.py real-mode keyless steps', () => {
  test('chat_json and truncate run with no RS1_PROXY_READY, and the BEAM model slot they get refuses every call', () => {
    const dir = scratch('noproxy');
    const seedFile = join(dir, 'k.rs1-seed');
    writeFileSync(seedFile, seedLine('test seed noproxy') + '\n', { mode: 0o600 });
    const harness = [
      'import json, sys, types',
      `sys.path.insert(0, ${JSON.stringify(join(REPO, 'eval/custody/rs1'))})`,
      'import rs1_mint as m',
      'slots = []',
      'def write(src, dst): open(dst, "w").write("[]")',
      'def load_beam(beam_dir, slot):',
      '    slots.append(slot)',
      '    utils = types.SimpleNamespace(convert_chats_pickle_to_json=write, add_ids_to_chats=write)',
      '    return types.SimpleNamespace(utils=utils, adjust=types.SimpleNamespace(count_chats_tokens=lambda *a: None))',
      'm.load_beam = load_beam',
      'ctx = m.Context(types.SimpleNamespace(out=sys.argv[1], conv_index=1, mode="real", beam_dir=sys.argv[1], seed_file=sys.argv[2]))',
      'ctx.beam_chat.mkdir(parents=True)',
      'm.step_chat_json(ctx, 1, ctx.usage("chat_json", 1))',
      'm.step_truncate(ctx, 1, ctx.usage("truncate", 1))',
      'try:',
      '    slots[0].invoke("prompt")',
      '    refused = False',
      'except m.StepFailure:',
      '    refused = True',
      'print(json.dumps({"slots": len(slots), "refused": refused, "chat": (ctx.beam_chat / "chat.json").exists()}))',
    ].join('\n');
    const r = run('python3', ['-c', harness, join(dir, 'rs1-custody-noproxy'), seedFile], { PYTHONDONTWRITEBYTECODE: '1' });
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toEqual({ slots: 1, refused: true, chat: true });
  });

  test('RecordingModel sends a system-only prompt as one user turn, and a refusal a resend would not change escapes BEAM', () => {
    const dir = scratch('recording');
    const harness = [
      'import json, sys, types',
      'from pathlib import Path',
      `sys.path.insert(0, ${JSON.stringify(join(REPO, 'eval/custody/rs1'))})`,
      'import rs1_mint as m',
      'Msg = lambda kind, content: types.SimpleNamespace(type=kind, content=content)',
      'class ApiError(Exception):',
      '    def __init__(self, code):',
      '        super().__init__("provider detail")',
      '        self.code = code',
      'class Inner:',
      '    def __init__(self, code=None):',
      '        self.seen, self.code = [], code',
      '    def invoke(self, value, **kwargs):',
      '        self.seen.append(value if isinstance(value, str) else [(x.type, x.content) for x in value])',
      '        if self.code is not None:',
      '            try:',
      '                raise ApiError(self.code)',
      '            except ApiError as error:',
      '                raise RuntimeError("client wrapper") from error',
      '        return types.SimpleNamespace(content="ok", usage_metadata={"input_tokens": 3, "output_tokens": 1})',
      'usage = m.Usage(Path(sys.argv[1]) / "usage.jsonl")',
      'inner = Inner()',
      'model = m.RecordingModel(inner, "gemini:test", usage)',
      'model.invoke([Msg("system", "one"), Msg("system", "two")], max_tokens=5)',
      'model.invoke([Msg("system", "rules"), Msg("human", "hi")])',
      'model.invoke("plain")',
      'def beam_loop(code):',
      '    try:',
      '        m.RecordingModel(Inner(code), "gemini:test", usage).invoke("p")',
      '    except Exception as error:',
      '        return "swallowed " + type(error).__name__',
      '    except m.ProviderRefusal as error:',
      '        return "escaped " + str(error)',
      'print(json.dumps({"seen": inner.seen, "calls": usage.totals()["calls"],',
      '    "outcomes": {c: beam_loop(c) for c in (400, 402, 403, 408, 429, 503)}}))',
    ].join('\n');
    const r = run('python3', ['-c', harness, dir], { PYTHONDONTWRITEBYTECODE: '1' });
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toEqual({
      seen: ['one\ntwo', [['system', 'rules'], ['human', 'hi']], 'plain'],
      calls: 3,
      outcomes: {
        400: 'escaped HTTP 400 RuntimeError', 402: 'escaped HTTP 402 RuntimeError', 403: 'escaped HTTP 403 RuntimeError',
        408: 'swallowed RuntimeError', 429: 'swallowed RuntimeError', 503: 'swallowed RuntimeError',
      },
    });
  });
});

describe('rs1_mint.py Gemini output limit and thinking level', () => {
  test('a BEAM max_tokens=3000 call sends thinking level low and 3000 + 8192 output tokens, the ledger reserves that limit, and a reply stopped at it counts as capped', () => {
    const dir = scratch('thinking');
    const harness = [
      'import json, sys, types',
      'from pathlib import Path',
      `sys.path.insert(0, ${JSON.stringify(join(REPO, 'eval/custody/rs1'))})`,
      'import rs1_mint as m',
      'MODELS = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash"',
      'class Session:',
      '    def __init__(self):',
      '        self.sent = []',
      '    def request(self, method, url, data=None, **kwargs):',
      '        self.sent.append({"url": url, "body": json.loads(data)})',
      '    def post(self, url, data=None, **kwargs):',
      '        return self.request("POST", url, data=data, **kwargs)',
      'class Inner:',
      '    def __init__(self, session, finish):',
      '        self.session, self.finish = session, finish',
      '    def invoke(self, value, generation_config=None, **kwargs):',
      '        config = {"temperature": 0.0}',
      '        if generation_config:',
      '            config["maxOutputTokens"] = generation_config["max_output_tokens"]',
      '        body = {"contents": [{"role": "user", "parts": [{"text": value}]}], "generationConfig": config}',
      '        self.session.post(MODELS + ":generateContent", data=json.dumps(body))',
      '        return types.SimpleNamespace(content="ok", usage_metadata={"input_tokens": 9, "output_tokens": 4},',
      '                                     response_metadata={"finish_reason": self.finish})',
      'session = Session()',
      'm.send_thinking(session)',
      'session.post(MODELS + ":countTokens", data=json.dumps({"contents": []}))',
      'usage = m.Usage(Path(sys.argv[1]) / "usage.jsonl")',
      'for finish, max_tokens in (("STOP", 3000), ("MAX_TOKENS", 3000), ("STOP", None)):',
      '    m.RecordingModel(Inner(session, finish), "gemini:gemini-3.8-flash", usage).invoke("prompt", max_tokens=max_tokens)',
      'lines = [json.loads(line) for line in usage.path.read_text().splitlines()]',
      'print(json.dumps({"thinking": m.GEN_THINKING, "sent": session.sent, "lines": lines, "totals": usage.totals()}))',
    ].join('\n');
    const r = run('python3', ['-c', harness, dir], { PYTHONDONTWRITEBYTECODE: '1' });
    expect(r.err).toBe('');
    const out = JSON.parse(r.out);
    expect(out.thinking).toEqual({ thinking_level: 'low', reasoning_headroom: 8192 });
    const thinking = { thinkingLevel: 'low' };
    expect(out.sent.map((s: { body: unknown }) => s.body)).toEqual([
      { contents: [] },
      ...[0, 1].map(() => ({ contents: [{ role: 'user', parts: [{ text: 'prompt' }] }], generationConfig: { temperature: 0, maxOutputTokens: 11_192, thinkingConfig: thinking } })),
      { contents: [{ role: 'user', parts: [{ text: 'prompt' }] }], generationConfig: { temperature: 0, thinkingConfig: thinking } },
    ]);
    const line = { model: 'gemini:gemini-3.8-flash', input_tokens: 9, output_tokens: 4, thinking_level: 'low' };
    expect(out.lines).toEqual([
      { ...line, max_output_tokens: 11_192, capped: false },
      { ...line, max_output_tokens: 11_192, capped: true },
      { ...line, max_output_tokens: null, capped: false },
    ]);
    expect(out.totals).toEqual({ calls: 3, input_tokens: 27, output_tokens: 12, capped: 1 });
    const price = priceRequest(out.sent[1].url, out.sent[1].body)!;
    expect(price).toMatchObject({ provider: 'gemini', model: 'gemini-3.8-flash', input: 0.75, output: 3.75, maxOutputTokens: 11_192 });
    expect(reservationUsd(price)).toBeCloseTo((price.inputTokens * 0.75 + 11_192 * 3.75) / 1e6, 12);
  });
});
