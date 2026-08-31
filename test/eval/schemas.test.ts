/**
 * BrainBench v1 portable JSON schemas — self-validation + round-trip.
 *
 * These schemas are the v1→v2 contract boundary. v2 Inspect AI Agent Bridge
 * consumes the same schemas. Any schema change is a CONTRACT break.
 *
 * Test scope (Day 1 deliverable):
 *   - Every schema is syntactically valid JSON
 *   - Every schema declares $schema, $id, title, type
 *   - Every gold template is syntactically valid JSON with a `version` field
 *   - Round-trip: JSON.stringify(JSON.parse(content)) is stable under re-parse
 *
 * A fuller JSON Schema meta-validation (draft 2020-12 compliance) will land
 * when ajv is added as a devDependency in a later pass. The structural
 * checks here catch the common failure modes (missing header fields, typos).
 */

import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const SCHEMAS_DIR = join(import.meta.dir, '../../eval/schemas');
const GOLD_DIR = join(import.meta.dir, '../../eval/data/gold');

const EXPECTED_SCHEMAS = [
  'corpus-manifest.schema.json',
  'public-probe.schema.json',
  'receipt.schema.json',
  'tool-schema.schema.json',
  'transcript.schema.json',
  'scorecard.schema.json',
  'evidence-contract.schema.json',
];

const EXPECTED_GOLD = [
  'entities.json',
  'backlinks.json',
  'qrels.json',
  'contradictions.json',
  'poison.json',
  'personalization-rubric.json',
  'implicit-preferences.json',
  'citations.json',
];

// Files that colocate in eval/data/gold/ but are NOT canonical gold templates
// (they use their own schema, e.g. `schema_version` instead of the `version`
// int contract). Excluded from the exact-set + per-template assertions below.
// brainbench-cat13-embedder-subset.json is a hand-curated query subset for the
// embedder shootout (added in 89445dd), not a gold-truth template.
const NON_TEMPLATE_GOLD = [
  'brainbench-cat13-embedder-subset.json',
];

describe('eval/schemas — portable JSON schemas', () => {
  test('all expected schema files exist', () => {
    const found = readdirSync(SCHEMAS_DIR).filter(f => f.endsWith('.schema.json')).sort();
    expect(found).toEqual([...EXPECTED_SCHEMAS].sort());
  });

  for (const filename of EXPECTED_SCHEMAS) {
    describe(filename, () => {
      const path = join(SCHEMAS_DIR, filename);
      const content = readFileSync(path, 'utf8');

      test('parses as valid JSON', () => {
        expect(() => JSON.parse(content)).not.toThrow();
      });

      test('declares $schema, $id, title, type', () => {
        const schema = JSON.parse(content);
        expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
        expect(typeof schema.$id).toBe('string');
        expect(schema.$id.startsWith('https://brainbench.dev/schemas/')).toBe(true);
        expect(typeof schema.title).toBe('string');
        expect(schema.type).toBe('object');
      });

      test('round-trips under stringify/parse', () => {
        const a = JSON.parse(content);
        const b = JSON.parse(JSON.stringify(a));
        expect(b).toEqual(a);
      });
    });
  }
});

describe('eval/data/gold — template files', () => {
  test('all expected gold templates exist', () => {
    const found = readdirSync(GOLD_DIR)
      .filter(f => f.endsWith('.json'))
      .filter(f => !NON_TEMPLATE_GOLD.includes(f))
      .sort();
    expect(found).toEqual([...EXPECTED_GOLD].sort());
  });

  for (const filename of EXPECTED_GOLD) {
    describe(filename, () => {
      const path = join(GOLD_DIR, filename);
      const content = readFileSync(path, 'utf8');

      test('parses as valid JSON', () => {
        expect(() => JSON.parse(content)).not.toThrow();
      });

      test('has a `version` field (int)', () => {
        const data = JSON.parse(content);
        expect(typeof data.version).toBe('number');
        expect(Number.isInteger(data.version)).toBe(true);
      });

      test('round-trips under stringify/parse', () => {
        const a = JSON.parse(content);
        const b = JSON.parse(JSON.stringify(a));
        expect(b).toEqual(a);
      });
    });
  }
});

describe('schema / template coherence', () => {
  test('every schema has a type enum that includes new Page types', () => {
    const manifest = JSON.parse(
      readFileSync(join(SCHEMAS_DIR, 'corpus-manifest.schema.json'), 'utf8')
    );
    const typeEnum = manifest.properties?.items?.items?.properties?.type?.enum ?? [];
    for (const expected of ['email', 'slack', 'calendar-event', 'note']) {
      expect(typeEnum).toContain(expected);
    }
  });

  test('tool-schema pins exactly 12 read tools + 3 dry_run tools', () => {
    const toolSchema = JSON.parse(
      readFileSync(join(SCHEMAS_DIR, 'tool-schema.schema.json'), 'utf8')
    );
    expect(toolSchema.properties.read_tools.minItems).toBe(12);
    expect(toolSchema.properties.read_tools.maxItems).toBe(12);
    expect(toolSchema.properties.dry_run_tools.minItems).toBe(3);
    expect(toolSchema.properties.dry_run_tools.maxItems).toBe(3);
  });

  test('tool-schema caps tool output at 32K tokens', () => {
    const toolSchema = JSON.parse(
      readFileSync(join(SCHEMAS_DIR, 'tool-schema.schema.json'), 'utf8')
    );
    expect(toolSchema.properties.tool_output_max_tokens.const).toBe(32768);
  });

  test('scorecard N must be 1 | 5 | 10 (smoke | iteration | published)', () => {
    const scorecard = JSON.parse(
      readFileSync(join(SCHEMAS_DIR, 'scorecard.schema.json'), 'utf8')
    );
    expect(scorecard.properties.N.enum).toEqual([1, 5, 10]);
  });
});

// ─── Regression: schema ↔ code contract drift (audit 2026-08-31) ──────

describe('public-probe schema matches the shrunk PublicQuery surface (data-integrity-06)', () => {
  const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, 'public-probe.schema.json'), 'utf8'));

  test('properties are exactly {id, text, as_of_date} — the sealed surface from types.ts sanitizeQuery', () => {
    expect(Object.keys(schema.properties).sort()).toEqual(['as_of_date', 'id', 'text']);
    expect([...schema.required].sort()).toEqual(['id', 'text']);
    expect(schema.additionalProperties).toBe(false);
  });

  test('no classification-signal field survives in the schema (tier/tags/expected_output_type/etc.)', () => {
    for (const leaked of ['tier', 'tags', 'expected_output_type', 'gold', 'acceptable_variants', 'known_failure_modes', 'author']) {
      expect(leaked in schema.properties).toBe(false);
    }
  });

  test('id pattern accepts every real probe-id family', () => {
    const re = new RegExp(schema.properties.id.pattern);
    for (const id of ['q-0001', 'c13-00001', 'sig-0001', 's-briefing-1']) {
      expect(re.test(id)).toBe(true);
    }
    expect(re.test('')).toBe(false);
  });

  test('as_of_date branches are disjoint under a non-asserting validator (data-integrity-07)', () => {
    // Under draft 2020-12, `format` is annotation-only by default, so a
    // format:date branch also matches the sentinels and oneOf (exactly-one)
    // failed on exactly the values the schema means to allow. The fix uses
    // anyOf + an asserting pattern; prove the branches no longer overlap.
    const branches = schema.properties.as_of_date.anyOf;
    expect(Array.isArray(branches)).toBe(true);
    const dateBranch = branches[0];
    const sentinelBranch = branches[1];
    expect(typeof dateBranch.pattern).toBe('string');
    const dateRe = new RegExp(dateBranch.pattern);
    expect(dateRe.test('2026-04-20')).toBe(true);
    for (const sentinel of sentinelBranch.enum) {
      expect(dateRe.test(sentinel)).toBe(false);
    }
  });
});

describe('transcript schema accepts the transcripts the runners actually produce (agentic-cats-16)', () => {
  const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, 'transcript.schema.json'), 'utf8'));

  test('probe_id pattern accepts real id families (q-NNNN, sig-NNNN, scenario ids)', () => {
    const re = new RegExp(schema.properties.probe_id.pattern);
    for (const id of ['q-0001', 'sig-0001', 'p1', 's-briefing-1', 'c13-00001']) {
      expect(re.test(id)).toBe(true);
    }
    expect(re.test('')).toBe(false);
    expect(re.test(' leading-space')).toBe(false);
  });

  test('description names the real artifact (transcript.json written by emitBundle), not a phantom', () => {
    expect(schema.description).toContain('transcript.json');
    expect(schema.description).toContain('emitBundle');
  });
});

describe('scorecard schema covers every shipped category (data-integrity-11)', () => {
  const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, 'scorecard.schema.json'), 'utf8'));

  test('cat enum runs 1 through 34', () => {
    expect(schema.properties.cat.enum).toEqual(Array.from({ length: 34 }, (_, i) => i + 1));
  });

  test('config_card required matches the TS ScorecardConfigCard optionality (recorder.ts)', () => {
    // driver_model / judge_model / bun_version are optional in the emitting
    // TS interface and omitted by real emitters (cat8 has no judge model);
    // requiring them made the schema validate zero real artifacts.
    expect([...schema.properties.config_card.required].sort()).toEqual(
      ['adapter', 'brainbench_version', 'corpus_sha', 'seed'],
    );
  });
});
