/**
 * BrainBench Cat 35 — mechanical checks (pure functions, no I/O, no LLM).
 *
 * Everything here is deterministic and unit-testable at $0. These checks are
 * AUTHORITATIVE over judge output (FABLES: LLM judges are weakest at
 * detecting unfaithfulness) — the runner uses them to gate/verify judge
 * verdicts, never the other way around.
 *
 * Contents:
 *   - anchor grounding: normalizeWs / anchorPresent / quoteFidelity /
 *     extractQuotes / scanDistractors
 *   - page shape: hasWikilink / slugDisciplineOk / selfContainedOpening
 *   - claim decomposition: segmentClaims (hallucination denominator)
 *   - scaffold contamination: addedContent (line-level diff)
 *   - stats: compressionRatio / thresholdCurve / weightedKappa /
 *     bootstrapCI / seededSample / computeDelta
 */

// ─── Whitespace normalization + anchor checks ────────────────────────────

/**
 * Collapse every whitespace run (incl. unicode spaces like NBSP) to a single
 * ASCII space and trim. Case is PRESERVED — anchors are verbatim phrases and
 * case-insensitive matching would let near-misses pass.
 */
export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * True when `anchor` appears in `text` as a normalized-whitespace substring.
 * An anchor that normalizes to the empty string is NEVER present (an empty
 * string is a substring of everything — that would make every distractor
 * scan and every quote-fidelity check trivially pass).
 */
export function anchorPresent(anchor: string, text: string): boolean {
  // Case-INSENSITIVE: the generator's validation gate lowercases before
  // matching, so committed anchors may be case-shifted by the prose model
  // (measured: 14/261 in transcript-distill-v1, incl. 3 distractor anchors).
  // A case-sensitive scanner made those permanently invisible to leakage
  // detection — "is this phrase present" is a case-insensitive question.
  const a = normalizeWs(anchor).toLowerCase();
  if (a.length === 0) return false;
  return normalizeWs(text).toLowerCase().includes(a);
}

// ─── Quote extraction + fidelity ──────────────────────────────────────────

/**
 * Extract quoted material from a markdown body.
 *
 * - `blockquotes`: consecutive `>`-prefixed lines joined per block with a
 *   single space, `>` markers stripped. ANY length qualifies (the ≥40-char
 *   threshold applies only to inline spans) — so short blockquotes cannot
 *   escape both the quote-fidelity check and segmentClaims. Blocks that are
 *   entirely empty (bare `>` lines) are dropped.
 * - `inlineSpans`: double-quoted spans (straight `"…"` or curly `“…”`) of
 *   ≥40 chars. Spans may not cross newlines (guards against unbalanced
 *   quotes pairing across paragraphs).
 */
export function extractQuotes(body: string): { blockquotes: string[]; inlineSpans: string[] } {
  const blockquotes: string[] = [];
  let current: string[] | null = null;
  for (const line of body.split('\n')) {
    const m = /^\s*>\s?(.*)$/.exec(line);
    if (m) {
      if (!current) current = [];
      current.push(m[1]);
    } else if (current) {
      const joined = normalizeWs(current.join(' '));
      if (joined.length > 0) blockquotes.push(joined);
      current = null;
    }
  }
  if (current) {
    const joined = normalizeWs(current.join(' '));
    if (joined.length > 0) blockquotes.push(joined);
  }

  const inlineSpans: string[] = [];
  for (const re of [/"([^"\n]{40,})"/g, /“([^”\n]{40,})”/g]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) inlineSpans.push(m[1]);
  }
  return { blockquotes, inlineSpans };
}

/**
 * Quote fidelity: every blockquote (any length) + every qualifying inline
 * span (≥40 chars) must be a normalized-ws substring of the transcript.
 */
export function quoteFidelity(body: string, transcript: string): { total: number; grounded: number } {
  const { blockquotes, inlineSpans } = extractQuotes(body);
  const quotes = [...blockquotes, ...inlineSpans];
  let grounded = 0;
  for (const q of quotes) {
    if (anchorPresent(q, transcript)) grounded++;
  }
  return { total: quotes.length, grounded };
}

// ─── Page-shape checks ────────────────────────────────────────────────────

/**
 * True when the body contains a `[[wikilink]]` or a markdown link whose
 * target is not http(s) (i.e. a relative brain link).
 */
export function hasWikilink(body: string): boolean {
  if (/\[\[[^\]]+\]\]/.test(body)) return true;
  return /\[[^\]]+\]\((?!https?:\/\/)[^)\s][^)]*\)/.test(body);
}

/**
 * Slug discipline: every `/`-separated segment is lowercase alnum+hyphen
 * (no underscores, no dots — so no `.md` suffix), and the slug starts with
 * one of `allowPrefixes`. A prefix ending in `*` is a glob: the slug must
 * start with the part before the `*`. An EMPTY allowlist disables the prefix
 * check (shape-only).
 */
export function slugDisciplineOk(slug: string, allowPrefixes: string[]): boolean {
  if (slug.length === 0) return false;
  const segments = slug.split('/');
  const segmentRe = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  for (const seg of segments) {
    if (!segmentRe.test(seg)) return false;
  }
  if (allowPrefixes.length === 0) return true;
  return allowPrefixes.some((p) =>
    p.endsWith('*') ? slug.startsWith(p.slice(0, -1)) : slug.startsWith(p),
  );
}

/**
 * Self-contained opening: the first non-frontmatter, non-heading paragraph
 * must appear BEFORE any blockquote and be ≥2 complete sentences AND ≥120
 * chars (normalized). This mirrors the synthesis prompt's "2-3 sentence
 * self-contained opening" mandate.
 */
export function selfContainedOpening(body: string): boolean {
  const lines = stripFrontmatter(body).split('\n');
  const para: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\s*>/.test(line)) {
      // Blockquote before (or interrupting) the opening paragraph.
      break;
    }
    if (trimmed.length === 0) {
      if (para.length > 0) break; // paragraph ended
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed)) {
      if (para.length > 0) break;
      continue; // skip headings before the opening paragraph
    }
    para.push(trimmed);
  }
  const text = normalizeWs(para.join(' '));
  if (text.length < 120) return false;
  const sentenceEnds = text.match(/[.!?]+(?=\s|$)/g) ?? [];
  return sentenceEnds.length >= 2;
}

// ─── Claim segmentation (hallucination denominator) ───────────────────────

/**
 * Split a page body into atomic claims for the grounding judge.
 *
 * Splits on sentence boundaries AND bullet/list items. Drops:
 *   - YAML frontmatter
 *   - headings
 *   - blockquote lines (covered by quoteFidelity, never double-counted)
 *   - fenced code blocks (``` or ~~~ fences; code lines are not claims)
 *   - wikilink-only lines (link farms are not claims)
 *   - interrogatives (sentences ending in `?`)
 *   - anything under 5 words
 *
 * Compound sentences stay atomic — a disclosed v1 limitation (deterministic
 * mechanical segmentation over FactScore-style LLM decomposition).
 */
export function segmentClaims(body: string): string[] {
  const lines = stripFrontmatter(body).split('\n');
  const candidates: string[] = [];
  let paragraph: string[] = [];
  let inFence = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    candidates.push(...splitSentences(paragraph.join(' ')));
    paragraph = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      flushParagraph();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (trimmed.length === 0) {
      flushParagraph();
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed) || /^>/.test(trimmed)) {
      flushParagraph();
      continue;
    }
    const bullet = /^([-*+]|\d+[.)])\s+(.*)$/.exec(trimmed);
    const content = bullet ? bullet[2] : trimmed;
    if (isWikilinkOnly(content)) {
      flushParagraph();
      continue;
    }
    if (bullet) {
      flushParagraph();
      candidates.push(...splitSentences(content));
    } else {
      paragraph.push(trimmed);
    }
  }
  flushParagraph();

  return candidates.filter((c) => {
    if (c.endsWith('?')) return false; // questions are not declaratives
    return c.split(/\s+/).filter(Boolean).length >= 5;
  });
}

function stripFrontmatter(body: string): string {
  if (!body.startsWith('---')) return body;
  const lines = body.split('\n');
  if (lines[0].trim() !== '---') return body;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '---' || t === '...') return lines.slice(i + 1).join('\n');
  }
  return body; // unterminated frontmatter — treat as content
}

function splitSentences(text: string): string[] {
  return normalizeWs(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isWikilinkOnly(content: string): boolean {
  if (!/\[\[[^\]]*\]\]/.test(content)) return false;
  const stripped = content.replace(/\[\[[^\]]*\]\]/g, '');
  return /^[\s,;:.\-–—*&|/]*$/.test(stripped);
}

// ─── Distractors + scaffold contamination ─────────────────────────────────

/** IDs of distractors whose anchor is present (normalized-ws) in `text`. */
export function scanDistractors(distractors: { id: string; anchor: string }[], text: string): string[] {
  return distractors.filter((d) => anchorPresent(d.anchor, text)).map((d) => d.id);
}

/**
 * Line-level diff: lines in `currentBody` that are NOT in `seededBody`
 * (added + changed), joined with newlines. A rewritten line counts as added
 * (it no longer matches the seeded multiset). Comparison is on trimmed line
 * content; blank lines are ignored; output preserves the original current
 * line text. Used to grade only what the dream lane ADDED to a pre-seeded
 * scaffold page (contamination fix).
 */
export function addedContent(seededBody: string, currentBody: string): string {
  const seededCounts = new Map<string, number>();
  for (const line of seededBody.split('\n')) {
    const key = line.trim();
    if (key.length === 0) continue;
    seededCounts.set(key, (seededCounts.get(key) ?? 0) + 1);
  }
  const added: string[] = [];
  for (const line of currentBody.split('\n')) {
    const key = line.trim();
    if (key.length === 0) continue;
    const remaining = seededCounts.get(key) ?? 0;
    if (remaining > 0) {
      seededCounts.set(key, remaining - 1);
    } else {
      added.push(line);
    }
  }
  return added.join('\n');
}

// ─── Compression ratio ────────────────────────────────────────────────────

/**
 * Output-tokens / transcript-tokens under the chars/4 approximation applied
 * IDENTICALLY to both sides (it's a ratio; the /4 cancels but is kept for
 * methodology honesty — both sides are stated in approximate tokens).
 * Empty transcript → 0 (avoids Infinity in the receipt JSON).
 */
export function compressionRatio(outputText: string, transcriptText: string): number {
  const outTokens = outputText.length / 4;
  const txTokens = transcriptText.length / 4;
  if (txTokens === 0) return 0;
  return outTokens / txTokens;
}

// ─── Triage threshold curve (E6) ──────────────────────────────────────────

export interface TriageVerdictRow {
  transcript_id: string;
  score: number;
  expected: 'high' | 'low';
}

/**
 * Descriptive pass-rates at each threshold from cached triage scores (zero
 * extra synthesis). `high_pass_rate` = fraction of expected-high rows with
 * score ≥ t; `low_pass_rate` = same for expected-low (lower is better);
 * accuracy treats "high passes AND low fails" as correct. Empty groups
 * yield rate 0.
 */
export function thresholdCurve(
  rows: TriageVerdictRow[],
  thresholds: number[] = [0.3, 0.5, 0.7],
): { threshold: number; high_pass_rate: number; low_pass_rate: number; accuracy: number }[] {
  const high = rows.filter((r) => r.expected === 'high');
  const low = rows.filter((r) => r.expected === 'low');
  return thresholds.map((t) => {
    const highPass = high.filter((r) => r.score >= t).length;
    const lowPass = low.filter((r) => r.score >= t).length;
    const correct = highPass + (low.length - lowPass);
    return {
      threshold: t,
      high_pass_rate: high.length ? highPass / high.length : 0,
      low_pass_rate: low.length ? lowPass / low.length : 0,
      accuracy: rows.length ? correct / rows.length : 0,
    };
  });
}

// ─── Linearly weighted Cohen's kappa (E2) ─────────────────────────────────

/**
 * Linearly weighted Cohen's kappa over ORDERED labels (default
 * FULL/PARTIAL/ABSENT — a FULL↔ABSENT disagreement costs twice a
 * FULL↔PARTIAL one; unweighted kappa is wrong for ordered labels).
 *
 * kappa_w = 1 − (observed weighted disagreement / expected weighted
 * disagreement), weights w_ij = |i − j|.
 *
 * Behavior notes (documented per spec):
 *   - throws on length mismatch or a label outside `orderedLabels`;
 *   - PERFECT agreement returns 1 even when marginals are degenerate
 *     (e.g. both raters said FULL for every item) — degenerate-but-perfect
 *     is agreement, not undefined;
 *   - n === 0 returns NaN (no data, no statement).
 */
export function weightedKappa(
  a: string[],
  b: string[],
  orderedLabels: string[] = ['FULL', 'PARTIAL', 'ABSENT'],
): number {
  if (a.length !== b.length) {
    throw new Error(`weightedKappa: length mismatch (a=${a.length}, b=${b.length})`);
  }
  const n = a.length;
  if (n === 0) return NaN;
  const idx = new Map(orderedLabels.map((l, i) => [l, i]));
  const toIdx = (label: string, side: string): number => {
    const i = idx.get(label);
    if (i === undefined) throw new Error(`weightedKappa: unknown label '${label}' in ${side}`);
    return i;
  };
  const ai = a.map((l) => toIdx(l, 'a'));
  const bi = b.map((l) => toIdx(l, 'b'));

  let observed = 0;
  for (let k = 0; k < n; k++) observed += Math.abs(ai[k] - bi[k]);
  observed /= n;
  if (observed === 0) return 1; // perfect agreement, degenerate marginals included

  const k = orderedLabels.length;
  const pa = new Array(k).fill(0);
  const pb = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    pa[ai[i]] += 1 / n;
    pb[bi[i]] += 1 / n;
  }
  let expected = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      expected += Math.abs(i - j) * pa[i] * pb[j];
    }
  }
  if (expected === 0) return observed === 0 ? 1 : 0; // unreachable when observed > 0
  return 1 - observed / expected;
}

// ─── Seeded bootstrap CI + sampling ───────────────────────────────────────

/** Mulberry32 — deterministic 32-bit PRNG, inline (no deps). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Transcript-level bootstrap CI: resample `perTranscript` with replacement
 * `draws` times (default 1000), take the mean of each draw, report the
 * 2.5/97.5 percentiles. `mean` is the plain sample mean of the input.
 * Deterministic for a fixed seed. Empty input → all-NaN.
 */
export function bootstrapCI(
  perTranscript: number[],
  seed: number,
  draws: number = 1000,
): { lo: number; hi: number; mean: number } {
  const n = perTranscript.length;
  if (n === 0) return { lo: NaN, hi: NaN, mean: NaN };
  const mean = perTranscript.reduce((a, b) => a + b, 0) / n;
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let d = 0; d < draws; d++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += perTranscript[Math.floor(rand() * n)];
    means.push(sum / n);
  }
  means.sort((x, y) => x - y);
  const loIdx = Math.min(draws - 1, Math.floor(0.025 * draws));
  const hiIdx = Math.min(draws - 1, Math.max(loIdx, Math.ceil(0.975 * draws) - 1));
  return { lo: means[loIdx], hi: means[hiIdx], mean };
}

/**
 * Deterministic without-replacement sample: Fisher–Yates shuffle a copy
 * with Mulberry32(seed), take the first min(n, arr.length). Input array is
 * not mutated.
 */
export function seededSample<T>(arr: T[], n: number, seed: number): T[] {
  const copy = arr.slice();
  const rand = mulberry32(seed);
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.max(0, Math.min(n, copy.length)));
}

// ─── Regression delta (E1) ────────────────────────────────────────────────

export interface DeltaResult {
  comparable: boolean;
  skipped_reason?: string;
  deltas?: Record<string, { prior: number; current: number; delta: number }>;
}

/**
 * Compare the current run's headline metrics against a prior receipt.
 * Comparability guard: mode + lanes (order-insensitive) + corpus must all
 * match, else `comparable: false` with a reason (deltas across different
 * modes/lane-sets/corpora are meaningless). Deltas are computed only for
 * headline keys present in BOTH runs. Deltas are informational — nothing
 * gates on them (single stochastic runs carry no CI).
 */
export function computeDelta(
  current: { mode: string; lanes: string[]; corpus: string; headline: Record<string, number> },
  prior: { mode?: string; lanes?: string[]; corpus?: string; headline?: Record<string, number> } | null,
): DeltaResult {
  if (!prior) return { comparable: false, skipped_reason: 'no prior run' };
  if (prior.mode !== current.mode) {
    return {
      comparable: false,
      skipped_reason: `mode mismatch (prior=${prior.mode ?? 'unknown'}, current=${current.mode})`,
    };
  }
  const laneKey = (lanes: string[] | undefined) => (lanes ?? []).slice().sort().join(',');
  if (laneKey(prior.lanes) !== laneKey(current.lanes)) {
    return {
      comparable: false,
      skipped_reason: `lanes mismatch (prior=[${laneKey(prior.lanes)}], current=[${laneKey(current.lanes)}])`,
    };
  }
  if (prior.corpus !== current.corpus) {
    return {
      comparable: false,
      skipped_reason: `corpus mismatch (prior=${prior.corpus ?? 'unknown'}, current=${current.corpus})`,
    };
  }
  const deltas: Record<string, { prior: number; current: number; delta: number }> = {};
  const priorHeadline = prior.headline ?? {};
  for (const [key, cur] of Object.entries(current.headline)) {
    const prev = priorHeadline[key];
    if (typeof prev !== 'number') continue;
    deltas[key] = { prior: prev, current: cur, delta: cur - prev };
  }
  return { comparable: true, deltas };
}
