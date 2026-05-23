/**
 * Synthetic v1 corpus generator.
 *
 * Builds ~165 pages with shape inspired by a real production brain (counts
 * + slug patterns + Facts fence + wikilink density) but with PURE PLACEHOLDER
 * names. Deterministic (seeded RNG, no LLM calls) — re-runs reproduce byte
 * for byte. Output: eval/data/synthetic-v1/.
 *
 * Privacy invariant: every personal name + company name is from a small fixed
 * allowlist of "example" / "placeholder" tokens. CI grep regression guard
 * lives at `scripts/check-synthetic-no-pii.sh` (greps for known sensitive
 * patterns: capitalized common given names that DON'T start with `Alice` /
 * `Bob` / `Carol` / `Dan` / etc.).
 *
 * Run:
 *   bun eval/generators/synthetic-v1-gen.ts
 *
 * Shape (mirrors real-brain counts at 1/100 scale):
 *   30 companies  (real brain: 5340)
 *   50 people     (real brain: 24585)
 *   25 concepts   (real brain: 11612)
 *   20 meetings   (real brain: 669)
 *   15 deals      (real brain: 19)
 *   10 daily      (real brain: 3542)
 *   5 originals   (real brain: 3845)
 *    5 writing    (real brain: 102)
 *    5 projects   (real brain: 264)
 *   = 165 pages total
 */

import { writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';

const OUTDIR = join(process.cwd(), 'eval/data/synthetic-v1');

// Seeded RNG (mulberry32) — deterministic across runs
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Placeholder name pool (all explicitly fictional / illustrative)
const PEOPLE_GIVENS = ['alice', 'bob', 'carol', 'dan', 'erin', 'frank', 'grace', 'henry', 'ivy', 'jack', 'kate', 'leo', 'mira', 'noah', 'olive', 'paul', 'quinn', 'rita', 'sam', 'tara', 'umar', 'vera', 'wes', 'xena', 'yuri', 'zoe'];
const PEOPLE_SURNAMES = ['example', 'placeholder', 'sample', 'demo', 'fictional', 'synth', 'mock'];

const COMPANY_BASES = ['acme', 'widget', 'foundry', 'orbit', 'beacon', 'crater', 'horizon', 'nimbus', 'pillar', 'quartz', 'ridge', 'summit', 'titan', 'vector', 'zenith', 'apex', 'cobalt', 'delta', 'echo', 'forge', 'grove', 'hydra', 'iris', 'jade', 'kite', 'lattice', 'maple', 'nova', 'onyx', 'pulse'];
const COMPANY_SUFFIXES = ['-ai', '-labs', '-co', '-tech', '-systems', '-platform', '-cloud', '-data', '-robotics', '-bio'];

const CONCEPTS = ['agent-memory', 'context-windows', 'rag-architectures', 'embedding-models', 'reranker-stacks', 'graph-traversal', 'vector-search', 'hybrid-retrieval', 'temporal-grounding', 'gap-analysis', 'auto-linking', 'knowledge-graphs', 'synthesis-layers', 'session-demotion', 'cross-source-corroboration', 'adjacency-boost', 'intent-classification', 'token-budgeting', 'query-expansion', 'matryoshka-embeddings', 'contextual-retrieval', 'pre-fetched-synopsis', 'sparse-dense-fusion', 'reciprocal-rank-fusion', 'source-tier-boost'];

const TOPICS = ['ai-infrastructure', 'autonomous-picking', 'inference-platforms', 'developer-tools', 'gpu-scheduling', 'embedding-providers', 'multimodal-search', 'agent-orchestration', 'memory-systems', 'eval-frameworks'];

const ROLES = ['CEO', 'CTO', 'VP Eng', 'Lead Engineer', 'ML Researcher', 'Product Lead', 'Founder', 'Co-Founder', 'Designer', 'Operations Lead'];

interface Generated {
  slug: string;
  body: string;
}

function person(i: number, r: () => number): Generated {
  const given = PEOPLE_GIVENS[i % PEOPLE_GIVENS.length];
  const surname = PEOPLE_SURNAMES[Math.floor(r() * PEOPLE_SURNAMES.length)];
  const fullSlug = `people/${given}-${surname}-${i}`;
  const company1 = `companies/${COMPANY_BASES[Math.floor(r() * COMPANY_BASES.length)]}${COMPANY_SUFFIXES[Math.floor(r() * COMPANY_SUFFIXES.length)]}`;
  const company2 = `companies/${COMPANY_BASES[Math.floor(r() * COMPANY_BASES.length)]}${COMPANY_SUFFIXES[Math.floor(r() * COMPANY_SUFFIXES.length)]}`;
  const concept = `concepts/${CONCEPTS[Math.floor(r() * CONCEPTS.length)]}`;
  const role = ROLES[Math.floor(r() * ROLES.length)];

  const body = `---
type: person
title: ${given.charAt(0).toUpperCase() + given.slice(1)} ${surname.charAt(0).toUpperCase() + surname.slice(1)}
---

# ${given.charAt(0).toUpperCase() + given.slice(1)} ${surname.charAt(0).toUpperCase() + surname.slice(1)}

${role} at [[${company1}]]. Previously at [[${company2}]].

Working on ${TOPICS[Math.floor(r() * TOPICS.length)]} and [[${concept}]] research.

## Timeline

- 2024-${String(Math.floor(r() * 12) + 1).padStart(2, '0')}-${String(Math.floor(r() * 28) + 1).padStart(2, '0')} joined [[${company1}]]
- 2026-${String(Math.floor(r() * 5) + 1).padStart(2, '0')}-${String(Math.floor(r() * 28) + 1).padStart(2, '0')} promoted to ${role}
`;
  return { slug: fullSlug, body };
}

function company(i: number, r: () => number): Generated {
  const base = COMPANY_BASES[i % COMPANY_BASES.length];
  const suffix = COMPANY_SUFFIXES[Math.floor(r() * COMPANY_SUFFIXES.length)];
  const slug = `companies/${base}${suffix}-${i}`;
  const topic = TOPICS[Math.floor(r() * TOPICS.length)];
  const concept = `concepts/${CONCEPTS[Math.floor(r() * CONCEPTS.length)]}`;

  // Typed-claim facts fence for trajectory + scorecard
  const arr1 = Math.floor(r() * 500_000);
  const arr2 = arr1 * (2 + r() * 3);
  const arr3 = arr2 * (1.2 + r());
  const team1 = Math.floor(r() * 5) + 3;
  const team2 = team1 + Math.floor(r() * 15) + 2;

  const body = `---
type: company
title: ${base.charAt(0).toUpperCase() + base.slice(1)} ${suffix.slice(1).toUpperCase()} ${i}
---

# ${base.charAt(0).toUpperCase() + base.slice(1)} ${suffix.slice(1).toUpperCase()} ${i}

A ${topic} company. Founded ${2020 + Math.floor(r() * 5)}.

Focus area: [[${concept}]]. Working on ${TOPICS[Math.floor(r() * TOPICS.length)]}.

## Facts

| since | claim | metric | value | unit | period |
|-------|-------|--------|-------|------|--------|
| 2025-01-15 | ARR is $${Math.round(arr1 / 1000)}K | arr | ${Math.round(arr1)} | usd | annual |
| 2025-08-20 | ARR is $${Math.round(arr2 / 1000)}K | arr | ${Math.round(arr2)} | usd | annual |
| 2026-04-10 | ARR is $${Math.round(arr3 / 1000)}K | arr | ${Math.round(arr3)} | usd | annual |
| 2025-03-01 | team is ${team1} | team_size | ${team1} | people | snapshot |
| 2026-02-15 | team is ${team2} | team_size | ${team2} | people | snapshot |

## Timeline

- 2024-${String(Math.floor(r() * 12) + 1).padStart(2, '0')}-${String(Math.floor(r() * 28) + 1).padStart(2, '0')} founded
- 2025-06-${String(Math.floor(r() * 28) + 1).padStart(2, '0')} raised seed round
`;
  return { slug, body };
}

function concept(i: number, r: () => number): Generated {
  const slug = `concepts/${CONCEPTS[i % CONCEPTS.length]}`;
  const c1 = `companies/${COMPANY_BASES[Math.floor(r() * COMPANY_BASES.length)]}${COMPANY_SUFFIXES[Math.floor(r() * COMPANY_SUFFIXES.length)]}`;
  const c2 = `companies/${COMPANY_BASES[Math.floor(r() * COMPANY_BASES.length)]}${COMPANY_SUFFIXES[Math.floor(r() * COMPANY_SUFFIXES.length)]}`;
  const body = `---
type: concept
title: ${CONCEPTS[i % CONCEPTS.length].replace(/-/g, ' ')}
---

# ${CONCEPTS[i % CONCEPTS.length].replace(/-/g, ' ')}

A pattern in ${TOPICS[Math.floor(r() * TOPICS.length)]}.

Seen at [[${c1}]] and [[${c2}]]. Compare to [[concepts/${CONCEPTS[(i + 5) % CONCEPTS.length]}]].

## Notes

The technique relies on ${TOPICS[Math.floor(r() * TOPICS.length)]}. Reference work in [[concepts/${CONCEPTS[(i + 10) % CONCEPTS.length]}]] demonstrates ${TOPICS[Math.floor(r() * TOPICS.length)]} as a foundation.
`;
  return { slug, body };
}

function meeting(i: number, r: () => number, peopleSlugs: string[]): Generated {
  const month = (Math.floor(r() * 5) + 1).toString().padStart(2, '0');
  const day = (Math.floor(r() * 28) + 1).toString().padStart(2, '0');
  const topic = TOPICS[Math.floor(r() * TOPICS.length)];
  const slug = `meetings/2026-${month}-${day}-${topic}-${i}`;
  const attendee1 = peopleSlugs[Math.floor(r() * peopleSlugs.length)];
  const attendee2 = peopleSlugs[Math.floor(r() * peopleSlugs.length)];
  const concept = `concepts/${CONCEPTS[Math.floor(r() * CONCEPTS.length)]}`;
  const body = `---
type: meeting
title: ${topic.replace(/-/g, ' ')} sync
date: 2026-${month}-${day}
---

# ${topic.replace(/-/g, ' ')} sync — 2026-${month}-${day}

Attendees: [[${attendee1}]], [[${attendee2}]].

## Notes

Discussed ${topic} and [[${concept}]]. ${attendee1.split('/').pop()} shared progress on ${TOPICS[Math.floor(r() * TOPICS.length)]}.

Next steps to be coordinated via [[${attendee2}]].
`;
  return { slug, body };
}

function deal(i: number, r: () => number, companySlugs: string[]): Generated {
  const c1 = companySlugs[Math.floor(r() * companySlugs.length)];
  const c2 = companySlugs[Math.floor(r() * companySlugs.length)];
  const round = ['seed', 'series-a', 'series-b'][Math.floor(r() * 3)];
  const slug = `deal/${c1.split('/').pop()}-${round}`;
  const amt = (Math.floor(r() * 50) + 2);
  const body = `---
type: deal
title: ${c1.split('/').pop()} ${round}
---

# ${c1.split('/').pop()} ${round}

[[${c1}]] raised $${amt}M ${round} round. Lead investor: [[${c2}]].

## Notes

Round focused on ${TOPICS[Math.floor(r() * TOPICS.length)]} expansion.
`;
  return { slug, body };
}

function daily(i: number, r: () => number, peopleSlugs: string[]): Generated {
  const month = ((i % 5) + 1).toString().padStart(2, '0');
  const day = ((i % 28) + 1).toString().padStart(2, '0');
  const slug = `daily/2026-${month}-${day}-${i}`;
  const p1 = peopleSlugs[Math.floor(r() * peopleSlugs.length)];
  const body = `---
type: daily
title: daily 2026-${month}-${day}
---

# 2026-${month}-${day}

Met with [[${p1}]] about ${TOPICS[Math.floor(r() * TOPICS.length)]}.

Notes on [[concepts/${CONCEPTS[Math.floor(r() * CONCEPTS.length)]}]] — clarifying questions.
`;
  return { slug, body };
}

function original(i: number, r: () => number): Generated {
  const topic = CONCEPTS[i % CONCEPTS.length];
  const slug = `originals/essay-${topic}-${i}`;
  const body = `---
type: original
title: Essay on ${topic.replace(/-/g, ' ')}
---

# On ${topic.replace(/-/g, ' ')}

This is a curated long-form essay on ${topic.replace(/-/g, ' ')}. The core thesis is that ${TOPICS[Math.floor(r() * TOPICS.length)]} drives the next generation of [[concepts/${topic}]].

Reference work includes [[concepts/${CONCEPTS[Math.floor(r() * CONCEPTS.length)]}]] and [[concepts/${CONCEPTS[Math.floor(r() * CONCEPTS.length)]}]].
`;
  return { slug, body };
}

function writing(i: number, r: () => number): Generated {
  const slug = `writing/post-${i}`;
  const topic = TOPICS[i % TOPICS.length];
  const body = `---
type: writing
title: Notes on ${topic.replace(/-/g, ' ')}
---

# Notes on ${topic.replace(/-/g, ' ')}

A short writeup. See [[concepts/${CONCEPTS[Math.floor(r() * CONCEPTS.length)]}]] for background.
`;
  return { slug, body };
}

function project(i: number, r: () => number): Generated {
  const slug = `projects/proj-${i}`;
  const body = `---
type: project
title: Project ${i}
---

# Project ${i}

Internal initiative around ${TOPICS[i % TOPICS.length]}. Owner: [[people/${PEOPLE_GIVENS[i % PEOPLE_GIVENS.length]}-${PEOPLE_SURNAMES[0]}-${i % 30}]].
`;
  return { slug, body };
}

function main(): void {
  if (existsSync(OUTDIR)) rmSync(OUTDIR, { recursive: true });
  mkdirSync(OUTDIR, { recursive: true });

  const r = rng(0x42424242);
  const pages: Generated[] = [];

  // Companies first so people can reference them
  const companies: Generated[] = [];
  for (let i = 0; i < 30; i++) companies.push(company(i, r));
  pages.push(...companies);

  // People reference companies
  const people: Generated[] = [];
  for (let i = 0; i < 50; i++) people.push(person(i, r));
  pages.push(...people);

  // Concepts cross-reference companies + each other
  for (let i = 0; i < 25; i++) pages.push(concept(i, r));

  // Meetings reference people
  for (let i = 0; i < 20; i++) pages.push(meeting(i, r, people.map(p => p.slug)));

  // Deals reference companies
  for (let i = 0; i < 15; i++) pages.push(deal(i, r, companies.map(c => c.slug)));

  // Daily notes
  for (let i = 0; i < 10; i++) pages.push(daily(i, r, people.map(p => p.slug)));

  // Originals
  for (let i = 0; i < 5; i++) pages.push(original(i, r));

  // Writing
  for (let i = 0; i < 5; i++) pages.push(writing(i, r));

  // Projects
  for (let i = 0; i < 5; i++) pages.push(project(i, r));

  // Write to disk: <outdir>/<slug>.md (mkdirSync recursive)
  for (const p of pages) {
    const path = join(OUTDIR, `${p.slug}.md`);
    mkdirSync(join(OUTDIR, p.slug.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(path, p.body, 'utf8');
  }

  // Manifest
  writeFileSync(join(OUTDIR, '_manifest.json'), JSON.stringify({
    schema_version: 1,
    name: 'synthetic-v1',
    pages: pages.length,
    seed: 0x42424242,
    generated_at: '2026-05-23',
    privacy_note: 'All names are placeholders. No PII. Inspired by real brain shape, not content. See eval/generators/synthetic-v1-gen.ts.',
  }, null, 2), 'utf8');

  process.stderr.write(`[gen] wrote ${pages.length} pages to ${OUTDIR}\n`);
}

main();
