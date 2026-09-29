/**
 * Lifecycle experiment scenario and evaluator-side ground-truth ledger.
 *
 * The ledger is written by the evaluator from the files it authors and the
 * memory calls it makes. It never asks gbrain what the right answer is: no
 * doctor, integrity or invariant check is used as an oracle. Every authored
 * file carries a unique canary token per version, so a page's identity is
 * decided by which canary its stored text contains, not by its slug.
 *
 * All names are fictional placeholders.
 */

export type Visibility = 'world' | 'private';

export interface FileVersion {
  /** Path relative to the vault root. */
  path: string;
  canary: string;
  title: string;
  type: string;
  visibility: Visibility;
  /** Frontmatter `id`, when the file carries one. */
  fmId?: string;
  tags?: string[];
  /** Body prose (without frontmatter). May include wikilinks. */
  body: string;
  /** Identity ids this version links to, by author intent. */
  links: string[];
  /** Dated timeline bullets written in this version. */
  timeline: Array<{ date: string; summary: string }>;
}

export interface Identity {
  id: string;
  /** Which vault the file lives in. Defaults to the main vault. */
  source?: SourceName;
  /** Versions keyed by the phase that introduced them. */
  versions: Partial<Record<PhaseName, FileVersion | null>>;
}

export type PhaseName = 'ingest' | 'outage' | 'correct';

/**
 * `vault` is the main vault. `collide` holds a slug collision and `sharedid`
 * holds two notes that reuse one frontmatter id. Each hazard lives in its own
 * vault with a bystander note that sorts after it, so a hazard that stops a
 * sync shows its blast radius without hiding every other measurement. The
 * two hazard vaults are measured by the local observer only.
 */
export type SourceName = 'vault' | 'collide' | 'sharedid';
export const SOURCES: SourceName[] = ['vault', 'collide', 'sharedid'];

export const PHASE_ORDER: PhaseName[] = ['ingest', 'outage', 'correct'];

function fm(v: Omit<FileVersion, 'body' | 'links' | 'timeline'>): string {
  const lines = ['---', `title: ${v.title}`, `type: ${v.type}`];
  if (v.fmId) lines.push(`id: ${v.fmId}`);
  if (v.visibility === 'private') lines.push('visibility: private');
  if (v.tags?.length) lines.push(`tags: [${v.tags.join(', ')}]`);
  lines.push('---', '');
  return lines.join('\n');
}

export function renderFile(v: FileVersion): string {
  let text = fm(v) + v.body.trim() + '\n';
  if (v.timeline.length) {
    text += '\n## Timeline\n' + v.timeline.map(t => `- **${t.date}** | ${t.summary}`).join('\n') + '\n';
  }
  return text;
}

function person(path: string, canary: string, title: string, extra: Partial<FileVersion> = {}): FileVersion {
  return {
    path, canary, title, type: 'person', visibility: 'world', links: [], timeline: [],
    body: `${title} is a fictional person used by the lifecycle experiment. Marker ${canary}.`,
    ...extra,
  };
}

function company(path: string, canary: string, title: string): FileVersion {
  return {
    path, canary, title, type: 'company', visibility: 'world', links: [], timeline: [],
    body: `${title} is a fictional company used by the lifecycle experiment. Marker ${canary}.`,
  };
}

function note(path: string, canary: string, title: string, body: string, links: string[], extra: Partial<FileVersion> = {}): FileVersion {
  return { path, canary, title, type: 'note', visibility: 'world', links, timeline: [], body: `${body}\n\nMarker ${canary}.`, ...extra };
}

/**
 * The identities. `versions.ingest` is the first committed state; `outage`
 * adds files while the embedding provider is down; `correct` is the edit
 * commit (moves, renames, removed links, corrected bullets, deletions).
 * A `null` version means the file is deleted in that phase.
 */
export const IDENTITIES: Identity[] = [
  { id: 'alice', versions: { ingest: person('people/alice-example.md', 'cnryalice1v1', 'Alice Example') } },
  { id: 'bob', versions: { ingest: person('people/bob-example.md', 'cnrybob1v1', 'Bob Example') } },
  { id: 'frank', versions: { ingest: person('people/frank-example.md', 'cnryfrank1v1', 'Frank Example') } },
  {
    id: 'carol',
    versions: {
      ingest: person('people/carol-example.md', 'cnrycarol1v1', 'Carol Example', {
        timeline: [
          { date: '2023-06-15', summary: 'Spoke at a robotics meetup' },
          { date: '2024-03-01', summary: 'Joined Acme Example as CTO' },
        ],
      }),
      correct: person('people/carol-example.md', 'cnrycarol1v2', 'Carol Example', {
        timeline: [
          { date: '2023-06-15', summary: 'Spoke at a robotics meetup' },
          { date: '2024-04-01', summary: 'Joined Acme Example as VP Engineering' },
        ],
      }),
    },
  },
  { id: 'exacheng', versions: { ingest: person('people/exa-cheng.md', 'cnryexacheng1v1', 'Exa Cheng') } },
  { id: 'acmerobotics', versions: { ingest: company('companies/acme-robotics.md', 'cnryacmerob1v1', 'Acme Robotics') } },
  { id: 'acme', versions: { ingest: company('companies/acme-example.md', 'cnryacme1v1', 'Acme Example') } },
  {
    id: 'notea',
    versions: {
      ingest: note('notes/a.md', 'cnrynotea1v1', 'Planning note A',
        'Planning with [[people/alice-example]] and [[people/bob-example]] for [[companies/acme-example]].',
        ['alice', 'bob', 'acme']),
      correct: note('notes/a.md', 'cnrynotea1v2', 'Planning note A',
        'Planning with [[people/alice-example]] for [[companies/acme-example]].',
        ['alice', 'acme']),
    },
  },
  {
    id: 'nearnames',
    versions: {
      ingest: note('notes/near-names.md', 'cnrynearname1v1', 'Near-name mentions',
        'Met [[Exa Chen]] from [[Acme Robotic Arms]]. Neither has a page in this vault.', []),
    },
  },
  {
    id: 'nearcontrol',
    versions: {
      ingest: note('notes/near-names-control.md', 'cnrynearctl1v1', 'Exact-name mentions',
        'Met [[Exa Cheng]] from [[Acme Robotics]].', ['exacheng', 'acmerobotics']),
    },
  },
  {
    id: 'standup',
    versions: {
      ingest: note('inbox/standup.md', 'cnrystandup1v1', 'Weekly standup',
        'Standup notes. [[people/carol-example]] presented the roadmap.', ['carol'], { fmId: 'lc-standup-0001' }),
      correct: note('meetings/standup.md', 'cnrystandup1v1', 'Weekly standup',
        'Standup notes. [[people/carol-example]] presented the roadmap.', ['carol'], { fmId: 'lc-standup-0001' }),
    },
  },
  {
    id: 'templatea',
    source: 'sharedid',
    versions: {
      ingest: note('notes/template-a.md', 'cnrytmpla1v1', 'Template user A',
        'First note created from a shared template. Topic: garden irrigation.', [], { fmId: 'lc-template-shared' }),
    },
  },
  {
    id: 'templateb',
    source: 'sharedid',
    versions: {
      ingest: note('notes/template-b.md', 'cnrytmplb1v1', 'Template user B',
        'Second note created from the same template. Topic: bicycle repair.', [], { fmId: 'lc-template-shared' }),
      correct: note('notes/template-b.md', 'cnrytmplb1v2', 'Template user B',
        'Second note created from the same template, now edited. Topic: bicycle repair and tires.', [], { fmId: 'lc-template-shared' }),
    },
  },
  {
    id: 'foobarspace',
    source: 'collide',
    versions: { ingest: note('notes/Foo Bar.md', 'cnryfoobarsp1v1', 'Foo Bar (spaced file name)', 'Apples and orchards.', []) },
  },
  {
    id: 'foobardash',
    source: 'collide',
    versions: { ingest: note('notes/foo-bar.md', 'cnryfoobards1v1', 'foo-bar (dashed file name)', 'Oranges and groves.', []) },
  },
  {
    id: 'bystander',
    source: 'collide',
    versions: { ingest: note('notes/zz-bystander.md', 'cnrybystand1v1', 'Bystander', 'An ordinary note that sorts after the colliding pair.', []) },
  },
  {
    id: 'bystandershared',
    source: 'sharedid',
    versions: { ingest: note('notes/zz-bystander.md', 'cnrybystsh1v1', 'Bystander', 'An ordinary note that sorts after the notes sharing an id.', []) },
  },
  {
    id: 'erin',
    versions: {
      ingest: person('people/erin-example.md', 'cnryerin1v1', 'Erin Example'),
      correct: person('people/erin-example-2.md', 'cnryerin1v1', 'Erin Example'),
    },
  },
  {
    id: 'noteb',
    versions: {
      ingest: note('notes/b.md', 'cnrynoteb1v1', 'Note B', 'Follow up with [[people/erin-example]] next week.', ['erin']),
    },
  },
  {
    id: 'dave',
    versions: {
      ingest: person('people/dave-example.md', 'cnrydave1v1', 'Dave Example', {
        visibility: 'private',
        tags: ['cnrydavetag1'],
        timeline: [{ date: '2024-05-05', summary: 'cnrydavetl1 private offsite planning' }],
      }),
    },
  },
  {
    id: 'dan',
    versions: {
      ingest: person('people/dan-example.md', 'cnrydan1v1', 'Dan Example', {
        tags: ['cnrydantag1'],
        timeline: [{ date: '2024-05-06', summary: 'cnrydantl1 public offsite planning' }],
      }),
    },
  },
  {
    id: 'team',
    versions: {
      ingest: note('notes/team.md', 'cnryteam1v1', 'Team list',
        'Team: [[people/dave-example]] and [[people/dan-example]].', ['dave', 'dan']),
    },
  },
  {
    id: 'obsolete',
    versions: {
      ingest: note('notes/obsolete.md', 'cnryobsolete1v1', 'Obsolete note', 'This note is deleted in the correction commit.', []),
      correct: null,
    },
  },
  {
    id: 'outage1',
    versions: {
      outage: note('notes/outage-1.md', 'cnryoutage1v1', 'Written during outage 1',
        'Imported while the embedding provider was down. Mentions [[people/alice-example]].', ['alice']),
    },
  },
  {
    id: 'outage2',
    versions: { outage: note('notes/outage-2.md', 'cnryoutage2v1', 'Written during outage 2', 'Imported while the embedding provider was down. Topic: tide tables.', []) },
  },
  {
    id: 'outage3',
    versions: { outage: note('notes/outage-3.md', 'cnryoutage3v1', 'Written during outage 3', 'Imported while the embedding provider was down. Topic: bread starters.', []) },
  },
];

export const OUTAGE_IDS = ['outage1', 'outage2', 'outage3'];
/** Identities in the hazard vaults, scored by the local observer only. */
export const HAZARD_IDS = IDENTITIES.filter(i => i.source && i.source !== 'vault').map(i => i.id);
/** Text only a document chunk of an outage file contains (queries are just the marker). */
export const OUTAGE_BODY_PHRASE = 'embedding provider was down';
export const PRIVATE_ID = 'dave';
/** Slugs that files held before the correction commit moved or renamed them, and who owns them. */
export const MOVED: Array<{ id: string; old_slug: string }> = [
  { id: 'standup', old_slug: 'inbox/standup' },
  { id: 'erin', old_slug: 'people/erin-example' },
];
export const OLD_SLUGS = MOVED.map(m => m.old_slug);
export const PUBLIC_TWIN_ID = 'dan';
export const NEAR_NAME_WRONG_TARGETS = ['exacheng', 'acmerobotics'];
export const NEAR_NAME_SOURCE = 'nearnames';

/** The current version of an identity after `phase` has been applied. */
export function versionAt(identity: Identity, phase: PhaseName): FileVersion | null {
  let current: FileVersion | null = null;
  for (const p of PHASE_ORDER) {
    if (p in identity.versions) current = identity.versions[p] ?? null;
    if (p === phase) break;
  }
  return current;
}

export function identityById(id: string): Identity {
  const found = IDENTITIES.find(i => i.id === id);
  if (!found) throw new Error(`unknown identity ${id}`);
  return found;
}

/** Every canary an identity has ever carried, oldest first. */
export function allCanaries(identity: Identity): string[] {
  const out: string[] = [];
  for (const p of PHASE_ORDER) {
    const v = identity.versions[p];
    if (v && !out.includes(v.canary)) out.push(v.canary);
  }
  return out;
}

/** Slug gbrain would derive from a path, used only to label paths the ledger once owned. */
export function naiveSlug(path: string): string {
  return path.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9/]+/g, '-').replace(/-+/g, '-').replace(/(^-|-$)/g, '');
}

export interface Expected {
  phase: PhaseName;
  /** Live identity id -> its current version. */
  files: Map<string, FileVersion>;
  /** (from identity, to identity) pairs, both endpoints live and visible to the observer. */
  edges: Set<string>;
  /** identity|date|summary triples. */
  timeline: Set<string>;
}

export function edgeKey(from: string, to: string): string { return `${from}->${to}`; }
export function timelineKey(id: string, date: string, summary: string): string {
  return `${id}|${date}|${summary.trim().toLowerCase()}`;
}

/**
 * Expected state after `phase`, as seen by an observer. A remote observer
 * must not see private files, so they are removed from its expectations;
 * whether they leak is measured separately by the leak probes.
 */
export function expectedAt(phase: PhaseName, observer: 'local' | 'remote'): Expected {
  const files = new Map<string, FileVersion>();
  for (const identity of IDENTITIES) {
    const v = versionAt(identity, phase);
    if (!v) continue;
    if (observer === 'remote' && (v.visibility === 'private' || (identity.source ?? 'vault') !== 'vault')) continue;
    files.set(identity.id, v);
  }
  const edges = new Set<string>();
  const timeline = new Set<string>();
  for (const [id, v] of files) {
    for (const to of v.links) if (files.has(to)) edges.add(edgeKey(id, to));
    for (const t of v.timeline) timeline.add(timelineKey(id, t.date, t.summary));
  }
  return { phase, files, edges, timeline };
}

/** Memory calls the evaluator makes, and what the ledger expects of each. */
export interface FactSpec {
  key: string;
  entity: string;
  fact: string;
  /** Identity that owns the fact by author intent, or null when no page exists. */
  owner: string | null;
  /** When the fact is written. */
  when: 'after_ingest' | 'after_forget';
}

export const FACTS: FactSpec[] = [
  { key: 'alice_email', entity: 'people/alice-example', fact: 'Prefers email', owner: 'alice', when: 'after_ingest' },
  { key: 'bob_email', entity: 'people/bob-example', fact: 'Prefers email', owner: 'bob', when: 'after_ingest' },
  { key: 'alice_maps', entity: 'people/alice-example', fact: 'Collects vintage maps cnryfactmaps1', owner: 'alice', when: 'after_ingest' },
  { key: 'exachen_lang', entity: 'people/exa-chen', fact: 'Speaks Portuguese cnryfactexa1', owner: null, when: 'after_ingest' },
  { key: 'frank_email', entity: 'people/frank-example', fact: 'Prefers email', owner: 'frank', when: 'after_forget' },
];

/** The fact the evaluator forgets. The others must survive. */
export const FORGET_KEY = 'alice_email';

export const CHECKPOINTS = ['ingest', 'outage', 'correct', 'reconcile', 'forget', 'restart'] as const;
export type Checkpoint = typeof CHECKPOINTS[number];

/** The file phase whose ledger applies at each checkpoint. */
export function filePhaseAt(cp: Checkpoint): PhaseName {
  if (cp === 'ingest') return 'ingest';
  if (cp === 'outage') return 'outage';
  return 'correct';
}
