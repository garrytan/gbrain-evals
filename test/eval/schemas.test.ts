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
