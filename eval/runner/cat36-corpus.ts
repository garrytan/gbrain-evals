import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CAT36_DOMAINS = ['constraints', 'preferences', 'commitments', 'changing-decisions', 'causal-context'] as const;
export const CAT36_NORMALIZATION = 'nfc-lf-v1';
export type Cat36Domain = typeof CAT36_DOMAINS[number];
export type Cat36Split = 'dev' | 'holdout';
export interface Cat36Source {
  family_id: string;
  source_id: string;
  slug: string;
  title: string;
  text: string;
  created_at: string;
  updated_at: string;
  visibility: 'public' | 'private' | 'withdrawn';
  role: 'evidence' | 'distractor';
}
export interface Cat36Span {
  id: string;
  family_id: string;
  source_id: string;
  slug: string;
  start: number;
  end: number;
  text: string;
}
export interface Cat36Probe {
  id: string;
  family_id: string;
  kind: 'indirect' | 'direct' | 'negative';
  text: string;
  required_span_ids: string[];
  tags: string[];
}
export interface Cat36Family {
  id: string;
  domain: Cat36Domain;
  split: Cat36Split;
}
export interface Cat36Manifest {
  schema_version: 1;
  normalization: typeof CAT36_NORMALIZATION;
  family_count: number;
  probe_count: number;
  hashes: Record<string, string>;
  review: { status: 'pending-independent-relevance-review' | 'approved'; reviewer?: string; reviewed_hashes?: Record<string, string> };
}
export interface Cat36Corpus {
  manifest: Cat36Manifest;
  cutoff: string;
  sources: Cat36Source[];
  spans: Cat36Span[];
  probes: Cat36Probe[];
  families: Cat36Family[];
}
export interface Cat36Counterfactual {
  id: string;
  family_id: string;
  base_probe_id: string;
  source_id: string;
  slug: string;
  replacement_text: string;
  required_spans: Array<{ id: string; start: number; end: number; text: string }>;
}
export type Cat36BuildSource = Omit<Cat36Source, 'family_id' | 'role'>;

export function cat36Hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalText(text: string): string {
  return text.replace(/\r\n?/g, '\n').normalize('NFC');
}

export function fixturePageId(source: Pick<Cat36Source, 'source_id' | 'slug'>): string {
  return JSON.stringify([source.source_id, source.slug]);
}

export function constructionSources(sources: readonly Cat36Source[]): Cat36BuildSource[] {
  return sources.map(s => ({
    source_id: s.source_id, slug: s.slug, title: s.title, text: canonicalText(s.text),
    created_at: s.created_at, updated_at: s.updated_at, visibility: s.visibility,
  }));
}

function requireUnique(values: string[], label: string): void {
  if (values.some(v => typeof v !== 'string' || !v.trim()) || new Set(values).size !== values.length) {
    throw new Error(`${label}: empty or duplicate identity`);
  }
}

function validateSourceHistory(sources: Cat36Source[], cutoff: string): void {
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('empty source history');
  requireUnique(sources.map(fixturePageId), 'sources');
  const time = Date.parse(cutoff);
  if (!Number.isFinite(time)) throw new Error('invalid construction cutoff');
  for (const source of sources) {
    if ([source.text, source.source_id, source.slug, source.title, source.family_id, source.created_at, source.updated_at].some(v => typeof v !== 'string' || !v.trim())) throw new Error('invalid source');
    if (!['public', 'private', 'withdrawn'].includes(source.visibility) || !['evidence', 'distractor'].includes(source.role)) throw new Error('invalid source policy/role');
    const created = Date.parse(source.created_at), updated = Date.parse(source.updated_at);
    if (!Number.isFinite(created) || !Number.isFinite(updated) || created > updated || updated >= time) throw new Error('source crosses construction cutoff');
    if (canonicalText(source.text) !== source.text) throw new Error('source is not canonical NFC/LF text');
  }
}

export function validateCat36Corpus(c: Cat36Corpus): void {
  if (c.manifest.schema_version !== 1 || c.manifest.normalization !== CAT36_NORMALIZATION) throw new Error('unsupported corpus schema/normalization');
  if (c.families.length !== 120 || c.probes.length !== 480 || c.manifest.family_count !== 120 || c.manifest.probe_count !== 480) {
    throw new Error('Cat36 requires 120 families and 480 probes');
  }
  requireUnique(c.families.map(f => f.id), 'families');
  requireUnique(c.sources.map(fixturePageId), 'sources');
  requireUnique(c.spans.map(s => s.id), 'spans');
  requireUnique(c.probes.map(p => p.id), 'probes');
  const families = new Map(c.families.map(f => [f.id, f]));
  const sources = new Map(c.sources.map(s => [fixturePageId(s), s]));
  const spans = new Map(c.spans.map(s => [s.id, s]));
  validateSourceHistory(c.sources, c.cutoff);
  for (const domain of CAT36_DOMAINS) {
    for (const [split, n] of [['dev', 8], ['holdout', 16]] as const) {
      if (c.families.filter(f => f.domain === domain && f.split === split).length !== n) throw new Error(`invalid split ${domain}/${split}`);
    }
  }
  for (const source of c.sources) {
    if (!families.has(source.family_id)) throw new Error('invalid source family');
  }
  for (const span of c.spans) {
    const source = sources.get(fixturePageId(span));
    if (!source || source.family_id !== span.family_id || source.visibility !== 'public') throw new Error('gold points to foreign or unavailable source');
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > source.text.length
      || source.text.slice(span.start, span.end) !== span.text) throw new Error(`invalid exact source span ${span.id}`);
  }
  for (const probe of c.probes) {
    if (!families.has(probe.family_id) || !['indirect', 'direct', 'negative'].includes(probe.kind) || !probe.text.trim()
      || !Array.isArray(probe.tags) || probe.tags.some(t => typeof t !== 'string')) throw new Error('invalid probe');
    requireUnique(probe.tags, 'probe tags');
    requireUnique(probe.required_span_ids, 'probe gold');
    if ((probe.kind === 'negative') !== (probe.required_span_ids.length === 0)) throw new Error('negative/positive gold mismatch');
    if (probe.required_span_ids.some(id => spans.get(id)?.family_id !== probe.family_id)) throw new Error('probe gold crosses family');
  }
  for (const family of c.families) {
    const probes = c.probes.filter(p => p.family_id === family.id);
    if (probes.length !== 4 || probes.filter(p => p.kind === 'indirect').length !== 2
      || probes.filter(p => p.kind === 'direct').length !== 1 || probes.filter(p => p.kind === 'negative').length !== 1) throw new Error('family probe balance');
    for (const role of ['evidence', 'distractor']) {
      if (!c.sources.some(s => s.family_id === family.id && s.role === role)) throw new Error(`family missing ${role}`);
    }
  }
}

export function loadCat36Sources(dir: string): { manifest: Cat36Manifest; cutoff: string; sources: Cat36Source[] } {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Cat36Manifest;
  if (manifest.schema_version !== 1 || manifest.normalization !== CAT36_NORMALIZATION) throw new Error('unsupported corpus manifest');
  for (const file of ['sources.json', 'probes.json', 'qrels.json', 'splits.json', 'counterfactuals.json']) {
    if (!/^[a-f0-9]{64}$/.test(manifest.hashes[file] ?? '') || cat36Hash(readFileSync(join(dir, file))) !== manifest.hashes[file]) throw new Error(`frozen corpus hash mismatch: ${file}`);
  }
  const data = JSON.parse(readFileSync(join(dir, 'sources.json'), 'utf8'));
  if (data.schema_version !== 1 || data.normalization !== CAT36_NORMALIZATION) throw new Error('unsupported source schema');
  validateSourceHistory(data.sources, data.cutoff);
  return { manifest, cutoff: data.cutoff, sources: data.sources };
}

export function loadCat36Counterfactual(dir: string, id: string): Cat36Counterfactual {
  const { manifest, sources } = loadCat36Sources(dir);
  if (!manifest.hashes['counterfactuals.json']) throw new Error('counterfactual artifact is not frozen');
  const data = JSON.parse(readFileSync(join(dir, 'counterfactuals.json'), 'utf8')) as { schema_version: number; variants: Cat36Counterfactual[] };
  if (data.schema_version !== 1 || !Array.isArray(data.variants)) throw new Error('invalid counterfactual schema');
  requireUnique(data.variants.map(v => v.id), 'counterfactuals');
  const variant = data.variants.find(v => v.id === id);
  if (!variant || !variant.replacement_text.trim() || canonicalText(variant.replacement_text) !== variant.replacement_text) throw new Error('unknown or noncanonical counterfactual');
  const source = sources.find(s => fixturePageId(s) === fixturePageId(variant));
  if (!source || source.family_id !== variant.family_id || source.visibility !== 'public') throw new Error('counterfactual source/family mismatch');
  requireUnique(variant.required_spans.map(s => s.id), 'counterfactual spans');
  if (!variant.required_spans.length) throw new Error('counterfactual needs exact replacement gold');
  for (const span of variant.required_spans) {
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > variant.replacement_text.length
      || variant.replacement_text.slice(span.start, span.end) !== span.text) throw new Error('invalid counterfactual exact span');
  }
  return variant;
}

export function loadCat36Corpus(dir: string): Cat36Corpus {
  const c: Cat36Corpus = {
    ...loadCat36Sources(dir),
    spans: JSON.parse(readFileSync(join(dir, 'qrels.json'), 'utf8')).spans,
    probes: JSON.parse(readFileSync(join(dir, 'probes.json'), 'utf8')).probes,
    families: JSON.parse(readFileSync(join(dir, 'splits.json'), 'utf8')).families,
  };
  validateCat36Corpus(c);
  return c;
}
