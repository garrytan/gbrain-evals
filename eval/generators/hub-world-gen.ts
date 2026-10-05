/**
 * Hub-heavy world-v1 variant (R1): world-v1 plus routine notes whose links
 * give entities a heavy-tailed inbound degree, a few hubs with 5,000-30,000
 * inbound links, and two probe families that only make sense with hubs.
 *
 * Why: world-v1 pages top out at about a dozen inbound links, so any ranking
 * change that depends on entity degree (for example hub dampening of entity
 * and backlink boosts) is inert there. Real personal wikis are not: in a
 * measured 285k-page wiki graph, inbound links had p50 5, p90 93, p99 607,
 * with a handful of hubs above 5,000.
 *
 * What it writes (one directory, world-v1's JSON page format, loadable by
 * loadWorldCorpus and every runner that takes a corpus directory):
 *   - every world-v1 page, unchanged except hub pages, which gain one
 *     sentence naming a program only that page states;
 *   - routine notes (`notes/routine-<n>`), each linking 1-6 entities, sampled
 *     so inbound degrees follow the target distribution;
 *   - bridge notes (`notes/bridge-<n>`), each linking one hub and one ordinary
 *     entity with a fact stated nowhere else;
 *   - `_hub_probes.json`: hub-as-answer probes (gold = the hub page) and
 *     bridge probes (gold = the ordinary entity, support = the bridge note);
 *   - `_hub_world.json`: seed, degree targets and realized degree quantiles.
 *
 * Seeds: seed 1 is development data and is generated from the public salt.
 * Held-out seeds take a private salt from the custodian (`--salt-file`), so
 * the public generator cannot reproduce their program names, bridge facts or
 * link sample. Gold comes from the generator, never from gbrain. Zero LLM.
 *
 * Usage: bun eval/generators/hub-world-gen.ts --seed 1 --out <dir> [--scale 1] [--salt-file <custody path>]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const HUB_WORLD_VERSION = 'hub-world-gen/1';
export const DEV_SEEDS = [1] as const;
export const PUBLIC_SALT = 'hub-world-public-dev-salt';
const WORLD_V1 = resolve(import.meta.dir, '../data/world-v1');

export interface WorldPageJson { slug: string; type: string; title: string; compiled_truth: string | string[]; timeline: string | string[]; [k: string]: unknown }
export interface HubProbe { id: string; kind: 'hub-answer' | 'bridge'; text: string; gold: string[]; support: string[]; hub: string }
export interface HubWorldSummary {
  version: string; seed: number; salted: boolean; scale: number; pages: number; routine_notes: number; bridge_notes: number; links: number;
  hubs: Array<{ slug: string; target: number; realized: number }>;
  inbound_quantiles: { p50: number; p90: number; p99: number; max: number };
}

/** Deterministic PRNG keyed by salt and seed (sha256 counter mode). */
export class SaltedRng {
  private counter = 0;
  private buf: number[] = [];
  constructor(private key: string) {}
  next(): number {
    if (!this.buf.length) {
      const h = createHash('sha256').update(`${this.key}\u0000${this.counter++}`).digest();
      for (let i = 0; i + 4 <= h.length; i += 4) this.buf.push(h.readUInt32BE(i) / 2 ** 32);
    }
    return this.buf.shift()!;
  }
  int(lo: number, hi: number): number { return lo + Math.floor(this.next() * (hi - lo + 1)); }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.next() * xs.length)]; }
}

/** Inbound-degree target for a non-hub entity: a lognormal matched to p50 5, p90 93 (p99 follows near 600). */
export function targetDegree(rng: SaltedRng): number {
  const u = Math.min(1 - 1e-9, Math.max(1e-9, rng.next()));
  // inverse normal via Acklam's rational approximation is overkill here; use Box-Muller on two draws
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
  const mu = Math.log(5);
  const sigma = (Math.log(93) - mu) / 1.2816;
  return Math.max(1, Math.round(Math.exp(mu + sigma * z)));
}

const VOCAB = ['quarterly', 'roadmap', 'hiring', 'pricing', 'partnership', 'launch', 'migration', 'budget', 'offsite', 'compliance', 'onboarding', 'renewal',
  'forecast', 'retention', 'logistics', 'security review', 'vendor', 'press', 'recruiting', 'integration', 'support backlog', 'board prep', 'expansion', 'audit'];
const NOTE_KINDS = ['Standup notes', 'Inbox digest', 'Newsletter clipping', 'Call notes', 'Weekly review', 'Reading list', 'Event recap', 'Slack summary'];
const CODE_A = ['Aurora', 'Basalt', 'Cinder', 'Delta', 'Ember', 'Fjord', 'Garnet', 'Harbor', 'Indigo', 'Juniper', 'Kestrel', 'Lantern', 'Meridian', 'Nimbus', 'Onyx', 'Pylon', 'Quartz', 'Rook', 'Sable', 'Tundra'];
const CODE_B = ['Bridge', 'Compass', 'Engine', 'Forge', 'Gate', 'Harvest', 'Keystone', 'Ledger', 'Mosaic', 'Orbit', 'Pilot', 'Relay', 'Signal', 'Summit', 'Vector', 'Willow'];

const md = (p: { slug: string; title: string }) => `[${p.title}](${p.slug})`;
const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0; };

export function generateHubWorld(opts: { seed: number; salt?: string; scale?: number }): { pages: WorldPageJson[]; probes: HubProbe[]; summary: HubWorldSummary } {
  const salted = opts.salt !== undefined;
  if (!salted && !(DEV_SEEDS as readonly number[]).includes(opts.seed)) throw new Error(`seed ${opts.seed} is held out: only the custodian's salt renders it`);
  const scale = opts.scale ?? 1;
  const rng = new SaltedRng(`${HUB_WORLD_VERSION}\u0000${opts.salt ?? PUBLIC_SALT}\u0000${opts.seed}`);
  const base: WorldPageJson[] = readdirSync(WORLD_V1).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort()
    .map(f => JSON.parse(readFileSync(join(WORLD_V1, f), 'utf8')) as WorldPageJson);
  const entities = base.filter(p => ['person', 'company'].includes(p.type));
  const companies = entities.filter(p => p.type === 'company');

  // Hubs: four companies with targets 5k, 10k, 20k, 30k (scaled).
  const hubTargets = [5000, 10000, 20000, 30000].map(t => Math.max(50, Math.round(t * scale)));
  const hubPool = [...companies];
  const hubs: WorldPageJson[] = [];
  for (let i = 0; i < hubTargets.length; i++) hubs.push(hubPool.splice(Math.floor(rng.next() * hubPool.length), 1)[0]);
  const target = new Map<string, number>();
  for (const e of entities) target.set(e.slug, Math.max(1, Math.round(targetDegree(rng) * Math.max(scale, 0.05))));
  hubs.forEach((h, i) => target.set(h.slug, hubTargets[i]));

  // Routine notes: fill the degree each target still lacks after world-v1's own links, sampling proportional to what remains.
  const baseInbound = new Map<string, number>();
  for (const p of base) {
    const text = (Array.isArray(p.compiled_truth) ? p.compiled_truth.join(' ') : String(p.compiled_truth ?? '')) + ' ' + (Array.isArray(p.timeline) ? p.timeline.join(' ') : String(p.timeline ?? ''));
    for (const m of new Set([...text.matchAll(/\]\(([a-z]+\/[a-z0-9-]+)\)/g)].map(x => x[1]))) baseInbound.set(m, (baseInbound.get(m) ?? 0) + 1);
  }
  const remaining = new Map([...target].map(([s, t]) => [s, Math.max(0, t - (baseInbound.get(s) ?? 0))]));
  const pages: WorldPageJson[] = base.map(p => ({ ...p }));
  const notes: WorldPageJson[] = [];
  const pickWeighted = (exclude: Set<string>): string | null => {
    let total = 0;
    for (const [s, r] of remaining) if (r > 0 && !exclude.has(s)) total += r;
    if (total <= 0) return null;
    let x = rng.next() * total;
    for (const [s, r] of remaining) { if (r <= 0 || exclude.has(s)) continue; x -= r; if (x <= 0) return s; }
    return null;
  };
  const bySlug = new Map(entities.map(e => [e.slug, e]));
  // Weighted picks over ~250 entities per link are fine at this size (about 80k links).
  for (let n = 0; ; n++) {
    const k = rng.int(1, 6);
    const chosen = new Set<string>();
    for (let j = 0; j < k; j++) { const s = pickWeighted(chosen); if (!s) break; chosen.add(s); remaining.set(s, remaining.get(s)! - 1); }
    if (!chosen.size) break;
    const ents = [...chosen].map(s => bySlug.get(s)!);
    const topic = rng.pick(VOCAB), topic2 = rng.pick(VOCAB);
    const day = `2025-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`;
    const body = `${rng.pick(NOTE_KINDS)} from ${day}. Touched on ${topic} and ${topic2}. Mentioned: ${ents.map(md).join(', ')}.`;
    notes.push({ slug: `notes/routine-${n}`, type: 'note', title: `${rng.pick(NOTE_KINDS)} ${day} #${n}`, compiled_truth: body, timeline: '', _facts: { type: 'note' } });
  }

  // Hub-as-answer facts and probes.
  const probes: HubProbe[] = [];
  const usedCodes = new Set<string>();
  const code = () => { for (;;) { const c = `${rng.pick(CODE_A)} ${rng.pick(CODE_B)}`; if (!usedCodes.has(c)) { usedCodes.add(c); return c; } } };
  hubs.forEach((h, i) => {
    const page = pages.find(p => p.slug === h.slug)!;
    const facts: string[] = [];
    for (let j = 0; j < 5; j++) {
      const c = code();
      facts.push(`${h.title} runs the ${c} program.`);
      probes.push({ id: `hub-answer:${i}:${j}`, kind: 'hub-answer', text: `Who runs the ${c} program?`, gold: [h.slug], support: [], hub: h.slug });
    }
    const ct = Array.isArray(page.compiled_truth) ? page.compiled_truth.join('\n\n') : String(page.compiled_truth ?? '');
    page.compiled_truth = `${ct}\n\n${facts.join(' ')}`;
  });

  // Bridge notes and probes: an ordinary entity reached only through a hub note.
  const bridges: WorldPageJson[] = [];
  const people = entities.filter(e => e.type === 'person');
  let b = 0;
  for (const h of hubs) for (let j = 0; j < 8; j++, b++) {
    const person = rng.pick(people);
    const c = code();
    bridges.push({ slug: `notes/bridge-${b}`, type: 'note', title: `${h.title} project log #${b}`, timeline: '', _facts: { type: 'note' },
      compiled_truth: `At ${md(h)}, ${md(person)} led the ${c} effort.` });
    probes.push({ id: `bridge:${b}`, kind: 'bridge', text: `Who led the ${c} effort at ${h.title}?`, gold: [person.slug], support: [`notes/bridge-${b}`], hub: h.slug });
  }

  const all = [...pages, ...notes, ...bridges];
  const inbound = new Map<string, number>();
  for (const p of all) {
    const text = (Array.isArray(p.compiled_truth) ? p.compiled_truth.join(' ') : String(p.compiled_truth ?? '')) + ' ' + (Array.isArray(p.timeline) ? p.timeline.join(' ') : String(p.timeline ?? ''));
    for (const m of new Set([...text.matchAll(/\]\(([a-z]+\/[a-z0-9-]+)\)/g)].map(x => x[1]))) inbound.set(m, (inbound.get(m) ?? 0) + 1);
  }
  const degs = entities.map(e => inbound.get(e.slug) ?? 0);
  const summary: HubWorldSummary = {
    version: HUB_WORLD_VERSION, seed: opts.seed, salted, scale, pages: all.length, routine_notes: notes.length, bridge_notes: bridges.length,
    links: [...inbound.values()].reduce((a, c) => a + c, 0),
    hubs: hubs.map((h, i) => ({ slug: h.slug, target: hubTargets[i], realized: inbound.get(h.slug) ?? 0 })),
    inbound_quantiles: { p50: quantile(degs, 0.5), p90: quantile(degs, 0.9), p99: quantile(degs, 0.99), max: Math.max(...degs) },
  };
  return { pages: all, probes, summary };
}

export function writeHubWorld(out: string, world: ReturnType<typeof generateHubWorld>): void {
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(WORLD_V1).filter(f => f.startsWith('_')).sort()) copyFileSync(join(WORLD_V1, f), join(out, f));
  for (const p of world.pages) writeFileSync(join(out, `${p.slug.replace('/', '__')}.json`), JSON.stringify(p));
  writeFileSync(join(out, '_hub_probes.json'), JSON.stringify(world.probes, null, 1));
  writeFileSync(join(out, '_hub_world.json'), JSON.stringify(world.summary, null, 1));
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const seed = Number(val('--seed') ?? 1);
  const out = val('--out');
  if (!out) throw new Error('--out <dir> is required');
  const saltFile = val('--salt-file');
  const world = generateHubWorld({ seed, salt: saltFile ? readFileSync(saltFile, 'utf8').trim() : undefined, scale: Number(val('--scale') ?? 1) });
  writeHubWorld(resolve(out), world);
  process.stdout.write(JSON.stringify(world.summary, null, 1) + '\n');
}
