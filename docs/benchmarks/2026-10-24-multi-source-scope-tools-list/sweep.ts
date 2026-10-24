#!/usr/bin/env bun
// Deterministic cross-source sweep (no model calls): every tool on a full-surface gbrain serve --http,
// called with each per-member token and a set of plausible arguments, then every result scanned for
// another member's source_id or canary. Provider keys are removed from the server environment.
//   bun sweep.ts --checkout <gbrain> --brain <dir> [--port 3161] [--out results/sweep.jsonl] [--control]
// --control calls with the all-sources token instead (positive control: the scan must find cross-source pages).
import { execSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { HttpMcp } from './mcp.ts';
import { MEMBERS, allowedSources, type Member } from './tasks.ts';
import { pagesIn } from './grade.ts';

const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const checkout = resolve(flag('checkout')!), brain = resolve(flag('brain')!), port = Number(flag('port', '3161'));
const out = resolve(flag('out', join(import.meta.dir, 'results', 'sweep.jsonl'))!);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, '');
const CANARIES: Record<string, { member: Member; source: string; slug: string }> = JSON.parse(readFileSync(join(import.meta.dir, 'canaries.json'), 'utf8')).canaries;
const tokens = JSON.parse(readFileSync(join(brain, 'tokens.json'), 'utf8')) as Record<string, string>;

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/API_KEY|API_TOKEN/.test(k)) env[k] = v;
let log = '';
const proc = spawn('bun', ['run', join(checkout, 'src/cli.ts'), 'serve', '--http', '--port', String(port), '--surface', 'full'], { env: { ...env, GBRAIN_HOME: brain }, stdio: ['ignore', 'pipe', 'pipe'] });
proc.stdout!.on('data', d => { log += d; }); proc.stderr!.on('data', d => { log += d; });
const base = 'http://127.0.0.1:' + port;
for (let i = 0; ; i++) {
  if (i > 120) throw new Error('server not healthy: ' + log.slice(-1500));
  try { if ((await fetch(base + '/health')).ok) break; } catch { /* starting */ }
  await new Promise(r => setTimeout(r, 500));
}

// Argument values per parameter name; a tool is called once per value of its first matching key,
// plus once with every matching key filled from the first value.
const VALUES: Record<string, unknown[]> = {
  query: ['apollo-example', 'compensation', 'leave'], question: ['what do the notes say about compensation'], q: ['compensation'],
  slug: ['notes/apollo-example', 'notes/compensation', 'people/bob-example'], slugs: [['notes/compensation', 'notes/apollo-example']],
  entities: ['apollo-example'], entity: ['apollo-example'], name: ['apollo-example'], partial: ['notes'], prefix: ['notes'], slug_prefix: ['notes'],
  date: ['2026-10-24'], since: ['2026-01-01'], topic: ['apollo-example'], text: ['compensation'], id: ['notes/compensation'],
};
const summary: Record<string, { calls: number; errors: number; cross_calls: number; cross_pages: string[] }> = {};
for (const member of MEMBERS) {
  const client = new HttpMcp(base, tokens[argv.includes('--control') ? 'all' : member]);
  const allowed = new Set(allowedSources(member));
  const { tools } = await client.listTools();
  for (const tool of tools) {
    const props = Object.keys(((tool.inputSchema as { properties?: Record<string, unknown> }).properties) ?? {});
    const keys = props.filter(p => p in VALUES);
    const variants: Array<Record<string, unknown>> = [{}];
    if (keys.length) {
      for (const v of VALUES[keys[0]]) variants.push({ [keys[0]]: v });
      variants.push(Object.fromEntries(keys.map(k => [k, VALUES[k][0]])));
      if (props.includes('source_id')) variants.push({ ...Object.fromEntries(keys.map(k => [k, VALUES[k][0]])), source_id: '__all__' });
    }
    for (const args of variants) {
      const r = await client.call(tool.name, args);
      const cross = new Set<string>();
      for (const p of pagesIn(r.text)) if (!allowed.has(p.source_id) && p.source_id !== 'default') cross.add(p.source_id + ':' + p.slug);
      for (const [code, o] of Object.entries(CANARIES)) if (!allowed.has(o.source) && r.text.includes(code)) cross.add(o.source + ':' + o.slug);
      const s = (summary[tool.name] ??= { calls: 0, errors: 0, cross_calls: 0, cross_pages: [] });
      s.calls++; if (r.isError) s.errors++;
      if (cross.size) { s.cross_calls++; s.cross_pages = [...new Set([...s.cross_pages, ...cross])].sort(); }
      appendFileSync(out, JSON.stringify({ member, tool: tool.name, args, is_error: r.isError, cross_source_pages: [...cross].sort(), result: r.text.slice(0, 4000) }).split(process.env.HOME ?? '\0').join('~') + '\n');
    }
  }
}
proc.kill('SIGTERM');
const leaking = Object.entries(summary).filter(([, s]) => s.cross_calls > 0);
const result = { control: argv.includes('--control'), gbrain_head: execSync('git -C ' + JSON.stringify(checkout) + ' rev-parse HEAD').toString().trim(), tools: Object.keys(summary).length, calls: Object.values(summary).reduce((a, s) => a + s.calls, 0), tools_with_cross_source_results: Object.fromEntries(leaking) };
writeFileSync(out.replace(/\.jsonl$/, '-summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
process.exit(0);
