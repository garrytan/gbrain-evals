/**
 * N14 large-page fidelity: generator determinism and oracle, the scorer on
 * hand-built gold (with negatives that must fail), the managed-parts split,
 * the native capability probe, a deliberately broken adapter the category
 * must fail, and the scorer mutation suite. No gbrain process starts here:
 * the category logic runs over in-memory adapters through the same
 * evaluateArm the gbrain child processes use.
 */
import { describe, expect, test } from 'bun:test';
import { registryEntry } from '../../eval/registry.ts';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';
import { evaluatePromotion } from '../../eval/runner/promotion.ts';
import { PaidArmRefusal, requirePaidArm } from '../../eval/runner/paid-arm.ts';
import {
  DECILES, N14_DEFAULT_SEED, NEEDLE_TYPES, TIERS, checkPresence, containsToken, ledgerFingerprint, renderDocument, tierSpecs, tokenOccurrences,
  type DocKind, type N14DocLedger, type Needle,
} from '../../eval/generators/n14-large-page-gen.ts';
import {
  EGRESS_CAP_BYTES, PASSAGE_CAP_BYTES, THRESHOLDS, canonicalBody, crashedSummary, absentSummary, estTokens, evaluateArm, frameBytes, hitRank, hubContent,
  n14Findings, n14Verdict, parseConfigOverlay, parseNativeIngest, probeNativeCapability, scoreQa, splitIntoParts, summarize, summarizeArm,
  EMBED_PASS_TIERS, UPLOAD_ABOVE_BYTES, cutUploadParts, LIFECYCLE_CLAIM, LIFECYCLE_TOKEN, PROJECTION_SETTLE_MAX_MS, lifecycleFence, parseEngine, settleBoundMs,
  type LifecycleOutcome, type AppendOutcome, type Arm, type CallFrame, type EmbedCount, type IngestOutcome, type N14Adapter, type N14RunResult, type NativeCapability, type SearchHit,
} from '../../eval/runner/n14-large-page-fidelity.ts';
import { overlaySummary, type GbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { MACHINE_LOCAL_PATH } from '../../eval/runner/receipt.ts';

const small = (kind: DocKind, target_bytes = 300_000, seed = N14_DEFAULT_SEED) => renderDocument({ kind, target_bytes, seed });

// ─── Generator ───────────────────────────────────────────────────────────

describe('N14 generator', () => {
  test('same seed, same ledger hash; another seed, another hash', () => {
    for (const kind of ['conversation', 'project-log', 'book'] as const) {
      const a = small(kind);
      const b = small(kind);
      expect(ledgerFingerprint([a.ledger])).toBe(ledgerFingerprint([b.ledger]));
      expect(a.text).toBe(b.text);
      expect(ledgerFingerprint([small(kind, 300_000, 15).ledger])).not.toBe(ledgerFingerprint([a.ledger]));
    }
  });

  test('the 2 MB tier corpus is frozen: its ledger hash is pinned', () => {
    const ledgers = tierSpecs('2mb', N14_DEFAULT_SEED).map(s => renderDocument(s).ledger);
    expect(ledgers.map(l => [l.id, l.bytes])).toEqual([['conversation', 2000112], ['project-log', 2000437], ['book', 1500522]]);
    expect(ledgerFingerprint(ledgers)).toBe(PINNED_2MB_LEDGER);
  });

  test('the presence oracle passes on every kind and finds four needles per decile', () => {
    for (const kind of ['conversation', 'project-log', 'book'] as const) {
      const { text, ledger } = small(kind);
      const checks = checkPresence(Buffer.from(text), ledger);
      expect(checks.filter(c => !c.ok)).toEqual([]);
      expect(ledger.needles).toHaveLength(DECILES * NEEDLE_TYPES.length);
      for (let d = 0; d < DECILES; d++) expect(ledger.needles.filter(n => n.decile === d).map(n => n.type).sort()).toEqual([...NEEDLE_TYPES].sort());
    }
  });

  test('the presence oracle catches a needle removed from the raw bytes and a tampered offset', () => {
    const { text, ledger } = small('conversation');
    const n = ledger.needles[13];
    const removed = text.replace(n.answer, 'redacted');
    expect(checkPresence(Buffer.from(removed), ledger).filter(c => !c.ok).length).toBeGreaterThan(0);
    const shifted: N14DocLedger = { ...ledger, needles: ledger.needles.map((x, i) => i === 13 ? { ...x, byte_offset: x.byte_offset + 1 } : x) };
    expect(checkPresence(Buffer.from(text), shifted).filter(c => !c.ok).map(c => c.name)).toContain('conversation: needles and distractors unique, at their offsets, deciles and sections');
  });

  test('chat lines follow the imessage-slack shape under day headers; names are the fictional cast', () => {
    const { text } = small('conversation', 120_000);
    const lines = text.split('\n').filter(l => l.startsWith('**'));
    expect(lines.length).toBeGreaterThan(500);
    for (const l of lines.slice(0, 200)) expect(l).toMatch(/^\*\*(Rowan Vale|Imogen Pell|Casimir Holt|Juniper Ashdown)\*\* \(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2} (AM|PM)\): \S/);
    expect(text).toMatch(/^## \d{4}-\d{2}-\d{2}$/m);
  });

  test('distractors differ by one detail: same noun, sibling place name, a different value', () => {
    const { ledger } = small('book');
    for (const n of ledger.needles) {
      expect(n.distractor.noun).toBe(n.noun);
      expect(n.distractor.anchor).not.toBe(n.anchor);
      expect(n.distractor.anchor.slice(0, 3)).toBe(n.anchor.slice(0, 3));
      expect(n.distractor.answer).not.toBe(n.answer);
      expect(containsToken(n.distractor.sentence, n.answer)).toBe(false);
      expect(Math.abs(n.distractor.decile - n.decile)).toBe(5);
    }
  });
});

// ─── Scorer on hand-built gold ───────────────────────────────────────────

describe('N14 scorer', () => {
  test('a hit needs the answer as a whole token inside a passage under the cap', () => {
    expect(hitRank(['nothing here', 'the Brackford locker code is 41771 ok'], '41771')).toBe(2);
    // Negative that must fail: a longer number containing the answer is not the answer.
    expect(hitRank(['the code is 417712'], '41771')).toBeNull();
    // Negative that must fail: the distractor's passage only.
    expect(hitRank(['the Brackmere locker code is 47171'], '41771')).toBeNull();
    // Negative that must fail: the whole document as one passage.
    expect(hitRank([`${'x '.repeat(PASSAGE_CAP_BYTES)} 41771`], '41771')).toBeNull();
    // Beyond rank 10 is a miss.
    expect(hitRank([...new Array(10).fill('noise'), '41771'], '41771')).toBeNull();
    expect(tokenOccurrences('Ombrecourt and Ombrecourts', 'Ombrecourt')).toBe(1);
  });

  test('recall by decile and the verdict from a hand-built run', () => {
    const { text, ledger } = small('conversation');
    const run = fakeRun('native', ledger, text, n => n.decile !== 7 || n.type === 'number');
    const s = summarizeArm(run, '2mb');
    expect(s.keyword_recall).toEqual({ hits: 37, total: 40, rate: 37 / 40 });
    expect(s.keyword_recall_by_decile[7]).toEqual({ hits: 1, total: 4, rate: 0.25 });
    expect(s.min_decile_recall).toBe(0.25);
    const parts = summarizeArm(fakeRun('managed-parts', ledger, text, () => true), '2mb');
    const summary = summarize([s, parts], 0, CAPABLE);
    // 37/40 = 0.925 passes the 0.9 floor, but the gap to parts is 7.5 points: fail.
    expect(summary.floor.native_keyword_recall_2mb).toBeCloseTo(0.925);
    expect(summary.quality.native_recall_gap_points_max).toBe(7.5);
    expect(n14Verdict(summary).failed).toEqual(['quality.native_recall_gap_points_max=7.5']);
  });

  test('an honest native run passes; a refuse-everything run fails the floor and the append threshold', () => {
    const { text, ledger } = small('project-log');
    const honest = summarizeArm(fakeRun('native', ledger, text, () => true), '2mb');
    const parts = summarizeArm(fakeRun('managed-parts', ledger, text, () => true), '2mb');
    expect(n14Verdict(summarize([honest, parts], 0, CAPABLE))).toEqual({ verdict: 'pass', failed: [] });
    const refused = summarizeArm(fakeRun('native', ledger, text, () => false, { refuse: true }), '2mb');
    const v = n14Verdict(summarize([refused, parts], 0, CAPABLE));
    expect(v.verdict).toBe('fail');
    expect(v.failed).toContain('floor.native_keyword_recall_2mb=0');
    expect(v.failed).toContain('quality.native_append_embed_ratio_max=null');
  });

  test('findings: an over-cap default read is gap N14-3 only while gbrain has no windowed read', () => {
    const { text, ledger } = small('conversation');
    const gut = { root: '/x', version: 't', overlay: { build: { commit: 'c71fe7436e673db819c1be4532504b861e14ad50' } } } as unknown as GbrainUnderTest;
    const run = fakeRun('single-page', ledger, text, () => true);
    const loud = { ...summarizeArm({ ...run, direct_read: { bytes: 2_042_154 } }, '2mb') };
    const ids = (capability: NativeCapability) => n14Findings({ tiers: [], capability, summary: summarize([loud], 0, capability) } as unknown as N14RunResult, gut).map(f => f.id);
    expect(ids(probeNativeCapability([{ name: 'get_page', params: { slug: {} } }]))).toEqual(['N14-3']);
    expect(ids(CAPABLE)).toEqual([]);
  });

  test('the receipt overlay summary names the gbrain ref, never the checkout path', () => {
    const sha = 'c71fe7436e673db819c1be4532504b861e14ad50';
    const gut = {
      root: '/home/alice/evals/.gbrain-overlays/x', version: '0.60.225.0',
      overlay: { requested: `/home/alice/.capy/work/gbrain-master@${sha}`, checkout: '/home/alice/.capy/work/gbrain-master', ref: sha, checkout_dirty: false, build: { commit: sha, tree: 't', version: '0.60.225.0', verified: {} } },
    } as unknown as GbrainUnderTest;
    const summary = overlaySummary(gut)!;
    expect(summary.requested).toBe(`gbrain@${sha}`);
    expect(MACHINE_LOCAL_PATH.test(JSON.stringify(summary))).toBe(false);
  });

  test('findings: a size refusal is a gap, a retryable capacity code for an oversized page is a bug', () => {
    const { text, ledger } = small('conversation');
    const sha = 'c71fe7436e673db819c1be4532504b861e14ad50';
    const gut = { root: '/x', version: 't', overlay: { build: { commit: sha } } } as unknown as GbrainUnderTest;
    const single = (code: string) => {
      const s = summarizeArm(fakeRun('single-page', ledger, text, () => false, { refuse: true }), '20mb');
      return { ...s, ingest: { ...s.ingest, status: code === 'request_too_large' ? 'refused' : 'error', code } };
    };
    const ids = (code: string) => {
      const arms = [single(code)];
      return n14Findings({ tiers: [], capability: CAPABLE, summary: summarize(arms, 0, CAPABLE), arms } as unknown as N14RunResult, gut);
    };
    const tooLarge = ids('request_too_large');
    expect(tooLarge.map(f => [f.id, f.classification])).toEqual([['N14-2', 'feature-gap']]);
    const capacity = ids('queue_capacity');
    expect(capacity.map(f => [f.id, f.classification])).toEqual([['N14-4', 'bug']]);
    expect(capacity[0].gbrain_sha).toBe(sha);
    expect(capacity[0].repro).toContain(`--tier 20mb --arms single-page --gbrain <gbrain checkout>@${sha}`);
  });

  test('capability absent: the native arm is a reported gap, and the rules fail on missing values', () => {
    const { ledger } = small('book');
    const s = summarize([absentSummary(ledger, '2mb')], 0, probeNativeCapability([{ name: 'get_page', params: { slug: {} } }]));
    expect(s.arms[0].status).toBe('capability_absent');
    expect(s.safety.crashes).toBe(0);
    expect(n14Verdict(s).failed).toEqual(['quality.native_append_embed_ratio_max=null', 'quality.native_recall_gap_points_max=null', 'floor.native_keyword_recall_2mb=null']);
  });

  test('a crashed arm counts against safety with every probe a miss', () => {
    const { ledger } = small('book');
    const c = crashedSummary('single-page', ledger, '20mb', 'rss_limit', 6200);
    expect(summarize([c], 0, CAPABLE).safety.crashes).toBe(1);
    expect(c.keyword_recall).toEqual({ hits: 0, total: 40, rate: 0 });
  });

  test('the registry row repeats the preregistered rules, held while the capability is absent', () => {
    const e = registryEntry('N14')!;
    expect(e.id).toBe('large-page-fidelity');
    expect(e.gate).toBe('report-only');
    const p = e.promotion!;
    expect(p.preregistered).toBe('2026-10-14');
    expect(p.held?.since).toBe('2026-10-14');
    expect(p.safety_contracts.map(c => c.path)).toEqual(['data.safety.crashes', 'data.safety.responses_over_cap', 'data.safety.roundtrip_byte_loss', 'data.safety.presence_failures']);
    const q = Object.fromEntries(p.quality_thresholds.map(c => [c.path, c.value]));
    expect(q).toEqual({
      'data.floor.native_keyword_recall_2mb': THRESHOLDS.native_keyword_recall_floor,
      'data.quality.native_append_embed_ratio_max': THRESHOLDS.append_embed_ratio_max,
      'data.quality.native_recall_gap_points_max': THRESHOLDS.native_recall_gap_points_max,
    });
    // The registry's rules and n14Verdict agree on a passing and a failing summary.
    const { text, ledger } = small('conversation');
    const pass = summarize([summarizeArm(fakeRun('native', ledger, text, () => true), '2mb'), summarizeArm(fakeRun('managed-parts', ledger, text, () => true), '2mb')], 0, CAPABLE);
    const outcome = (s: ReturnType<typeof summarize>) => evaluatePromotion(p, { data: { safety: s.safety, quality: s.quality, floor: s.floor } });
    expect(outcome(pass).pass).toBe(true);
    expect(n14Verdict(pass).verdict).toBe('pass');
    const loud = { ...pass, safety: { ...pass.safety, responses_over_cap: 1 } };
    expect(outcome(loud).pass).toBe(false);
    expect(n14Verdict(loud).verdict).toBe('fail');
  });

  test('reader QA scoring: the distractor value is a confusion, not a hit', () => {
    const n = { answer: '41771', distractor: { answer: '47171' } } as Pick<Needle, 'answer' | 'distractor'>;
    expect(scoreQa('41771', n)).toEqual({ correct: true, distractor: false });
    expect(scoreQa('It is 47171.', n)).toEqual({ correct: false, distractor: true });
    expect(scoreQa('41771 or 47171', n)).toEqual({ correct: false, distractor: true });
    expect(scoreQa('unknown', n)).toEqual({ correct: false, distractor: false });
  });

  test('frames are measured on the JSON-RPC text frame; the token estimate is bytes / 4', () => {
    expect(frameBytes({ a: 'x'.repeat(1000) })).toBeGreaterThan(1000);
    expect(frameBytes({ q: '"' })).toBeGreaterThan(frameBytes({ q: 'a' }));
    expect(estTokens('abcd'.repeat(256))).toBe(256);
  });

  test('the paid arm refuses without --paid and --budget-run-id', () => {
    expect(() => requirePaidArm([], { arm: 'N14 paid arm', estimateUsd: 8, ledgerPath: '/nonexistent/n14-ledger.sqlite' })).toThrow(PaidArmRefusal);
  });
});

// ─── Managed parts and the capability probe ──────────────────────────────

describe('N14 managed parts and capability probe', () => {
  test('split into hub plus one part per section, and the trimmed parts rejoin to the canonical body', () => {
    for (const kind of ['conversation', 'project-log', 'book'] as const) {
      const { text, ledger } = small(kind);
      const { hub, parts } = splitIntoParts(text, ledger);
      expect(parts.length).toBe(ledger.sections.length);
      expect(parts.map(p => p.key)).toEqual(ledger.sections.map(s => s.key));
      expect([...parts.map(p => p.slug)].sort()).toEqual(parts.map(p => p.slug));
      const body = text.slice(ledger.body_offset);
      expect(canonicalBody([hub.preamble, ...parts.map(p => p.body)].map(x => x.trim()).join('\n\n'))).toBe(canonicalBody(body));
      expect(hubContent(ledger, hub.preamble, parts)).toContain(`[[${parts[0].slug}]]`);
      for (const n of ledger.needles) expect(containsToken(parts.find(p => p.key === n.section)!.body, n.answer)).toBe(true);
    }
  });

  test('the capability probe reads get_page body modes and the append and upload ops', () => {
    expect(probeNativeCapability([{ name: 'get_page', params: { slug: {}, include_content: {} } }]).present).toBe(false);
    expect(probeNativeCapability([{ name: 'get_page', params: { body: { type: 'string', enum: ['auto', 'full', 'none'] } } }]).present).toBe(false);
    const c = probeNativeCapability([{ name: 'get_page', params: { body: { type: 'string', enum: ['auto', 'full', 'none', 'outline', 'window'] } } }, { name: 'append_page', params: {} }]);
    expect(c).toMatchObject({ present: true, append_page: true, upload_session: false });
    const up = probeNativeCapability([{ name: 'get_page', params: { body: { enum: ['window'] } } }, { name: 'append_page' }, { name: 'begin_page_upload' }, { name: 'upload_page_part' }, { name: 'commit_page_upload' }]);
    expect(up).toMatchObject({ present: true, append_page: true, upload_session: true });
    expect(up.evidence).toContain('upload sessions exist');
    expect(probeNativeCapability([{ name: 'get_page', params: { body: { enum: ['window'] } } }, { name: 'begin_page_upload' }, { name: 'commit_page_upload' }]).upload_session).toBe(false);
  });

  test('upload parts end on code points, rejoin to the input and keep every frame within the part limit', () => {
    const id = '0f8fad5b-d9cb-41a1-a8b4-6d1f2c3e4a5b';
    const frame = (slice: Buffer, part: number) => Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 0, result: { upload_id: id, part, text: slice.toString('utf8'), part_sha256: '0'.repeat(64) } })) + 1024;
    const text = Array.from({ length: 4000 }, (_, i) => `line ${i} "quoted" \\ tab\t é 漢字 🙂\n`).join('');
    const buf = Buffer.from(text);
    for (const cap of [8 * 1024, 64 * 1024, 4 * 1024 ** 2 - 4096]) {
      const parts = cutUploadParts(buf, id, cap);
      expect(Buffer.concat(parts).equals(buf)).toBe(true);
      for (const [i, p] of parts.entries()) {
        expect(frame(p, i)).toBeLessThanOrEqual(cap);
        expect(p.toString('utf8')).not.toContain('\uFFFD');
      }
      if (cap < buf.length) expect(parts.length).toBeGreaterThan(1);
    }
    expect(UPLOAD_ABOVE_BYTES).toBe(4 * 1024 * 1024);
    expect(() => cutUploadParts(Buffer.from('🙂'), id, 1100)).toThrow(/cannot carry/);
  });
});

// ─── Adapters: a reference that passes, a broken one that must fail ──────

/** A minimal honest large-page store: ~1 KB passages, keyword scoring, windowed reads, tail-only append embedding. */
class ReferenceAdapter implements N14Adapter {
  readonly frames: CallFrame[] = [];
  passages: Array<{ id: number; text: string; embedded: boolean }> = [];
  body = '';
  ledger!: N14DocLedger;
  constructor(readonly arm: Arm, readonly keepBytes = Infinity) {}
  #record(op: string, result: unknown) { this.frames.push({ op, bytes: frameBytes(result) }); return result; }
  #index(text: string) {
    let buf = '';
    for (const line of text.split('\n')) {
      buf += line + '\n';
      if (buf.length > 1000) { this.passages.push({ id: this.passages.length + 1, text: buf, embedded: false }); buf = ''; }
    }
    if (buf.trim()) this.passages.push({ id: this.passages.length + 1, text: buf, embedded: false });
  }
  async ingest(ledger: N14DocLedger, raw: string): Promise<IngestOutcome> {
    this.ledger = ledger;
    this.body = raw.slice(ledger.body_offset, ledger.body_offset + Math.min(this.keepBytes, raw.length));
    this.#index(ledger.control.content);
    this.#index(this.body);
    return { status: 'stored', pages: 1, chunks: this.passages.length, embed_skip: null, write_errors: 0 };
  }
  async storedContains(answer: string) { return this.body.includes(answer); }
  async search(query: string): Promise<SearchHit[]> {
    const terms = query.toLowerCase().split(/\s+/);
    const scored = this.passages.map(p => ({ p, s: terms.filter(t => p.text.toLowerCase().includes(t)).length + (p.text.toLowerCase().includes(terms[0]) ? 10 : 0) }))
      .filter(x => x.s > 0).sort((a, b) => b.s - a.s || a.p.id - b.p.id).slice(0, 10);
    const hits = scored.map(x => ({ slug: this.ledger.slug, chunk_id: x.p.id, passage: x.p.text, delivered: x.p.text }));
    this.#record('search', hits);
    return hits;
  }
  async read(hit: SearchHit) { return JSON.stringify(this.#record('get_page', { window: hit.passage })); }
  async directRead() { return JSON.stringify(this.#record('get_page', { outline: this.ledger.sections.length, window: this.body.slice(0, 4096) })); }
  async embedPass(): Promise<EmbedCount> {
    const todo = this.passages.filter(p => !p.embedded);
    for (const p of todo) p.embedded = true;
    return { inputs: todo.length, tokens: todo.reduce((n, p) => n + estTokens(p.text), 0) };
  }
  async append(text: string): Promise<AppendOutcome> {
    const before = this.passages.length;
    this.body += text;
    this.#index(text);
    return { status: 'ok', chunks_before: before, chunks_after: this.passages.length, chunks_rewritten: this.passages.length - before, chunks_deleted: 0, path: 'append' };
  }
  async exportBody() { return this.body; }
  async close() {}
}

describe('N14 adapters through evaluateArm', () => {
  const doc = small('conversation', 400_000);

  test('the reference adapter passes the category', async () => {
    const native = summarizeArm(await evaluateArm(new ReferenceAdapter('native'), doc.ledger, doc.text), '2mb');
    const parts = summarizeArm(await evaluateArm(new ReferenceAdapter('managed-parts'), doc.ledger, doc.text), '2mb');
    expect(native.keyword_recall.rate).toBe(1);
    expect(native.roundtrip).toBe('match');
    expect(native.append?.visible).toBe(true);
    expect(native.append?.embed_ratio).toBeLessThanOrEqual(THRESHOLDS.append_embed_ratio_max);
    expect(native.max_frame_bytes).toBeLessThan(EGRESS_CAP_BYTES);
    expect(n14Verdict(summarize([native, parts], 0, CAPABLE))).toEqual({ verdict: 'pass', failed: [] });
  });

  test('a deliberately broken adapter (silent head-only ingest at 200 KB) fails the category', async () => {
    const broken = summarizeArm(await evaluateArm(new ReferenceAdapter('native', 200_000), doc.ledger, doc.text), '2mb');
    const parts = summarizeArm(await evaluateArm(new ReferenceAdapter('managed-parts'), doc.ledger, doc.text), '2mb');
    expect(broken.stored_needles.hits).toBeLessThan(40);
    expect(broken.keyword_recall_by_decile.slice(6).every(r => r.rate === 0)).toBe(true);
    expect(broken.roundtrip).toBe('mismatch');
    const v = n14Verdict(summarize([broken, parts], 0, CAPABLE));
    expect(v.verdict).toBe('fail');
    expect(v.failed).toContain('safety.roundtrip_byte_loss=1');
    expect(v.failed.some(f => f.startsWith('floor.native_keyword_recall_2mb='))).toBe(true);
  });

  test('an agent-facing default read is reported beside the trusted one and stays out of the egress count', async () => {
    class AgentRead extends ReferenceAdapter {
      async agentDirectReadBytes() { return EGRESS_CAP_BYTES + 1; }
    }
    const plain = summarizeArm(await evaluateArm(new ReferenceAdapter('native'), doc.ledger, doc.text), '2mb');
    expect(plain.direct_read_agent_bytes).toBeUndefined();
    const s = summarizeArm(await evaluateArm(new AgentRead('native'), doc.ledger, doc.text), '2mb');
    expect(s.direct_read_agent_bytes).toBe(EGRESS_CAP_BYTES + 1);
    expect(s.responses_over_cap).toBe(0);
  });

  test('a segmented page whose export refuses still fails the round-trip contract; the segment round trip is reported beside it', async () => {
    class Segmented extends ReferenceAdapter {
      constructor(arm: Arm, private readonly segmentLoss = 0) { super(arm); }
      override async exportBody(): Promise<string> { throw Object.assign(new Error('rowToPage.compiled_truth: stores its body in segments'), { code: 'page_body_segmented' }); }
      async segmentBody() { return { body: this.body.slice(0, this.body.length - this.segmentLoss), regions: ['truth'] }; }
    }
    const intact = summarizeArm(await evaluateArm(new Segmented('native'), doc.ledger, doc.text), '2mb');
    expect(intact.roundtrip).toBe('error');
    expect(intact.segment_roundtrip).toBe('match');
    expect(summarize([intact], 0, CAPABLE).safety.roundtrip_byte_loss).toBe(1);
    const lossy = summarizeArm(await evaluateArm(new Segmented('native', 10), doc.ledger, doc.text), '2mb');
    expect(lossy.segment_roundtrip).toBe('mismatch');
    expect(summarizeArm(await evaluateArm(new ReferenceAdapter('native'), doc.ledger, doc.text), '2mb').segment_roundtrip).toBeUndefined();
  });

  test('pending-write polling and the projection wait are carried into the summary', async () => {
    class Pending extends ReferenceAdapter {
      override async ingest(ledger: N14DocLedger, raw: string): Promise<IngestOutcome> {
        return { ...(await super.ingest(ledger, raw)), pending: { writes: 1, wait_ms: 2000 }, projection: { sealed_at_reply: false, sealed: true, settle_ms: 9000 } };
      }
    }
    const s = summarizeArm(await evaluateArm(new Pending('native'), doc.ledger, doc.text), '2mb');
    expect(s.ingest.pending).toEqual({ writes: 1, wait_ms: 2000 });
    expect(s.ingest.projection).toEqual({ sealed_at_reply: false, sealed: true, settle_ms: 9000 });
    const plain = summarizeArm(await evaluateArm(new ReferenceAdapter('native'), doc.ledger, doc.text), '2mb');
    expect(plain.ingest.pending).toBeUndefined();
    expect(plain.ingest.projection).toBeUndefined();
  });

  test('a whole-page reader fails the egress contract', async () => {
    class WholePage extends ReferenceAdapter {
      override async read() { const r = { compiled_truth: 'y'.repeat(EGRESS_CAP_BYTES + 10) }; this.frames.push({ op: 'get_page', bytes: frameBytes(r) }); return JSON.stringify(r); }
    }
    const run = await evaluateArm(new WholePage('native'), doc.ledger, doc.text);
    const s = summarizeArm(run, '2mb');
    expect(s.responses_over_cap).toBe(40);
    expect(s.reads.correct).toBe(0);
    expect(summarize([s], 0, CAPABLE).safety.responses_over_cap).toBe(40);
  });
});

// ─── Scorer mutation suite ───────────────────────────────────────────────

describe('N14 scorer mutation suite', () => {
  test('the honest system passes; empty, always-positive, always-refuse, stale and wrong-source fail', () => {
    const { text, ledger } = small('conversation');
    type Probe = { kind: 'needle'; n: Needle } | { kind: 'append' };
    const probes: Probe[] = [...ledger.needles.map(n => ({ kind: 'needle' as const, n })), { kind: 'append' }];
    const line = (s: string) => text.split('\n').find(l => l.includes(s)) ?? '';
    const lastSection = text.slice(ledger.sections.at(-1)!.byte_start);
    const results = assertScorerRejectsFakeSystems<Probe, string[]>({
      category: 'N14',
      probes,
      space: {
        truth: p => [p.kind === 'needle' ? line(p.n.sentence) : ledger.append.text],
        empty: () => [],
        everything: () => [text + ledger.append.text],
        refusal: () => ['page_too_large: split the document into smaller files'],
        stale: p => p.kind === 'append' ? [lastSection.slice(0, 2000)] : undefined,
        wrongSource: p => p.kind === 'needle' ? [line(p.n.distractor.sentence)] : undefined,
      },
      score: answers => {
        const byDecile = Array.from({ length: DECILES }, () => ({ hits: 0, total: 0 }));
        let appendVisible = false;
        answers.forEach((a, i) => {
          const p = probes[i];
          if (p.kind === 'append') { appendVisible = hitRank(a, ledger.append.needle.answer) !== null; return; }
          byDecile[p.n.decile].total++;
          if (hitRank(a, p.n.answer) !== null) byDecile[p.n.decile].hits++;
        });
        const min = Math.min(...byDecile.map(d => d.hits / d.total));
        return { pass: min >= THRESHOLDS.hybrid_recall_min_decile && appendVisible, detail: `min decile recall ${min}, append visible ${appendVisible}` };
      },
    });
    expect(results.filter(r => r.pass).map(r => r.system)).toEqual(['honest']);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────

const CAPABLE: NativeCapability = { present: true, get_page_body: '{"enum":["window"]}', append_page: true, upload_session: false, evidence: 'test' };

/** A hand-built arm run: `found(n)` decides each needle's hit; everything else is clean. */
function fakeRun(arm: Arm, ledger: N14DocLedger, raw: string, found: (n: Needle) => boolean, o: { refuse?: boolean } = {}) {
  const body = canonicalBody(raw.slice(ledger.body_offset) + ledger.append.text);
  const sha = new Bun.CryptoHasher('sha256').update(body).digest('hex');
  return {
    arm, doc: ledger.id, bytes: ledger.bytes,
    ingest: o.refuse ? { status: 'refused' as const, code: 'request_too_large', pages: 0, chunks: 0, embed_skip: null, write_errors: 1, wall_ms: 10 } : { status: 'stored' as const, pages: 1, chunks: 800, embed_skip: null, write_errors: 0, wall_ms: 1000 },
    stored: { contains: o.refuse ? 0 : 40, total: 40 },
    control: { hits: 4, total: 4, missed: [] },
    probes: ledger.needles.map(n => ({ id: n.id, decile: n.decile, type: n.type, hit_rank: found(n) ? 1 : null, delivered_rank: found(n) ? 1 : null, distractor_rank: null, n_results: found(n) ? 10 : 0 })),
    reads: ledger.needles.map(n => ({ id: n.id, attempted: found(n), contains: found(n), bytes: found(n) ? 30_000 : null, correct: found(n) })),
    direct_read: { bytes: 40_000 },
    embed_initial: o.refuse ? null : { inputs: 800, tokens: 500_000, wall_ms: 100 },
    append: o.refuse
      ? { status: 'refused' as const, code: 'request_too_large', chunks_before: 0, chunks_after: 0, chunks_rewritten: 0, chunks_deleted: 0, path: 'append', wall_ms: 5, embed: null, appended_tokens: 268, visible_rank: null }
      : { status: 'ok' as const, chunks_before: 800, chunks_after: 801, chunks_rewritten: 1, chunks_deleted: 0, path: 'append', wall_ms: 50, embed: { inputs: 1, tokens: 500 }, appended_tokens: 268, visible_rank: 1 },
    roundtrip: o.refuse ? { status: 'not_stored' as const, expected_sha256: sha } : { status: 'match' as const, expected_sha256: sha, actual_sha256: sha, byte_delta: 0 },
    frames: { count: 50, max_bytes: 40_000, over_cap: 0, by_op: {} },
    memory: [{ phase: 'start', t_ms: 0, rss_mb: 900, max_rss_mb: 900 }, { phase: 'ingest', t_ms: 1000, rss_mb: 1100, max_rss_mb: 1200 }],
  };
}

/** sha256 of the canonical 2 MB tier ledger at seed 14 (n14-large-page-gen/v1); a change means the corpus changed. */
const PINNED_2MB_LEDGER = 'c09ed85562906f0fd9d959eed907d85743c544085711d31ff5e0490ece1fb436';

describe('N14 Amendment 2 flags', () => {
  test('--config collects key=value pairs from repeated and comma-joined flags', () => {
    expect(parseConfigOverlay(['--tiers', '2mb'])).toBeUndefined();
    expect(parseConfigOverlay(['--config', 'pages.segmented_storage=on', '--config=pages.max_bytes=1000,a=b'])).toEqual({ 'pages.segmented_storage': 'on', 'pages.max_bytes': '1000', a: 'b' });
    expect(() => parseConfigOverlay(['--config', 'novalue'])).toThrow(/key=value/);
  });

  test('--native-ingest takes put_page (default) or import', () => {
    expect(parseNativeIngest([])).toBe('put_page');
    expect(parseNativeIngest(['--native-ingest', 'import'])).toBe('import');
    expect(() => parseNativeIngest(['--native-ingest', 'upload'])).toThrow(/put_page or import/);
  });
});

describe('N14 Amendment 4: tiers, engine, settle bound, lifecycle', () => {
  const MiB = 1024 ** 2;
  test('the binary tiers sit on gbrain page limits: under 24 MiB, 128 MiB and 256 MiB, over 256 MiB', () => {
    expect(Number(TIERS['24mib'].conversation)).toBe(24 * MiB - 64 * 1024);
    expect(Number(TIERS['100mib'].conversation)).toBe(100 * MiB);
    expect(Number(TIERS['128mib'].conversation)).toBe(128 * MiB - 64 * 1024);
    expect(Number(TIERS['256mib'].conversation)).toBe(256 * MiB - 64 * 1024);
    expect(Number(TIERS['260mib'].conversation)).toBe(260 * MiB);
    expect([...EMBED_PASS_TIERS]).toEqual(['2mb', '20mb', '24mib']);
  });

  test('--engine defaults to pglite; postgres needs an admin URL from the flag or N14_PG_ADMIN_URL', () => {
    expect(parseEngine([], {})).toEqual({ kind: 'pglite' });
    expect(parseEngine(['--engine', 'postgres', '--pg-admin-url', 'postgres://u@h/db'], {})).toEqual({ kind: 'postgres', adminUrl: 'postgres://u@h/db' });
    expect(parseEngine(['--engine=postgres'], { N14_PG_ADMIN_URL: 'postgres://e@h/db' })).toEqual({ kind: 'postgres', adminUrl: 'postgres://e@h/db' });
    expect(() => parseEngine(['--engine', 'postgres'], {})).toThrow(/admin URL|pg-admin-url/);
    expect(() => parseEngine(['--engine', 'sqlite'], {})).toThrow(/pglite or postgres/);
  });

  test('the settle bound keeps the Amendment 3 floor and grows 3 s per MB', () => {
    expect(settleBoundMs(2_000_000)).toBe(PROJECTION_SETTLE_MAX_MS);
    expect(settleBoundMs(268_369_920)).toBe(269 * 3_000);
  });

  test('the lifecycle fence carries one fact row with the token', () => {
    const fence = lifecycleFence();
    expect(fence).toContain('<!--- gbrain:facts:begin -->');
    expect(fence).toContain('<!--- gbrain:facts:end -->');
    expect(fence.split('\n').filter(l => l.includes(LIFECYCLE_TOKEN))).toEqual([`| 1 | ${LIFECYCLE_CLAIM} | fact | 1.0 | world | low | 2026-10-01 |  | n14 |  |`]);
    expect(small('conversation').text.includes(LIFECYCLE_TOKEN)).toBe(false);
  });

  const doc = small('conversation', 400_000);
  class Lifecycle extends ReferenceAdapter {
    seen: string | null = null;
    async lifecycle(body: string): Promise<LifecycleOutcome> {
      this.seen = body;
      await this.search(this.ledger.needles[0].query);
      this.frames.push({ op: 'get_page', bytes: EGRESS_CAP_BYTES + 1 });
      return {
        probes: 10, hits_before: 10,
        forget: { status: 'ok', fact_rows: 1, withdrawn: true, recall_hits_after: 0, export_row: 'struck', wall_ms: 1 },
        delete: { status: 'ok', hits_after: 0, get_page_code: 'page_not_found', wall_ms: 1 },
        restore: { status: 'ok', hits_after: 10, export_matches_pre_delete: true, wall_ms: 1 },
        purge: { status: 'ok', wall_ms: 1, residue: null, sweep: null },
      };
    }
  }

  test('the lifecycle runs only when asked, on the page as last written, and its calls stay out of the egress count', async () => {
    const off = new Lifecycle('native');
    const plain = await evaluateArm(off, doc.ledger, doc.text);
    expect(off.seen).toBeNull();
    expect(plain.lifecycle).toBeUndefined();
    const on = new Lifecycle('native');
    const run = await evaluateArm(on, doc.ledger, doc.text, { lifecycle: true });
    expect(on.seen).toBe(doc.text + doc.ledger.append.text);
    expect(run.memory.map(m => m.phase)).toContain('lifecycle');
    expect(run.frames.count).toBe(plain.frames.count);
    expect(run.frames.over_cap).toBe(0);
    const s = summarizeArm(run, '2mb');
    expect(s.lifecycle).toEqual(run.lifecycle);
    expect(n14Verdict(summarize([s, summarizeArm(await evaluateArm(new ReferenceAdapter('managed-parts'), doc.ledger, doc.text), '2mb')], 0, CAPABLE)).verdict).toBe('pass');
  });

  test('a lifecycle that throws is recorded, never thrown; a refused ingest skips it', async () => {
    class Throws extends ReferenceAdapter {
      async lifecycle(): Promise<LifecycleOutcome> { throw Object.assign(new Error('purge refused'), { code: 'permission_denied' }); }
    }
    expect((await evaluateArm(new Throws('native'), doc.ledger, doc.text, { lifecycle: true })).lifecycle).toEqual({ error: 'permission_denied: purge refused' });
    class Refused extends Lifecycle {
      override async ingest(ledger: N14DocLedger, raw: string): Promise<IngestOutcome> { await super.ingest(ledger, raw); return { status: 'refused', code: 'request_too_large', pages: 0, chunks: 0, embed_skip: null, write_errors: 1 }; }
    }
    const r = new Refused('native');
    expect((await evaluateArm(r, doc.ledger, doc.text, { lifecycle: true })).lifecycle).toBeUndefined();
    expect(r.seen).toBeNull();
  });
});
