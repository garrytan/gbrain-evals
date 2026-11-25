/**
 * person-isolation-v1: a seeded multi-person brain for the per-person memory isolation fuzz
 * (docs/benchmarks/2026-11-24-person-isolation-preregistration.md).
 *
 * Six enabled members and one who leaves, chosen so an identity check that slips shows up: P2's member id is P1's
 * plus a suffix (a slug-prefix collision) and P2's external id is P1's in lower case (ids compare exactly); P3 has an
 * email id, P4 an oidc subject, P5 shares a group with P1, P6 saves nothing (the ghost), and D writes and is then
 * disabled. Each writing member holds seven channels, each carrying its own canary word that appears nowhere else.
 * Shared pages use the same topic words with public markers, so a probe that reads only world content still has
 * something to show. Everything is fictional and deterministic in the seed.
 */
import { createHash } from 'node:crypto';

export const PI_GENERATOR_VERSION = 'person-isolation-v1';
export const PI_DEFAULT_SEED = 20261124;
export const PI_COUNTED_SEEDS = [20261124, 20261125, 20261126] as const;

export type PIRole = 'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'p6' | 'left';
export type PIChannel = 'memory_write' | 'remember_key' | 'remember_about' | 'readable_by' | 'dm_source' | 'folder' | 'proposal';
export const PI_CHANNELS: readonly PIChannel[] = ['memory_write', 'remember_key', 'remember_about', 'readable_by', 'dm_source', 'folder', 'proposal'];

export interface PIMember { role: PIRole; id: string; ext: string; name: string; groups: string[]; writes: boolean; dm_source: string; folder: string }
export interface PIPage { source_id: string; slug: string; content: string; protected_for: string | null }
export interface PIFactWrite { fact: string; provenance: string; kind?: string; valid_from?: string }
export interface PIHolding {
  member: string;
  canaries: Record<PIChannel, string>;
  memory_write: PIFactWrite[];
  remember_key: { fact: string; entity: string };
  remember_about: { fact: string; entity: string; colleague: string };
  readable_by: PIPage;
  dm_source: PIPage;
  folder: PIPage;
  proposal: { target: string; date: string; summary: string };
}
export interface PIWorld {
  version: string;
  seed: number;
  team_source: string;
  topic: string;
  company: { slug: string; name: string };
  project: { slug: string; name: string };
  members: PIMember[];
  group: string;
  pages: PIPage[];
  holdings: PIHolding[];
  public_markers: string[];
  public_fact: { fact: string; entity: string; marker: string };
  ghost_member: string;
  ledger_hash: string;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['ann', 'bram', 'cleo', 'dov', 'esme', 'fitz', 'gale', 'hugo', 'ines', 'joss', 'kaya', 'lior', 'mira', 'noor', 'otto', 'pia'];
const LAST = ['harlow', 'quist', 'ferro', 'lund', 'okafor', 'brandt', 'sato', 'vale', 'moreau', 'ibsen'];
const TOPICS = [['lighthouse', 'budget'], ['harbor', 'ledger'], ['orchard', 'roadmap'], ['granite', 'audit'], ['meadow', 'pricing'], ['cobalt', 'launch']];
const COMPANIES = ['Tidewater', 'Kestrel', 'Marlowe', 'Brightfern', 'Saltmarsh', 'Quillon'];
const LETTERS = 'bcdfghjklmnpqrstvwxz';

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const fm = (fields: Record<string, string>) => '---\n' + Object.entries(fields).map(([k, v]) => k + ': ' + v).join('\n') + '\n---\n';

export function generatePersonWorld(seed: number = PI_DEFAULT_SEED): PIWorld {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const used = new Set<string>();
  const canary = (): string => {
    for (;;) {
      let w = 'pi';
      for (let i = 0; i < 10; i++) w += LETTERS[Math.floor(r() * LETTERS.length)];
      if (!used.has(w)) { used.add(w); return w; }
    }
  };
  const firsts = [...FIRST];
  for (let i = firsts.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [firsts[i], firsts[j]] = [firsts[j]!, firsts[i]!]; }
  const [tw1, tw2] = pick(TOPICS);
  const topic = tw1 + ' ' + tw2;
  const companyName = pick(COMPANIES);
  const company = { slug: 'companies/' + companyName.toLowerCase(), name: companyName };
  const project = { slug: 'projects/' + tw1, name: cap(tw1) };
  const slack = () => 'U0' + Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'[Math.floor(r() * 34)]).join('');
  const group = 'crew-' + firsts[7];
  const p1 = firsts[0]!;
  const p1ext = slack();
  const spec: Array<[PIRole, string, string, boolean]> = [
    ['p1', p1, p1ext, true],
    ['p2', p1 + '-lee', p1ext.toLowerCase(), true],
    ['p3', firsts[1]!, firsts[1] + '@' + companyName.toLowerCase() + '-example.test', true],
    ['p4', firsts[2]!, 'oidc:' + createHash('sha256').update(String(seed)).digest('hex').slice(0, 4) + ':' + firsts[2], true],
    ['p5', firsts[3]!, slack(), true],
    ['p6', firsts[4]!, slack(), false],
    ['left', firsts[5]!, slack(), true],
  ];
  const members: PIMember[] = spec.map(([role, id, ext, writes]) => ({
    role, id, ext, writes,
    name: cap(id.split('-')[0]!) + ' ' + cap(pick(LAST)),
    groups: role === 'p1' || role === 'p5' ? [group] : [],
    dm_source: 'dm-' + id,
    folder: 'private/' + id + '/',
  }));
  const writers = members.filter(m => m.writes);
  const publicMarkers: string[] = [];
  const pub = () => { const m = 'pub' + canary().slice(2); publicMarkers.push(m); return m; };
  const pages: PIPage[] = [];
  const team = 'team';
  pages.push({ source_id: team, slug: company.slug, protected_for: null, content: fm({ type: 'company', title: companyName }) + '# ' + companyName + '\n\n' + companyName + ' runs the ' + topic + ' review ' + pub() + ' with [' + project.name + '](../' + project.slug + '.md).\n' });
  pages.push({ source_id: team, slug: project.slug, protected_for: null, content: fm({ type: 'project', title: project.name }) + '# ' + project.name + '\n\nThe ' + topic + ' plan for ' + project.name + ' ' + pub() + ', owned by [' + companyName + '](../' + company.slug + '.md).\n' });
  for (const m of members) {
    pages.push({ source_id: team, slug: 'people/' + m.id, protected_for: null, content: fm({ type: 'person', title: m.name }) + '# ' + m.name + '\n\n' + m.name + ' works on the ' + topic + ' at [' + companyName + '](../' + company.slug + '.md) ' + pub() + '.\n' });
  }
  pages.push({ source_id: team, slug: 'notes/public-' + tw1, protected_for: null, content: fm({ type: 'note', title: cap(tw1) + ' public notes' }) + '# ' + cap(tw1) + ' public notes\n\nShared ' + topic + ' notes ' + pub() + ' about [' + companyName + '](../' + company.slug + '.md).\n' });
  const holdings: PIHolding[] = writers.map((m, i) => {
    const colleague = writers[(i + 1) % writers.length]!;
    const c = Object.fromEntries(PI_CHANNELS.map(ch => [ch, canary()])) as Record<PIChannel, string>;
    const readable: PIPage = { source_id: team, slug: 'notes/' + m.id + '-' + tw1, protected_for: m.id, content: fm({ type: 'note', title: m.name + ' ' + tw1 + ' notes', readable_by: '[member:' + m.id + ']' }) + '# ' + m.name + ' ' + tw1 + ' notes\n\nDraft of the ' + topic + ' ' + c.readable_by + ' for [' + companyName + '](../' + company.slug + '.md).\n' };
    const dm: PIPage = { source_id: m.dm_source, slug: 'chats/' + tw1 + '-thread', protected_for: m.id, content: fm({ type: 'note', title: cap(tw1) + ' thread' }) + '# ' + cap(tw1) + ' thread\n\n' + m.name + ' talked about the ' + topic + ' ' + c.dm_source + ' with ' + companyName + '.\n' };
    const folder: PIPage = { source_id: team, slug: m.folder + tw1 + '-plan', protected_for: m.id, content: fm({ type: 'note', title: m.name + ' ' + tw1 + ' plan' }) + '# ' + m.name + ' ' + tw1 + ' plan\n\nPersonal ' + topic + ' plan ' + c.folder + ' for [' + companyName + '](../../' + company.slug + '.md).\n' };
    return {
      member: m.id,
      canaries: c,
      memory_write: [
        { fact: m.name + ' prefers the ' + topic + ' review on Tuesdays ' + c.memory_write, provenance: 'turn 1' },
        { fact: m.name + ' met ' + companyName + ' about the ' + topic + ' ' + c.memory_write, provenance: 'turn 2', kind: 'event', valid_from: '2026-09-1' + (i % 9) },
      ],
      remember_key: { fact: m.name + ' owns the ' + companyName + ' ' + topic + ' ' + c.remember_key, entity: company.slug },
      remember_about: { fact: colleague.name + ' is late on the ' + topic + ' ' + c.remember_about, entity: 'people/' + colleague.id, colleague: colleague.id },
      readable_by: readable,
      dm_source: dm,
      folder,
      proposal: { target: company.slug, date: '2026-10-0' + (1 + (i % 8)), summary: m.name + ' proposes a ' + topic + ' checkpoint ' + c.proposal },
    };
  });
  for (const h of holdings) pages.push(h.readable_by, h.dm_source, h.folder);
  const publicFactMarker = pub();
  const world: Omit<PIWorld, 'ledger_hash'> = {
    version: PI_GENERATOR_VERSION, seed, team_source: team, topic, company, project, members, group, pages, holdings,
    public_markers: publicMarkers,
    public_fact: { fact: companyName + ' scheduled the ' + topic + ' review ' + publicFactMarker, entity: company.slug, marker: publicFactMarker },
    ghost_member: members.find(m => m.role === 'p6')!.id,
  };
  return { ...world, ledger_hash: createHash('sha256').update(JSON.stringify(world)).digest('hex') };
}

/** Every canary a member holds, for scanning responses to anyone else. */
export function canariesOf(world: Pick<PIWorld, 'holdings'>, member: string): string[] {
  const h = world.holdings.find(x => x.member === member);
  return h ? Object.values(h.canaries) : [];
}
