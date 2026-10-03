#!/usr/bin/env bun
/**
 * Cat 41 in-container driver. Runs as root inside the harness image
 * (cat41/Dockerfile) with:
 *   /opt/gbrain   the gbrain build under test (read-only)
 *   /opt/runner   gbrain-evals eval/runner (read-only)
 *   env ANTHROPIC_API_KEY / OPENAI_API_KEY: harness keys, moved into /run/keys files
 *   /out          the run's output directory
 *
 * It starts a fake model provider, sets the scenario up as the agent user,
 * installs a logging `gbrain` wrapper on PATH, runs the harness CLI
 * (Claude Code or Codex) as the unprivileged `agent` user with the user's
 * prompt, sends scripted follow-ups, probes the machine and writes
 * /out/result.json. Scoring happens on the host.
 *
 * Usage (from the host runner):
 *   bun /opt/runner/cat41/in-container.ts --scenario <id> --harness claude|codex --model <m> --repeat <n> \
 *     --docs-base <url> --install-spec <spec> --gbrain-ref <sha>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hashEmbedding } from '../lifecycle/fake-embedder.ts';
import { scenarioById, type Box, type CmdResult, type Followup } from './scenarios.ts';
import { parseSession } from './transcript.ts';
import type { ContainerResult, Harness, ProviderRequest, SessionRecord, WrapperCall } from './types.ts';

export const DRIVER_VERSION = 'cat41-driver-v1';
const OUT = '/out';
const HOME = '/home/agent';
const LOG_DIR = '/var/cat41';
const CALL_LOG = `${LOG_DIR}/calls.jsonl`;
const ENV_FILE = '/etc/cat41/gbrain.env';
const SILENT_FLAG = '/etc/cat41/silent-stdin';
const PROVIDER_PORT = 18080;
const AGENT_UID = 2000;
const BASE_PATH = '/usr/local/bin:/usr/bin:/bin';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined) { if (fallback !== undefined) return fallback; throw new Error(`missing --${name}`); }
  return v;
}

// ─── Process helpers ─────────────────────────────────────────────────

function run(argv: string[], opts: { as?: 'agent' | 'root'; env?: Record<string, string>; cwd?: string; timeoutMs?: number; stdoutFile?: string } = {}): Promise<CmdResult & { timedOut: boolean; ms: number }> {
  const env = { PATH: BASE_PATH, LANG: 'C.UTF-8', TZ: 'UTC', ...opts.env };
  const kv = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const full = opts.as === 'root' ? ['env', '-i', ...kv, ...argv] : ['runuser', '-u', 'agent', '--', 'env', '-i', ...kv, ...argv];
  const t0 = Date.now();
  return new Promise(resolve => {
    const p = spawn(full[0], full.slice(1), { cwd: opts.cwd ?? (opts.as === 'root' ? '/' : HOME), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '', stderr = '';
    let timedOut = false;
    p.stdout!.setEncoding('utf8'); p.stderr!.setEncoding('utf8');
    p.stdout!.on('data', (c: string) => { if (opts.stdoutFile) appendFileSync(opts.stdoutFile, c); else stdout += c; });
    p.stderr!.on('data', (c: string) => { stderr += c; if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ } }, opts.timeoutMs ?? 300_000);
    p.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr, timedOut, ms: Date.now() - t0 }); });
    p.on('error', e => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}`, timedOut, ms: Date.now() - t0 }); });
  });
}

function owned(path: string, as: 'agent' | 'root' = 'agent') {
  if (as === 'agent') chownSync(path, AGENT_UID, AGENT_UID);
}

function mkdirp(dir: string, as: 'agent' | 'root' = 'agent') {
  const parts: string[] = [];
  let d = dir;
  while (!existsSync(d)) { parts.unshift(d); d = dirname(d); }
  for (const p of parts) { mkdirSync(p); owned(p, as); }
}

// ─── Fake model provider ─────────────────────────────────────────────

const providerLog: ProviderRequest[] = [];
let phase: 'setup' | 'session' = 'setup';
const PRICES: Record<string, { input: number; output: number }> = {
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
  // gbrain has no price for gpt-6-luna; this is the evaluator's own accounting rate for cap checks.
  'gpt-6-luna': { input: 0.2, output: 1.2 },
};
const CANNED = 'Idea: run the Tacoma forklift recertification in parallel with the inventory transfer.';

function tokensOf(x: unknown): number { return Math.max(1, Math.ceil(JSON.stringify(x ?? '').length / 4)); }

function vecBase64(v: number[]): string {
  const buf = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => buf.writeFloatLE(x, i * 4));
  return buf.toString('base64');
}

function startProvider() {
  Bun.serve({
    port: PROVIDER_PORT, hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === 'POST' ? await req.json().catch(() => ({})) as Record<string, unknown> : {};
      const anthropic = url.pathname.startsWith('/anthropic');
      const path = url.pathname;
      const model = String(body.model ?? '');
      const rec = (endpoint: ProviderRequest['endpoint'], inTok: number, outTok: number) => {
        const p = PRICES[model.replace(/^openai[:/]/, '')] ?? { input: 1, output: 4 };
        providerLog.push({ ts: Date.now(), phase, provider: anthropic ? 'anthropic' : 'openai', endpoint, model, input_tokens: inTok, output_tokens: outTok, usd: (inTok * p.input + outTok * p.output) / 1e6 });
      };
      const json = (x: unknown) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
      if (path.endsWith('/embeddings')) {
        const inputs = Array.isArray(body.input) ? body.input as string[] : [String(body.input ?? '')];
        const dims = Number(body.dimensions ?? (model.includes('3-large') ? 3072 : 1536));
        const toks = inputs.reduce((s, t) => s + tokensOf(t), 0);
        rec('embeddings', toks, 0);
        return json({ object: 'list', model, data: inputs.map((t, index) => { const v = hashEmbedding(String(t), dims); return { object: 'embedding', index, embedding: body.encoding_format === 'base64' ? vecBase64(v) : v }; }), usage: { prompt_tokens: toks, total_tokens: toks } });
      }
      if (path.endsWith('/chat/completions')) {
        const inTok = tokensOf(body.messages); rec('chat', inTok, 40);
        return json({ id: 'chatcmpl-cat41', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: CANNED }, finish_reason: 'stop' }], usage: { prompt_tokens: inTok, completion_tokens: 40, total_tokens: inTok + 40 } });
      }
      if (path.endsWith('/responses')) {
        const inTok = tokensOf(body.input); rec('responses', inTok, 40);
        return json({ id: 'resp_cat41', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model, output: [{ type: 'message', id: 'msg_cat41', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: CANNED, annotations: [] }] }], usage: { input_tokens: inTok, output_tokens: 40, total_tokens: inTok + 40 } });
      }
      if (path.endsWith('/messages')) {
        const inTok = tokensOf(body.messages); rec('messages', inTok, 40);
        return json({ id: 'msg_cat41', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: CANNED }], stop_reason: 'end_turn', usage: { input_tokens: inTok, output_tokens: 40 } });
      }
      if (path.endsWith('/models')) { rec('models', 0, 0); return json({ object: 'list', data: [{ id: 'text-embedding-3-small', object: 'model' }, { id: 'gpt-6-luna', object: 'model' }] }); }
      rec('other', 0, 0);
      return new Response(JSON.stringify({ error: { message: `cat41 fake provider: no route for ${path}` } }), { status: 404, headers: { 'content-type': 'application/json' } });
    },
  });
}

// ─── The `gbrain` wrapper on PATH ────────────────────────────────────

const WRAPPER = `#!/bin/bash
# Cat 41: log every gbrain invocation, then run the build under test.
set -a; [ -f ${ENV_FILE} ] && . ${ENV_FILE}; set +a
id="$(date +%s%N)-$$"
stdin_target="$(readlink /proc/$$/fd/0 2>/dev/null || echo unknown)"
argv_json="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@")"
silent=false
if [ -f ${SILENT_FLAG} ] && [ "$stdin_target" = "/dev/null" ] && [ "$1" != "serve" ]; then silent=true; fi
printf '{"ev":"start","id":"%s","ts":%s,"argv":%s,"stdin":"%s","silent":%s}\\n' "$id" "$(date +%s%3N)" "$argv_json" "$stdin_target" "$silent" >> ${CALL_LOG}
if $silent; then
  bun /opt/gbrain/src/cli.ts "$@" < <(sleep 86400)
else
  bun /opt/gbrain/src/cli.ts "$@"
fi
rc=$?
printf '{"ev":"end","id":"%s","ts":%s,"rc":%s}\\n' "$id" "$(date +%s%3N)" "$rc" >> ${CALL_LOG}
exit $rc
`;

function readCalls(): WrapperCall[] {
  if (!existsSync(CALL_LOG)) return [];
  const byId = new Map<string, WrapperCall>();
  for (const l of readFileSync(CALL_LOG, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try {
      const e = JSON.parse(l);
      if (e.ev === 'start') byId.set(e.id, { id: e.id, argv: e.argv, start_ms: e.ts, end_ms: null, exit_code: null, stdin: e.stdin, ...(e.silent ? { silent_stdin: true } : {}) });
      else if (e.ev === 'end' && byId.has(e.id)) { const c = byId.get(e.id)!; c.end_ms = e.ts; c.exit_code = e.rc; }
    } catch { /* torn line */ }
  }
  return [...byId.values()];
}

// ─── Box ─────────────────────────────────────────────────────────────

function makeBox(state: { gbrainEnv: Record<string, string>; mcp: Parameters<Box['setMcp']>[0] | undefined; notes: Record<string, unknown>; silent: boolean }): Box {
  return {
    home: HOME,
    providerUrl: `http://127.0.0.1:${PROVIDER_PORT}`,
    notes: state.notes,
    async gb(args, opts = {}) {
      const as = opts.as ?? 'agent';
      const home = opts.home ?? HOME;
      if (as === 'root') mkdirp(home, 'root');
      const env = { HOME: home, ...(home === HOME ? state.gbrainEnv : {}), ...opts.env };
      return run(['bun', '/opt/gbrain/src/cli.ts', ...args], { as, env, cwd: home, timeoutMs: opts.timeoutMs ?? 300_000 });
    },
    async sh(cmd, opts = {}) {
      return run(['bash', '-c', cmd], { as: opts.as ?? 'agent', env: { HOME: opts.as === 'root' ? '/root' : HOME }, timeoutMs: opts.timeoutMs ?? 120_000 });
    },
    write(path, content, opts = {}) {
      mkdirp(dirname(path), opts.as ?? 'agent');
      writeFileSync(path, content);
      owned(path, opts.as ?? 'agent');
      if (opts.mode) chmodSync(path, opts.mode);
    },
    async bgGbrain(args, opts = {}) {
      const as = opts.as ?? 'agent';
      const home = opts.home ?? HOME;
      const env = { PATH: BASE_PATH, LANG: 'C.UTF-8', TZ: 'UTC', HOME: home, ...(home === HOME ? state.gbrainEnv : {}), ...opts.env };
      const kv = Object.entries(env).map(([k, v]) => `${k}=${v}`);
      const argv = ['bun', '/opt/gbrain/src/cli.ts', ...args];
      const full = as === 'root' ? ['env', '-i', ...kv, ...argv] : ['runuser', '-u', 'agent', '--', 'env', '-i', ...kv, ...argv];
      const p = spawn(full[0], full.slice(1), { cwd: home, stdio: ['pipe', 'ignore', 'ignore'], detached: true });
      p.unref();
      await new Promise(r => setTimeout(r, opts.waitMs ?? 5000));
      // The gbrain process is a child of runuser/env; report the bun pid that owns the brain.
      const r = await run(['bash', '-c', `pgrep -n -f 'opt/gbrain/src/cli.ts ${args.join(' ')}'`], { as: 'root' });
      return Number(r.stdout.trim()) || p.pid!;
    },
    setGbrainEnv(vars) { Object.assign(state.gbrainEnv, vars); },
    setSilentStdin(on) { state.silent = on; },
    setMcp(m) { state.mcp = m; },
    note(k, v) { state.notes[k] = v; },
    pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } },
    hashDir(dir, skip) {
      const h = createHash('sha256');
      const walk = (d: string, rel: string) => {
        for (const name of readdirSync(d).sort()) {
          if (skip?.test(name)) continue;
          const full = join(d, name);
          const st = statSync(full);
          if (st.isDirectory()) walk(full, `${rel}${name}/`);
          else if (st.isFile()) h.update(`${rel}${name}\0${st.size}\0`).update(readFileSync(full)).update('\0');
        }
      };
      if (existsSync(dir)) walk(dir, '');
      return h.digest('hex');
    },
    exists: p => existsSync(p),
    read: p => existsSync(p) ? readFileSync(p, 'utf8') : null,
  };
}

// ─── Harness invocation ──────────────────────────────────────────────

function harnessEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { HOME, PATH: `${HOME}/.bun/bin:${HOME}/.local/bin:${BASE_PATH}`, LANG: 'C.UTF-8', TZ: 'UTC', TERM: 'dumb', MCP_TIMEOUT: '120000', DISABLE_AUTOUPDATER: '1', ...extra };
}

function writeHarnessConfig(harness: Harness, mcp: Parameters<Box['setMcp']>[0] | undefined) {
  if (harness === 'claude') {
    mkdirp(`${HOME}/.claude`);
    writeFileSync(`${HOME}/.claude/settings.json`, JSON.stringify({ apiKeyHelper: 'cat /run/keys/anthropic' }, null, 2));
    owned(`${HOME}/.claude/settings.json`);
    const servers = !mcp ? {} : mcp.kind === 'stdio'
      ? { gbrain: { command: '/usr/local/bin/gbrain', args: mcp.args } }
      : { gbrain: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } };
    mkdirp(`${HOME}/.cat41`);
    writeFileSync(`${HOME}/.cat41/mcp.json`, JSON.stringify({ mcpServers: servers }, null, 2));
    owned(`${HOME}/.cat41/mcp.json`);
  } else {
    mkdirp(`${HOME}/.codex`);
    const lines: string[] = [];
    if (mcp?.kind === 'stdio') lines.push('[mcp_servers.gbrain]', 'command = "/usr/local/bin/gbrain"', `args = ${JSON.stringify(mcp.args)}`, 'startup_timeout_sec = 120', 'tool_timeout_sec = 600');
    if (mcp?.kind === 'http') lines.push('[mcp_servers.gbrain]', `url = ${JSON.stringify(mcp.url)}`, 'bearer_token_env_var = "GBRAIN_MCP_TOKEN"', 'startup_timeout_sec = 120', 'tool_timeout_sec = 600');
    writeFileSync(`${HOME}/.codex/config.toml`, lines.join('\n') + '\n');
    owned(`${HOME}/.codex/config.toml`);
  }
}

async function runHarness(harness: Harness, model: string, prompt: string, opts: { index: number; resumeId: string | null; useRegistrations: boolean; mcp: Parameters<Box['setMcp']>[0] | undefined; timeoutMs: number }): Promise<{ rec: SessionRecord; sessionId: string | null; finalText: string }> {
  const rawPath = `${OUT}/session-${opts.index}.jsonl`;
  writeFileSync(rawPath, '');
  let argv: string[];
  const extraEnv: Record<string, string> = {};
  if (harness === 'claude') {
    argv = ['claude', '-p', prompt, '--model', model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    if (opts.resumeId) argv.push('--resume', opts.resumeId);
    if (!opts.useRegistrations) argv.push('--mcp-config', `${HOME}/.cat41/mcp.json`, '--strict-mcp-config');
  } else {
    const common = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-m', model];
    argv = opts.resumeId ? ['codex', 'exec', 'resume', ...common, opts.resumeId, prompt] : ['codex', 'exec', ...common, prompt];
    if (opts.mcp?.kind === 'http') extraEnv.GBRAIN_MCP_TOKEN = opts.mcp.token;
  }
  mkdirp(`${HOME}/work`);
  const r = await run(argv, { as: 'agent', env: harnessEnv(extraEnv), cwd: `${HOME}/work`, timeoutMs: opts.timeoutMs, stdoutFile: rawPath });
  appendFileSync(`${OUT}/harness-stderr.log`, `--- session ${opts.index} (exit ${r.code}${r.timedOut ? ', timed out' : ''})\n${r.stderr.slice(-20_000)}\n`);
  const parsed = parseSession(harness, readFileSync(rawPath, 'utf8'), opts.index);
  return {
    sessionId: parsed.sessionId,
    finalText: parsed.finalText,
    rec: {
      index: opts.index, prompt, raw_path: `session-${opts.index}.jsonl`, exit_code: r.code, timed_out: r.timedOut, wall_ms: r.ms,
      cost_usd: parsed.costUsd, input_tokens: parsed.inputTokens, cached_input_tokens: parsed.cachedInputTokens, output_tokens: parsed.outputTokens,
      model: parsed.model ?? model,
    },
  };
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const scenario = scenarioById(arg('scenario'));
  const harness = arg('harness') as Harness;
  const model = arg('model');
  const result: ContainerResult = {
    version: DRIVER_VERSION, scenario: scenario.id, harness, model, repeat: Number(arg('repeat', '1')), started_at: new Date().toISOString(),
    setup: {}, sessions: [], wrapper_calls: [], provider_requests: [], probe: {}, harness_versions: {},
  };
  const write = () => writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 2));
  try {
    // Harness keys arrive as container env; only the harness reads them, from files (claude apiKeyHelper, codex login).
    mkdirp('/run/keys', 'root');
    for (const [file, name] of [['anthropic', 'ANTHROPIC_API_KEY'], ['openai', 'OPENAI_API_KEY']] as const) {
      writeFileSync(`/run/keys/${file}`, process.env[name] ?? ''); chmodSync(`/run/keys/${file}`, 0o644);
      delete process.env[name];
    }
    mkdirp(LOG_DIR, 'root'); chmodSync(LOG_DIR, 0o1777);
    writeFileSync(CALL_LOG, ''); chmodSync(CALL_LOG, 0o666);
    mkdirp('/etc/cat41', 'root');
    for (const [k, cmd] of Object.entries({ claude: 'claude --version', codex: 'codex --version', bun: 'bun --version', gbrain: 'cat /opt/gbrain/VERSION' })) {
      result.harness_versions[k] = (await run(['bash', '-c', cmd], { as: 'root' })).stdout.trim();
    }
    startProvider();
    const state = { gbrainEnv: {} as Record<string, string>, mcp: undefined as Parameters<Box['setMcp']>[0] | undefined, notes: result.setup, silent: false };
    const box = makeBox(state);
    if (harness === 'codex') {
      mkdirp(`${HOME}/.codex`);
      const login = await run(['bash', '-c', 'codex login --with-api-key < /run/keys/openai'], { as: 'agent', env: { HOME } });
      if (login.code !== 0) throw new Error(`codex login failed: ${login.stderr.slice(-300)}`);
    }
    const t0 = Date.now();
    try { await scenario.setup(box); }
    catch (e) { result.setup_error = (e as Error).message; write(); return; }
    result.setup.setup_ms = Date.now() - t0;
    writeFileSync(ENV_FILE, Object.entries(state.gbrainEnv).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n') + '\n');
    chmodSync(ENV_FILE, 0o644);
    if (state.silent) writeFileSync(SILENT_FLAG, '1');
    if (scenario.id !== 'fresh_install_to_wired_recall' && !scenario.id.startsWith('docs_')) {
      writeFileSync('/usr/local/bin/gbrain', WRAPPER); chmodSync('/usr/local/bin/gbrain', 0o755);
    }
    writeHarnessConfig(harness, state.mcp);
    writeFileSync(CALL_LOG, '');
    phase = 'session';

    const ctx = { harness, docsBase: arg('docs-base'), installSpec: arg('install-spec'), gbrainRef: arg('gbrain-ref') };
    const first = await runHarness(harness, model, scenario.prompt(ctx), { index: 1, resumeId: null, useRegistrations: false, mcp: state.mcp, timeoutMs: scenario.timeoutMs });
    result.sessions.push(first.rec);
    let last = first;
    let index = 1;
    for (const f of (scenario.followups ?? []) as Followup[]) {
      if (f.when && !f.when(last.finalText, box)) continue;
      index++;
      const next = await runHarness(harness, model, f.prompt, { index, resumeId: f.mode === 'resume' ? last.sessionId : null, useRegistrations: f.useHarnessRegistrations === true, mcp: state.mcp, timeoutMs: scenario.timeoutMs });
      result.sessions.push(next.rec);
      last = next;
    }
    write();
    // Stop leftover MCP servers the harness started, keep processes the scenario owns (a user's own serve).
    await new Promise(r => setTimeout(r, 2000));
    const keep = new Set([Number(result.setup.holder_pid ?? 0)].filter(Boolean));
    const stray = (await run(['bash', '-c', "pgrep -u agent -f 'src/cli.ts serve' || true"], { as: 'root' })).stdout.split('\n').map(Number).filter(n => n && !keep.has(n));
    for (const pid of stray) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    await run(['bash', '-c', 'pkill -u agent -f "sleep 86400" || true'], { as: 'root' });
    await new Promise(r => setTimeout(r, 1500));
    result.wrapper_calls = readCalls();
    try { result.probe = await scenario.probe(box); }
    catch (e) { result.probe = { probe_error: (e as Error).message }; }
    const sess = providerLog.filter(p => p.phase === 'session');
    Object.assign(result.probe, {
      chat_requests: sess.filter(p => p.endpoint === 'chat' || p.endpoint === 'responses' || p.endpoint === 'messages').length,
      embedding_requests: sess.filter(p => p.endpoint === 'embeddings').length,
      session_provider_usd: sess.reduce((s, p) => s + p.usd, 0),
    });
    result.provider_requests = providerLog;
  } catch (e) {
    result.crash = (e as Error).stack ?? String(e);
  }
  write();
  const hostUid = arg('host-uid', '');
  if (hostUid) await run(['chown', '-R', `${hostUid}:${hostUid}`, OUT], { as: 'root' });
  process.exit(0);
}

if (import.meta.main) await main();
