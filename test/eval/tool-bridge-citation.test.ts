/**
 * tool-bridge citation-format regressions (audit agentic-cats-10/11).
 *
 *   - agentic-cats-11: checkCitationFormat used to validate ONLY lines that
 *     already began with `- `, so a timeline written with the wrong bullet
 *     (`* ...`) or no bullet at all produced zero candidates and scored
 *     citation_format_ok=true. Now every non-empty line must match the
 *     canonical `- **YYYY-MM-DD** | Source — Summary` pattern.
 *
 *   - agentic-cats-10: dry_run_add_timeline_entry's published input_schema
 *     declares `source` OPTIONAL (required: slug/date/summary) but scoring
 *     required a non-empty source, penalizing schema-compliant agents.
 *     Scoring now matches the schema: date format always required; source,
 *     when provided, must be non-blank.
 *
 * Hermetic: the dry_run tools never touch the engine, so a bare fake
 * engine object suffices.
 */

import { describe, test, expect } from 'bun:test';
import type { BrainEngine } from 'gbrain/engine';
import {
  checkCitationFormat,
  createToolBridge,
  type ToolBridge,
} from '../../eval/runner/tool-bridge.ts';

function makeBridge(): ToolBridge {
  return createToolBridge({
    engine: {} as unknown as BrainEngine, // dry_run tools never call the engine
    poisonFixtures: [],
  });
}

// ─── checkCitationFormat (agentic-cats-11) ────────────────────────────

describe('checkCitationFormat — wrong-bullet timelines can no longer pass', () => {
  test('REJECTS a star-bullet timeline (previously scored true — zero candidate lines)', () => {
    expect(checkCitationFormat('* **2026-01-01** | emails/em-0001 — Joined')).toBe(false);
  });

  test('REJECTS a bullet-less timeline (previously scored true)', () => {
    expect(checkCitationFormat('**2026-01-01** | emails/em-0001 — Joined')).toBe(false);
  });

  test('REJECTS a numbered-list timeline', () => {
    expect(checkCitationFormat('1. **2026-01-01** | emails/em-0001 — Joined')).toBe(false);
  });

  test('REJECTS a mixed timeline where one line has the wrong bullet', () => {
    const timeline = [
      '- **2026-01-01** | emails/em-0001 — Joined',
      '* **2026-02-01** | emails/em-0002 — Promoted',
    ].join('\n');
    expect(checkCitationFormat(timeline)).toBe(false);
  });

  test('accepts the canonical format on every line', () => {
    const timeline = [
      '- **2026-01-01** | emails/em-0001 — Joined Halfway Capital',
      '- **2026-02-01** | meeting/mtg-0002 - Promoted to Partner',
    ].join('\n');
    expect(checkCitationFormat(timeline)).toBe(true);
  });

  test('accepts an empty timeline (nothing to validate)', () => {
    expect(checkCitationFormat('')).toBe(true);
    expect(checkCitationFormat('   \n  ')).toBe(true);
  });

  test('still rejects a dash bullet missing the date/source structure', () => {
    expect(checkCitationFormat('- Joined sometime recently.')).toBe(false);
  });
});

describe('dry_run_put_page scores wrong-bullet timelines as non-compliant', () => {
  test('star-bullet timeline → citation_format_ok=false (regression)', async () => {
    const bridge = makeBridge();
    await bridge.executeTool('dry_run_put_page', {
      slug: 'people/jane',
      title: 'Jane',
      compiled_truth: 'Body.',
      timeline: '* **2026-01-01** | emails/em-0001 — Joined',
    });
    expect(bridge.state.made_dry_run_writes[0].citation_format_ok).toBe(false);
  });

  test('canonical timeline → citation_format_ok=true (good input still passes)', async () => {
    const bridge = makeBridge();
    await bridge.executeTool('dry_run_put_page', {
      slug: 'people/jane',
      title: 'Jane',
      compiled_truth: 'Body.',
      timeline: '- **2026-04-20** | emails/em-0001 — Joined Halfway Capital',
    });
    expect(bridge.state.made_dry_run_writes[0].citation_format_ok).toBe(true);
  });
});

// ─── dry_run_add_timeline_entry source optionality (agentic-cats-10) ──

describe('dry_run_add_timeline_entry — scoring matches the published schema', () => {
  test('the published schema really declares source optional', () => {
    const bridge = makeBridge();
    const def = bridge.toolDefs.find(d => d.name === 'dry_run_add_timeline_entry');
    expect(def?.input_schema.required).toEqual(['slug', 'date', 'summary']);
    expect(def?.input_schema.properties.source).toBeDefined();
  });

  test('omitted source + valid date → compliant (previously scored false — the mismatch)', async () => {
    const bridge = makeBridge();
    await bridge.executeTool('dry_run_add_timeline_entry', {
      slug: 'people/jane',
      date: '2026-04-20',
      summary: 'First meeting',
      // no source — allowed by the input_schema
    });
    expect(bridge.state.made_dry_run_writes[0].citation_format_ok).toBe(true);
  });

  test('provided-but-blank source → non-compliant', async () => {
    const bridge = makeBridge();
    await bridge.executeTool('dry_run_add_timeline_entry', {
      slug: 'people/jane',
      date: '2026-04-20',
      summary: 'x',
      source: '   ',
    });
    expect(bridge.state.made_dry_run_writes[0].citation_format_ok).toBe(false);
  });

  test('provided non-blank source + valid date → compliant', async () => {
    const bridge = makeBridge();
    await bridge.executeTool('dry_run_add_timeline_entry', {
      slug: 'people/jane',
      date: '2026-04-20',
      summary: 'First meeting',
      source: 'meeting/mtg-0001',
    });
    expect(bridge.state.made_dry_run_writes[0].citation_format_ok).toBe(true);
  });

  test('bad date is still rejected regardless of source', async () => {
    const bridge = makeBridge();
    await bridge.executeTool('dry_run_add_timeline_entry', {
      slug: 'people/jane',
      date: '04/20/2026',
      summary: 'x',
    });
    expect(bridge.state.made_dry_run_writes[0].citation_format_ok).toBe(false);
  });
});
