/**
 * Adversarial injection kinds shared by Cat 10 (adversarial.ts — 22 hand-
 * crafted edge cases) and Cat 6 (cat6-prose-scale.ts — 500+ prose-page
 * variants). Each kind is a deterministic transform from a base page
 * content string to a modified content string + a gold-delta description
 * of what the extractor's output should look like.
 *
 * The module lives alongside adversarial.ts but is NEW code — adversarial.ts
 * itself is a static case list, not a reusable transform engine. That's why
 * the original plan said "extract the engine from adversarial.ts" but codex
 * caught the overstatement: there's nothing to extract, we're building
 * the engine fresh here.
 *
 * Each injection has a `kind` tag that flows into `eval/data/world-v1-
 * adversarial/_adversarial/{slug}.json` metadata so the Cat 6 scorer can
 * compute per-kind precision / recall / false-positive rate.
 *
 * Feature boundary: the pipeline under test is gbrain's pure link extractor
 * (`extractPageLinks` in gbrain/link-extraction) as exercised by the Cat 6 /
 * Cat 10 runners. The injections themselves (content transforms + gold
 * deltas) are harness-side and deterministic (seeded Mulberry32); nothing
 * here calls an LLM or a database. `scoreGoldDelta` below is the canonical
 * scorer for a GoldDelta — consumers must use it (or match its semantics)
 * so `must_extract[].type` with `enforce_type` is actually enforced and
 * type-downgrade injections can fail on mistyping.
 */

export type InjectionKind =
  | 'code_fence_leak'       // fake [X](people/fake-slug) inside ``` fences — must NOT extract
  | 'inline_code_slug'      // `people/x` in backticks — must NOT extract
  | 'substring_collision'   // "SamAI" near real person "sam" — exactly one link
  | 'ambiguous_role'        // "works with" vs "works at" — downgrade to `mentions`
  | 'prose_only_mention'    // strip the [X](people/slug) syntax; bare name remains — `mentions` only
  | 'multi_entity_sentence';// 4+ entities in one clause — all N links extracted

export interface EntityRef {
  /** Slug matching the one-slash validator regex. */
  slug: string;
  /** Display name, used when building markdown links. */
  name: string;
}

export interface InjectionInput {
  /** The base content to inject into. Usually compiled_truth from a world-v1 page. */
  content: string;
  /** Seed for deterministic variant selection. */
  seed: number;
  /** Available entity references for this corpus (sampled to build transforms). */
  refs: EntityRef[];
  /** Specific entities to use (overrides `refs` sampling; useful for tests). */
  forcedRefs?: EntityRef[];
}

export interface InjectionResult {
  /** Transformed content with the injection applied. */
  content: string;
  /** Structured description of what the extractor should and should NOT produce. */
  goldDelta: GoldDelta;
}

export interface GoldDelta {
  /**
   * Links that MUST NOT appear in extraction output. Used by Cat 6's
   * `false_positive_rate` metric. For code_fence_leak / inline_code_slug
   * this lists the fake slugs inside fences; for substring_collision the
   * near-miss match; etc.
   */
  must_not_extract: Array<{ slug: string; reason: string }>;
  /**
   * Links that MUST appear in extraction output (exact match). Used by
   * Cat 6 recall + per-kind recall. Empty when the injection is purely
   * negative (e.g., isolated code_fence_leak test).
   *
   * `enforce_type` marks entries whose DISCRIMINATING criterion is the link
   * type (ambiguous_role, prose_only_mention): a slug extracted with a
   * different type is a `mistyped` failure, not a match. Entries without
   * the flag match on slug alone — their kinds test presence/absence, and
   * gbrain's page-role priors may legitimately assign a non-`mentions`
   * type to the injected link.
   */
  must_extract: Array<{ slug: string; type: string; reason: string; enforce_type?: boolean }>;
  /** Human-readable note for the scorer's error reporting. */
  note: string;
}

// ─── Seeded PRNG (Mulberry32, matches amara-life.ts) ──────────────────

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, xs: T[]): T {
  if (xs.length === 0) throw new Error('pick: cannot pick from empty array');
  return xs[Math.floor(rng() * xs.length)];
}

// ─── Individual injections ────────────────────────────────────────────

export function injectCodeFenceLeak(input: InjectionInput): InjectionResult {
  const rng = createRng(input.seed);
  const realTarget = pick(rng, input.forcedRefs ?? input.refs);
  const fakeSlug = `people/fake-${input.seed % 10000}`;

  const fenceBlock = [
    '```',
    `const example = "${fakeSlug}";`,
    `// See also [FakeName](${fakeSlug}) — should NOT extract from inside a fence`,
    '```',
  ].join('\n');

  // Real mention (OUTSIDE the fence) so the baseline link is still there.
  const realMention = `See also [${realTarget.name}](${realTarget.slug}) for more.`;

  const content = `${input.content}\n\n${fenceBlock}\n\n${realMention}`;

  return {
    content,
    goldDelta: {
      must_not_extract: [
        {
          slug: fakeSlug,
          reason: 'code_fence_leak: slug appears inside triple-backtick fence',
        },
      ],
      must_extract: [
        {
          slug: realTarget.slug,
          type: 'mentions',
          reason: 'code_fence_leak: real mention outside the fence should still extract',
        },
      ],
      note: `Injected fake slug ${fakeSlug} inside code fence + real mention ${realTarget.slug} outside.`,
    },
  };
}

export function injectInlineCodeSlug(input: InjectionInput): InjectionResult {
  const rng = createRng(input.seed);
  const realTarget = pick(rng, input.forcedRefs ?? input.refs);
  const fakeSlug = `people/inline-fake-${input.seed % 10000}`;

  const content = `${input.content}\n\nUse the \`${fakeSlug}\` notation in code. Real ref: [${realTarget.name}](${realTarget.slug}).`;

  return {
    content,
    goldDelta: {
      must_not_extract: [
        {
          slug: fakeSlug,
          reason: 'inline_code_slug: slug wrapped in single-backtick inline code',
        },
      ],
      must_extract: [
        { slug: realTarget.slug, type: 'mentions', reason: 'inline_code_slug: real mention outside inline code' },
      ],
      note: `Injected fake slug ${fakeSlug} in inline code + real mention ${realTarget.slug}.`,
    },
  };
}

export function injectSubstringCollision(input: InjectionInput): InjectionResult {
  const rng = createRng(input.seed);
  const pool = input.forcedRefs ?? input.refs;
  const realTarget = pick(rng, pool);
  // Substring collision, rebuilt so a false positive CAN occur (audit
  // misc-runners-04: the old fabricated `people/<name>ai` slug was
  // unreachable by ANY extraction pass — even a sloppy prose-name matcher
  // would emit the REAL slug, never the fabricated one, so the FP branch
  // was structurally dead and substring_fp_rate was always 0).
  //
  // New shape: pick a SECOND corpus entity (the collision target) that is
  // NOT otherwise linked on this page, and inject its name-prefix collision
  // word ("Sam" -> "SamAI") as plain prose. The forbidden slug is that real
  // entity's slug: a name-based / substring auto-linker bug that resolves
  // "SamAI" to the entity "Sam" now produces a detectable FP (the slug is
  // real and never legitimately linked here), while a correct extractor —
  // which never links bare prose words — extracts nothing for it.
  const eligible = pool.filter(
    r => r.slug !== realTarget.slug && !input.content.includes(r.slug),
  );
  const collisionTarget = eligible.length > 0 ? pick(rng, eligible) : null;

  const baseName = (collisionTarget ?? realTarget).name.split(' ')[0];
  const collisionWord = `${baseName}AI`;
  // Fallback (single-ref pools, e.g. forcedRefs in tests): keep the legacy
  // fabricated near-miss slug. Weaker (only a slug-fabrication bug can trip
  // it) but never spuriously chargeable.
  const forbiddenSlug = collisionTarget
    ? collisionTarget.slug
    : `people/${baseName.toLowerCase()}ai`;
  const forbiddenReason = collisionTarget
    ? `substring_collision: prose word "${collisionWord}" contains the name of ${collisionTarget.slug}, which is never linked on this page — extracting it means a prose-substring match fired`
    : `substring_collision: "${collisionWord}" must not be auto-linked to a people/ slug`;

  const content = `${input.content}\n\nThe ${collisionWord} initiative (unrelated) was launched last quarter. In parallel, [${realTarget.name}](${realTarget.slug}) continued their work on climate tooling.`;

  return {
    content,
    goldDelta: {
      must_not_extract: [{ slug: forbiddenSlug, reason: forbiddenReason }],
      must_extract: [
        { slug: realTarget.slug, type: 'mentions', reason: 'substring_collision: real markdown link should extract' },
      ],
      note: `Injected substring collision "${collisionWord}" (forbidden: ${forbiddenSlug}) near real mention ${realTarget.slug}.`,
    },
  };
}

export function injectAmbiguousRole(input: InjectionInput): InjectionResult {
  const rng = createRng(input.seed);
  const pool = input.forcedRefs ?? input.refs;
  // Replace "works at" → "works with" if present, and ALWAYS append a
  // "works with [realTarget]" sentence so the gold entity actually exists
  // in the content (audit misc-runners-03 / tests-audit-05: the old
  // replace-only branch demanded extraction of a random corpus entity that
  // was never inserted, charging a guaranteed miss to the extractor).
  // "works with" should downgrade to `mentions`, not `works_at`.
  //
  // Type enforcement is only fair when the harness controls the typing
  // context, because gbrain types links from (a) a ±120-char window around
  // the FIRST occurrence of the display name and (b) a page-role prior that
  // legitimately upgrades person→`companies/` links to works_at/invested_in
  // (link-extraction.ts inferLinkType). So prefer a `people/` target whose
  // name and slug do not already appear in the base content, and pad the
  // injected sentence so the per-edge window sees only injection-owned text.
  // When no such target exists (tiny forcedRefs pools), still assert slug
  // presence but drop enforce_type rather than charge gbrain's documented
  // prior behavior as a mistype.
  const isolated = pool.filter(
    r => r.slug.startsWith('people/')
      && !input.content.includes(r.slug)
      && !input.content.includes(r.name),
  );
  const typeEnforceable = isolated.length > 0;
  const realTarget = pick(rng, typeEnforceable ? isolated : pool);
  const hasWorksAt = /works at/i.test(input.content);
  const base = hasWorksAt
    ? input.content.replace(/works at/gi, 'works with')
    : input.content;
  // Neutral 130+ char lead-in: fills the type-inference window with text that
  // matches none of gbrain's verb regexes (works_at/founded/invested/advises).
  const buffer =
    'The paragraph below records routine collaboration notes taken verbatim '
    + 'from the weekly sync log; it makes no claim about titles or employers.';
  const content = `${base}\n\n${buffer} She regularly works with [${realTarget.name}](${realTarget.slug}) on quarterly reviews.`;

  return {
    content,
    goldDelta: {
      must_not_extract: [], // The slug IS extracted; we just want type = mentions, not works_at
      must_extract: [
        {
          slug: realTarget.slug,
          type: 'mentions',
          ...(typeEnforceable ? { enforce_type: true } : {}),
          reason: typeEnforceable
            ? 'ambiguous_role: "works with" is loose enough that type must downgrade from works_at to mentions'
            : 'ambiguous_role: pool too small to isolate typing context; asserting slug presence only',
        },
      ],
      note: `Injected "works with" phrasing for ${realTarget.slug} (must not upgrade to works_at).`,
    },
  };
}

export function injectProseOnlyMention(input: InjectionInput): InjectionResult {
  const rng = createRng(input.seed);
  const realTarget = pick(rng, input.forcedRefs ?? input.refs);
  // Strip markdown link syntax around the target's name — leave the bare name
  // in prose. Extractor should only produce a `mentions` link (not `founded`
  // or any typed relation), because the evidence is just prose co-occurrence.
  const nameRe = new RegExp(
    `\\[${escapeRegex(realTarget.name)}\\]\\(${escapeRegex(realTarget.slug)}\\)`,
    'g',
  );
  const stripped = input.content.replace(nameRe, realTarget.name);
  const content =
    stripped.length === input.content.length
      ? `${input.content}\n\n${realTarget.name} has been a familiar figure in the industry for years.`
      : stripped;

  return {
    content,
    goldDelta: {
      must_not_extract: [],
      must_extract: [
        {
          slug: realTarget.slug,
          type: 'mentions',
          enforce_type: true,
          reason: 'prose_only_mention: bare name in prose resolves to mentions, not typed relation',
        },
      ],
      note: `Stripped markdown link around ${realTarget.name}, leaving bare prose mention only.`,
    },
  };
}

export function injectMultiEntitySentence(input: InjectionInput): InjectionResult {
  const rng = createRng(input.seed);
  const availableRefs = input.forcedRefs ?? input.refs;
  const n = Math.min(5, availableRefs.length);
  if (n < 4) {
    // Degenerate — not enough refs to build a multi-entity sentence.
    return {
      content: input.content,
      goldDelta: {
        must_not_extract: [],
        must_extract: [],
        note: 'multi_entity_sentence: skipped (fewer than 4 refs available)',
      },
    };
  }
  const picks: EntityRef[] = [];
  const seen = new Set<string>();
  // Deterministic pick of n unique refs
  let attempts = 0;
  while (picks.length < n && attempts < n * 10) {
    const ref = pick(rng, availableRefs);
    if (!seen.has(ref.slug)) {
      picks.push(ref);
      seen.add(ref.slug);
    }
    attempts++;
  }

  const mdLinks = picks.map(r => `[${r.name}](${r.slug})`);
  const clause =
    `At the most recent Halfway partners meeting, ` +
    `${mdLinks.slice(0, -1).join(', ')}, and ${mdLinks[mdLinks.length - 1]} all discussed the quarterly outlook.`;

  const content = `${input.content}\n\n${clause}`;

  return {
    content,
    goldDelta: {
      must_not_extract: [],
      must_extract: picks.map(r => ({
        slug: r.slug,
        type: 'mentions',
        reason: `multi_entity_sentence: all ${n} entities in a packed clause should extract`,
      })),
      note: `Injected packed clause with ${n} entities: ${picks.map(r => r.slug).join(', ')}.`,
    },
  };
}

// ─── Dispatcher ──────────────────────────────────────────────────────

export const ALL_INJECTION_KINDS: readonly InjectionKind[] = [
  'code_fence_leak',
  'inline_code_slug',
  'substring_collision',
  'ambiguous_role',
  'prose_only_mention',
  'multi_entity_sentence',
] as const;

export function applyInjection(kind: InjectionKind, input: InjectionInput): InjectionResult {
  switch (kind) {
    case 'code_fence_leak':
      return injectCodeFenceLeak(input);
    case 'inline_code_slug':
      return injectInlineCodeSlug(input);
    case 'substring_collision':
      return injectSubstringCollision(input);
    case 'ambiguous_role':
      return injectAmbiguousRole(input);
    case 'prose_only_mention':
      return injectProseOnlyMention(input);
    case 'multi_entity_sentence':
      return injectMultiEntitySentence(input);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Canonical GoldDelta scorer ──────────────────────────────────────
//
// The ONE place a GoldDelta is compared against extractor output. Audit
// misc-runners-05: the previous consumer (cat6-prose-scale.ts scoreVariant)
// matched must_extract by slug alone, so `type` was computed into the gold
// and silently dropped — ambiguous_role / prose_only_mention could never
// fail on the type downgrade that is their whole point. Consumers should
// call this instead of re-implementing slug-set membership.

/** Minimal extracted-link shape (matches cat6's ExtractedLink). */
export interface ExtractedLinkLike {
  targetSlug: string;
  linkType: string;
}

export interface GoldDeltaScore {
  /** must_extract entries whose slug appeared (and, when enforce_type, with the required type). */
  matched: Array<{ slug: string; type: string }>;
  /** enforce_type entries whose slug appeared but ONLY with a different type — a scoring failure. */
  mistyped: Array<{ slug: string; expected_type: string; actual_types: string[]; reason: string }>;
  /** must_extract entries whose slug never appeared. */
  missed: Array<{ slug: string; type: string; reason: string }>;
  /** must_not_extract entries whose slug appeared. */
  false_positives: Array<{ slug: string; reason: string }>;
}

/**
 * Score extractor output against a GoldDelta.
 *
 * - must_not_extract: slug present in output → false positive.
 * - must_extract without `enforce_type`: slug present → matched (any type).
 * - must_extract with `enforce_type`: slug present with the required type →
 *   matched; slug present but only with other types → mistyped (a failure,
 *   NOT a match); slug absent → missed.
 */
export function scoreGoldDelta(
  gold: GoldDelta,
  extracted: readonly ExtractedLinkLike[],
): GoldDeltaScore {
  const typesBySlug = new Map<string, Set<string>>();
  for (const e of extracted) {
    if (!typesBySlug.has(e.targetSlug)) typesBySlug.set(e.targetSlug, new Set());
    typesBySlug.get(e.targetSlug)!.add(e.linkType);
  }

  const score: GoldDeltaScore = { matched: [], mistyped: [], missed: [], false_positives: [] };

  for (const mustNot of gold.must_not_extract) {
    if (typesBySlug.has(mustNot.slug)) {
      score.false_positives.push({ slug: mustNot.slug, reason: mustNot.reason });
    }
  }

  for (const must of gold.must_extract) {
    const types = typesBySlug.get(must.slug);
    if (!types) {
      score.missed.push({ slug: must.slug, type: must.type, reason: must.reason });
    } else if (must.enforce_type && !types.has(must.type)) {
      score.mistyped.push({
        slug: must.slug,
        expected_type: must.type,
        actual_types: [...types].sort(),
        reason: must.reason,
      });
    } else {
      score.matched.push({ slug: must.slug, type: must.type });
    }
  }

  return score;
}
