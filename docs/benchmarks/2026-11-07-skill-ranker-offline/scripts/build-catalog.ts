/**
 * Build the public skill catalog: gbrain's bundled skills (from dump-gbrain.ts),
 * gstack's skills and permissively licensed public skill repositories, each
 * cloned at the commit pinned in SOURCES below. Stores only id, name,
 * description, triggers, routing rows and a body bounded to 4 KB.
 *
 * Tiers are nested: core (250) is every gbrain and gstack skill plus a seeded
 * sample of public skills; pad750 and pad1500 add further seeded public skills.
 *
 *   bun scripts/build-catalog.ts <clone-root> data/gbrain-bundled.json > data/catalog.jsonl
 *   (clone-root holds <owner>_<repo> checkouts; --clone clones missing ones at the pinned commit)
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { YAML } from 'bun';

export const BODY_BYTES = 4096;
export const TIERS = { core: 250, pad750: 750, pad1500: 1500 } as const;
const SEED = 'gbra377-catalog-v1';

/** Every source, in name-dedupe priority order. spdx is read from the LICENSE file at the pinned commit. */
export const SOURCES: { repo: string; commit: string; spdx: string; skip?: RegExp }[] = [
  { repo: 'garrytan/gstack', commit: '118207f', spdx: 'MIT', skip: /^(test\/|openclaw\/|qm\/|capy\/|SKILL\.md$)/ },
  { repo: 'obra/superpowers', commit: '22f0b46', spdx: 'MIT' },
  { repo: 'wshobson/agents', commit: '4bde316', spdx: 'MIT' },
  { repo: 'K-Dense-AI/scientific-agent-skills', commit: 'a25cf9e', spdx: 'MIT' },
  { repo: 'alirezarezvani/claude-skills', commit: '8f08254', spdx: 'MIT' },
  { repo: 'github/awesome-copilot', commit: '797337f', spdx: 'MIT' },
  { repo: 'microsoft/skills', commit: '0696600', spdx: 'MIT' },
  { repo: 'huggingface/skills', commit: '25910b3', spdx: 'Apache-2.0' },
  { repo: 'cloudflare/skills', commit: '6eb6c78', spdx: 'Apache-2.0' },
  { repo: 'google-gemini/gemini-skills', commit: '7cfc690', spdx: 'Apache-2.0' },
  { repo: 'getsentry/skills', commit: 'e94f222', spdx: 'Apache-2.0' },
  { repo: 'expo/skills', commit: 'a9e5bd3', spdx: 'MIT' },
  { repo: 'callstackincubator/agent-skills', commit: '59e9d17', spdx: 'MIT' },
  { repo: 'antfu/skills', commit: 'f63e9ec', spdx: 'MIT' },
  { repo: 'coreyhaines31/marketingskills', commit: '96798cf', spdx: 'MIT' },
  { repo: 'supabase/agent-skills', commit: 'c9be0e9', spdx: 'MIT' },
  { repo: 'daymade/claude-code-skills', commit: 'dc3eb11', spdx: 'MIT' },
  { repo: 'glittercowboy/taches-cc-resources', commit: '1757615', spdx: 'MIT' },
];

export interface Skill {
  id: string; name: string; source: string; spdx: string; path: string;
  description: string; triggers: string[]; routing: string[]; body: string; tier: keyof typeof TIERS;
}

const h = (s: string) => createHash('sha256').update(s).digest('hex');
const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();

function boundBody(text: string): string {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const buf = Buffer.from(body, 'utf8');
  if (buf.length <= BODY_BYTES) return body;
  return buf.subarray(0, BODY_BYTES).toString('utf8').replace(/\uFFFD+$/, '');
}

function frontmatter(text: string): Record<string, unknown> | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  try { return (YAML.parse(m[1]) as Record<string, unknown>) ?? null; } catch { return null; }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir).sort()) {
    if (e === 'node_modules' || e === '.git') continue;
    const p = join(dir, e);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out); else if (e === 'SKILL.md') out.push(p);
  }
  return out;
}

const eligible = (fm: Record<string, unknown>) => fm['disable-model-invocation'] !== true && fm['eligible'] !== false;

if (import.meta.main) {
  const [cloneRoot, gbrainDump] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const clone = process.argv.includes('--clone');
  const skills: Omit<Skill, 'tier'>[] = [];
  const seen = new Set<string>();
  const add = (s: Omit<Skill, 'tier'>) => {
    const key = s.name.toLowerCase();
    if (seen.has(key) || s.description.length < 20) return;
    seen.add(key);
    skills.push(s);
  };
  const gb = JSON.parse(readFileSync(gbrainDump, 'utf8'));
  for (const s of gb.skills) {
    add({ id: `gbrain:${s.name}`, name: s.name, source: 'garrytan/gbrain', spdx: 'MIT', path: `skills/${s.name}/SKILL.md`,
      description: clean(s.description), triggers: s.triggers.map(clean), routing: s.routing.map(clean), body: boundBody(s.text) });
  }
  for (const src of SOURCES) {
    const dir = join(cloneRoot, src.repo.replace('/', '_'));
    if (!existsSync(dir) && clone) execFileSync('git', ['clone', '-q', `https://github.com/${src.repo}.git`, dir]);
    if (clone) execFileSync('git', ['-C', dir, 'checkout', '-q', src.commit]);
    const head = execFileSync('git', ['-C', dir, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();
    if (!src.commit.startsWith(head) && !head.startsWith(src.commit)) throw new Error(`${src.repo} is at ${head}, pinned ${src.commit}`);
    const short = src.repo.split('/')[0];
    for (const file of walk(dir)) {
      const rel = relative(dir, file);
      if (src.skip?.test(rel) || /(^|\/)(test|tests|fixtures|examples?|templates?)\//.test(rel)) continue;
      const text = readFileSync(file, 'utf8');
      const fm = frontmatter(text);
      if (!fm || !fm.name || !fm.description || !eligible(fm)) continue;
      const triggers = Array.isArray(fm.triggers) ? fm.triggers.map(clean).filter(Boolean) : [];
      add({ id: `${short}:${clean(fm.name)}`, name: clean(fm.name), source: src.repo, spdx: src.spdx, path: rel,
        description: clean(fm.description), triggers, routing: [], body: boundBody(text) });
    }
  }
  const pinned = skills.filter(s => s.source === 'garrytan/gbrain' || s.source === 'garrytan/gstack');
  const pub = skills.filter(s => !pinned.includes(s)).sort((a, b) => h(SEED + a.id).localeCompare(h(SEED + b.id)));
  const need = TIERS.pad1500 - pinned.length;
  if (pub.length < need) throw new Error(`only ${pub.length} public skills, need ${need}`);
  const tiered: Skill[] = [
    ...pinned.map(s => ({ ...s, tier: 'core' as const })),
    ...pub.slice(0, need).map((s, i) => ({ ...s, tier: (i < TIERS.core - pinned.length ? 'core' : i < TIERS.pad750 - pinned.length ? 'pad750' : 'pad1500') as Skill['tier'] })),
  ];
  process.stderr.write(`pool ${skills.length} (pinned ${pinned.length}, public ${pub.length}); kept ${tiered.length}\n`);
  for (const s of tiered) process.stdout.write(JSON.stringify(s) + '\n');
}
