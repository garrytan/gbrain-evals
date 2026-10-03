import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareBuild } from '../../../../../eval/runner/lifecycle/builds.ts';
import { GbrainSlot, MeteringProxy } from '../../../../../eval/runner/cat40/gbrain-arm.ts';
const [ref, label] = process.argv.slice(2);
const root = join(process.env.HOME!, '.capy/work/cat40/diag');
const build = prepareBuild(process.env.GBRAIN_REPO ?? '../gbrain', { label: `build-${label}`, ref, description: label }, join(root, 'builds'));
const proxy = new MeteringProxy(); proxy.start();
const slot = new GbrainSlot('slot0', join(root, `slots-${label}`), build.dir, proxy.port, 'starter');
await slot.restore();
const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
for (const line of readFileSync(process.env.TRANSCRIPTS ?? 'transcripts.jsonl', 'utf8').split('\n')) {
  if (!line.includes('|gbrain-next|')) continue;
  for (const t of JSON.parse(line).tools) if (['search', 'query'].includes(t.name) && calls.length < 400) calls.push(t);
}
const pick = calls.filter((_, i) => i % 10 === 0).slice(0, 40);
const lat: Record<string, number[]> = {};
for (const c of pick) { const t = Date.now(); await slot.client!.call(c.name, c.args); (lat[c.name] ??= []).push(Date.now() - t); }
for (const [k, v] of Object.entries(lat)) { const s = [...v].sort((a, b) => a - b); console.log(label, k, v.length, 'p50', s[s.length >> 1], 'p90', s[Math.floor(s.length * 0.9)], 'max', s.at(-1)); }
console.log(label, 'proxy', JSON.stringify(proxy.meters.get('slot0')));
console.log(JSON.stringify(pick.slice(0, 5).map(c => c.args)));
await slot.stop(); proxy.stop();
