#!/usr/bin/env bun
/**
 * Per-run attribution for Cat 41 `fresh_install_to_wired_recall`: per-session wall time, shell commands, web fetches,
 * gbrain MCP calls, the registration command and surface the agent used, and the tools the recall session called.
 *
 *   bun docs/benchmarks/2026-10-09-cat41-rebaseline/attribution.ts <label>=<runs dir> [...] > attribution.json
 *
 * A runs dir holds `fresh_install_to_wired_recall--<harness>--r<n>-a<k>/` directories (a pass's `runs/`, or a
 * published `runs.tar.gz` extracted). For crash-retried runs the last attempt is used, as the scorer does. Output goes
 * through the runner's `publishable` scrub, so container paths print as `~/` and `<tmp>/`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishable } from '../../../eval/runner/cat41-agent-operator.ts';
import { parseSession } from '../../../eval/runner/cat41/transcript.ts';
import type { ContainerResult } from '../../../eval/runner/cat41/types.ts';

const SCENARIO = 'fresh_install_to_wired_recall';
const REGISTER_RE = /\b(claude|codex)\s+mcp\s+add\s+(?!--help\b|-h\b)[^\n]*/;

function runsOf(dir: string): string[] {
  const latest = new Map<string, { path: string; attempt: number }>();
  for (const d of readdirSync(dir).filter(x => x.startsWith(`${SCENARIO}--`))) {
    const m = d.match(/--(claude|codex)--r(\d+)-a(\d+)$/);
    if (!m || !existsSync(join(dir, d, 'result.json'))) continue;
    const key = `${m[1]}|${m[2]}`;
    const prev = latest.get(key);
    if (!prev || Number(m[3]) > prev.attempt) latest.set(key, { path: join(dir, d), attempt: Number(m[3]) });
  }
  return [...latest.values()].map(x => x.path).sort();
}

function attribute(path: string) {
  const r = JSON.parse(readFileSync(join(path, 'result.json'), 'utf8')) as ContainerResult;
  const sessions = r.sessions.map(s => {
    const raw = existsSync(join(path, s.raw_path)) ? readFileSync(join(path, s.raw_path), 'utf8') : '';
    const p = parseSession(r.harness, raw, s.index);
    const shell = p.events.filter(e => e.kind === 'shell');
    const mcp = p.events.filter(e => e.kind === 'mcp');
    const registrations = shell.map(e => e.name.match(REGISTER_RE)?.[0]).filter((x): x is string => !!x);
    return {
      index: s.index, wall_ms: s.wall_ms, cost_usd: s.cost_usd,
      shell_commands: shell.length, web_calls: p.events.filter(e => e.kind === 'web').length,
      gbrain_mcp_calls: mcp.length, gbrain_mcp_errors: mcp.filter(e => e.is_error).length,
      mcp_tools: mcp.map(e => e.name),
      registrations: registrations.map(x => x.replace(/github:garrytan\/gbrain#[0-9a-f]+/g, '<spec>').slice(0, 240)),
      surfaces: [...new Set(registrations.map(x => x.match(/--surface[\s=]+["']?(verbs|starter|full)\b/)?.[1] ?? 'none'))],
      gbrain_tools_offered: r.harness === 'claude' ? p.toolNames.filter(t => t.startsWith('mcp__gbrain__')).length : null,
      final_text: p.finalText.slice(0, 300),
    };
  });
  return {
    harness: r.harness, repeat: r.repeat, gbrain: r.harness_versions?.gbrain ?? null,
    download_ms: r.setup.download_ms ?? null,
    wall_ms: r.sessions.reduce((a, s) => a + s.wall_ms, 0),
    provider_requests: (r.provider_requests ?? []).length,
    rerank_requests: (r.provider_requests ?? []).filter(q => /rerank/i.test(JSON.stringify(q))).length,
    sessions,
  };
}

const out: Record<string, unknown[]> = {};
for (const arg of process.argv.slice(2)) {
  const [label, dir] = arg.split('=');
  out[label] = runsOf(dir).map(attribute);
}
console.log(JSON.stringify(publishable(out), null, 2));
