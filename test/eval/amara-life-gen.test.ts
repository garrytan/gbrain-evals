/**
 * amara-life-gen tests — cache-key determinism + CLI flag safety.
 *
 * We do NOT invoke Opus in these tests. Per audit fix tests-audit-02 these
 * exercise the REAL exported functions from eval/generators/amara-life-gen.ts
 * (and gen.ts), not local re-implementations, so a silent change to the
 * pinned constants or the key computation fails visibly here.
 *
 * Run: bun test test/eval/amara-life-gen.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  cacheKey,
  canonicalJson,
  sha256,
  perturbationHint,
  parseGenArgs,
  resolveOutputRoot,
  validateManifest,
  MODEL,
  MODEL_PARAMS,
  SCHEMA_VERSION,
  CORPUS_ROOT,
  PREVIEW_ROOT,
  type CacheKeyInput,
  type ManifestItem,
} from '../../eval/generators/amara-life-gen.ts';
import {
  worldCacheKey,
  parseIntFlag,
  MODEL as WORLD_MODEL,
} from '../../eval/generators/gen.ts';
import { buildSkeleton } from '../../eval/generators/amara-life.ts';
import { buildWorld } from '../../eval/generators/world.ts';

describe('amara-life-gen cache key (codex fix #18) — real exported function', () => {
  const baseInput: CacheKeyInput = {
    schema_version: SCHEMA_VERSION,
    template_id: 'email',
    template_hash: 'a'.repeat(64),
    model_id: MODEL,
    model_params: MODEL_PARAMS,
    seed: 42,
    item_spec_hash: 'b'.repeat(64),
  };

  test('golden hash pin: key from the REAL pinned constants matches a known value', () => {
    // If MODEL, MODEL_PARAMS, SCHEMA_VERSION, or the key computation change,
    // this fails visibly instead of silently invalidating the whole cache.
    expect(cacheKey(baseInput)).toBe(
      'b8a8c5f79b127df67924ae042c2b32dcf2663398b7d24b3f621ba667efe7c05d'
    );
  });

  test('same input → same key (determinism)', () => {
    expect(cacheKey(baseInput)).toEqual(cacheKey({ ...baseInput }));
  });

  test('schema_version change invalidates key', () => {
    expect(cacheKey(baseInput)).not.toEqual(cacheKey({ ...baseInput, schema_version: SCHEMA_VERSION + 1 }));
  });

  test('template_hash change invalidates key (prompt tweak invalidates item)', () => {
    const tweaked = { ...baseInput, template_hash: sha256('tweaked template') };
    expect(cacheKey(baseInput)).not.toEqual(cacheKey(tweaked));
  });

  test('model_id change invalidates key (switching Opus versions)', () => {
    expect(cacheKey(baseInput)).not.toEqual(
      cacheKey({ ...baseInput, model_id: 'claude-opus-4-6' })
    );
  });

  test('model_params change invalidates key (temperature tweak)', () => {
    expect(cacheKey(baseInput)).not.toEqual(
      cacheKey({ ...baseInput, model_params: { ...MODEL_PARAMS, temperature: 0.5 } })
    );
  });

  test('seed change invalidates key', () => {
    expect(cacheKey(baseInput)).not.toEqual(cacheKey({ ...baseInput, seed: 7 }));
  });

  test('item_spec_hash change invalidates key', () => {
    const different = { ...baseInput, item_spec_hash: sha256('different item') };
    expect(cacheKey(baseInput)).not.toEqual(cacheKey(different));
  });

  test('key is 64-char hex (sha256)', () => {
    const key = cacheKey(baseInput);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  test('canonical JSON is stable under key reorder', () => {
    // Same content, different insertion order → same canonical serialization.
    const a = { seed: 42, template_id: 'email', schema_version: 1 };
    const b = { schema_version: 1, template_id: 'email', seed: 42 };
    expect(canonicalJson(a)).toEqual(canonicalJson(b));
  });
});

describe('amara-life-gen per-skeleton item-spec hashing', () => {
  test('each email in the skeleton produces a distinct item_spec_hash', () => {
    const skeleton = buildSkeleton();
    const hashes = new Set<string>();
    for (const e of skeleton.emails) {
      hashes.add(sha256(canonicalJson(e)));
    }
    // All 50 emails have distinct spec hashes (determined by id + ts + from + to + subject + perturbation).
    expect(hashes.size).toBe(skeleton.emails.length);
  });

  test('same item across two skeleton builds (same seed) hashes identically', () => {
    const a = buildSkeleton({ seed: 42 });
    const b = buildSkeleton({ seed: 42 });
    expect(sha256(canonicalJson(a.emails[0]))).toEqual(sha256(canonicalJson(b.emails[0])));
  });

  test('adding a perturbation to an item changes its spec hash (fixture edits regenerate that item)', () => {
    const s = buildSkeleton();
    const clean = s.emails.find(e => !e.perturbation)!;
    const marked = { ...clean, perturbation: { kind: 'contradiction' as const, fixture_id: 'c-999' } };
    expect(sha256(canonicalJson(clean))).not.toEqual(sha256(canonicalJson(marked)));
  });
});

describe('perturbation hints thread the fact pair (audit fix generators-01)', () => {
  const s = buildSkeleton();

  test('contradiction primary/counterpart hints state their own value and role', () => {
    const primary = s.emails.find(e => e.perturbation?.fixture_id === 'c-001')!;
    const hint = perturbationHint(primary.perturbation);
    expect(hint).toContain('PRIMARY');
    expect(hint).toContain(primary.perturbation!.fact!.primary_value);
    expect(hint).toContain(primary.perturbation!.fact!.fact_key);
    const counterpart = s.notes.find(n => n.perturbation?.fixture_id === 'c-001')!;
    const cHint = perturbationHint(counterpart.perturbation);
    expect(cHint).toContain('COUNTERPART');
    expect(cHint).toContain(counterpart.perturbation!.fact!.counterpart_value);
  });

  test('stale-fact counterpart hint marks the value as a recent update', () => {
    const counterpart = s.emails.find(
      e => e.perturbation?.fixture_id === 's-001' && e.perturbation.role === 'counterpart'
    )!;
    const hint = perturbationHint(counterpart.perturbation);
    expect(hint).toContain('superseding');
    expect(hint).toContain(counterpart.perturbation!.fact!.counterpart_value);
  });

  test('implicit-preference evidence hint forbids stating the preference', () => {
    const evidence = s.slack.find(m => m.perturbation?.fixture_id === 'pref-002')!;
    const hint = perturbationHint(evidence.perturbation);
    expect(hint).toContain('Never state the preference directly');
    expect(hint).toContain(evidence.perturbation!.evidence_hint!.slice(0, 40));
  });

  test('poison hint contains no leaked string-concatenation syntax (audit fix generators-13)', () => {
    const poison = s.emails.find(e => e.perturbation?.kind === 'poison')!;
    const hint = perturbationHint(poison.perturbation);
    expect(hint).not.toContain('" +');
    expect(hint).not.toContain('+ "');
  });
});

describe('--max safety (audit fix generators-07)', () => {
  test('--max with a positive integer parses', () => {
    expect(parseGenArgs(['--max', '10'])).toEqual({ dryRun: false, force: false, max: 10 });
  });

  test('--max without a value is a hard error, not a silent no-op', () => {
    expect(() => parseGenArgs(['--max'])).toThrow(/--max requires a positive integer/);
  });

  test('--max followed by another flag is a hard error', () => {
    expect(() => parseGenArgs(['--max', '--dry-run'])).toThrow(/--max requires a positive integer/);
  });

  test('--max with NaN / zero / negative / fractional is a hard error', () => {
    for (const bad of ['abc', '0', '-3', '2.5']) {
      expect(() => parseGenArgs(['--max', bad])).toThrow(/--max requires a positive integer/);
    }
  });

  test('truncated (--max) runs route to the preview dir, never the committed corpus', () => {
    expect(resolveOutputRoot({ dryRun: false, max: 10 })).toBe(PREVIEW_ROOT);
  });

  test('dry runs route to the preview dir', () => {
    expect(resolveOutputRoot({ dryRun: true, max: Infinity })).toBe(PREVIEW_ROOT);
  });

  test('only a full real run writes the committed corpus', () => {
    expect(resolveOutputRoot({ dryRun: false, max: Infinity })).toBe(CORPUS_ROOT);
  });

  test('gen.ts --max/--concurrency without a value is a hard error (audit fix generators-12)', () => {
    expect(parseIntFlag(['--max', '240'], '--max', 240)).toBe(240);
    expect(parseIntFlag([], '--max', 240)).toBe(240);
    expect(() => parseIntFlag(['--max'], '--max', 240)).toThrow(/--max requires a positive integer/);
    expect(() => parseIntFlag(['--concurrency', '--dry-run'], '--concurrency', 1))
      .toThrow(/--concurrency requires a positive integer/);
  });
});

describe('manifest validation (audit fix generators-17)', () => {
  const validItem: ManifestItem = {
    slug: 'emails/em-0000',
    path: 'inbox/emails.jsonl',
    type: 'email',
    content_sha256: 'a'.repeat(64),
  };
  const validManifest = () => ({
    schema_version: 1,
    corpus_id: 'amara-life-v1',
    generated_at: '2026-04-19T00:00:00.000Z',
    items: [validItem],
  });

  test('a valid manifest passes', () => {
    expect(() => validateManifest(validManifest(), 1)).not.toThrow();
  });

  test('item count mismatch fails', () => {
    expect(() => validateManifest(validManifest(), 2)).toThrow(/items.length=1 but expected 2/);
  });

  test('unknown item type fails against the schema enum', () => {
    const m = validManifest();
    m.items = [{ ...validItem, type: 'doc' }];
    expect(() => validateManifest(m, 1)).toThrow(/not in schema enum/);
  });

  test('unknown item property fails (additionalProperties: false)', () => {
    const m = validManifest();
    m.items = [{ ...validItem, bogus: true } as unknown as ManifestItem];
    expect(() => validateManifest(m, 1)).toThrow(/unknown property 'bogus'/);
  });

  test('duplicate slug fails', () => {
    const m = validManifest();
    m.items = [validItem, { ...validItem }];
    expect(() => validateManifest(m, 2)).toThrow(/duplicate slug/);
  });
});

describe('world-v1 cache key (audit fix generators-04) — real exported function', () => {
  const world = buildWorld(42);
  const entity = world.people[0];

  test('same entity → same key (determinism)', () => {
    expect(worldCacheKey(entity)).toEqual(worldCacheKey({ ...entity }));
  });

  test('key is 64-char hex and model is pinned', () => {
    expect(worldCacheKey(entity)).toMatch(/^[a-f0-9]{64}$/);
    expect(WORLD_MODEL).toBe('claude-opus-4-5');
  });

  test('changed facts invalidate the key (slug alone no longer suffices)', () => {
    const renamed = { ...entity, name: entity.name + ' Jr.' };
    expect(worldCacheKey(renamed)).not.toEqual(worldCacheKey(entity));
  });

  test('different slugs produce different keys', () => {
    expect(worldCacheKey(world.people[0])).not.toEqual(worldCacheKey(world.people[1]));
  });
});
