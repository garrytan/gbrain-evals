/**
 * Facts-absorb quality gate (R2): the world generator, the model-free scorer
 * on hand-built fact sets (a perfect extractor passes, the disabled and
 * drop-all mutants and each planted failure fail), the preregistered decision
 * rule, the drop-output proxy transform and the parse-failure accounting.
 */
import { describe, expect, test } from 'bun:test';
import { generateFactsAbsorbWorld, renderSessionNote, type Claim, type FactsAbsorbWorld } from '../../eval/generators/facts-absorb-gen.ts';
import { amountsIn, decide, scoreArm, type ArmValidity, type StoredFact } from '../../eval/runner/facts-absorb/score.ts';
import { pairedNatural, type NaturalPage } from '../../eval/runner/facts-absorb/natural.ts';
import { DROPPED_OUTPUT, dropChatOutput, parseArms, parseFailureCounts } from '../../eval/runner/facts-absorb-gate.ts';
import { parseWriteCostArm } from '../../eval/runner/p8-write-cost.ts';

const world = generateFactsAbsorbWorld();
const valid: ArmValidity = { unhandled_parse_failures: 0, resolved_model_matches: true, unreadable_after_restart: 0, jobs_not_completed: 0 };
const nameOf = (w: FactsAbsorbWorld, id: string | null) => (id ? w.entities.find(e => e.id === id)!.name : '');

/** What a perfect extractor stores: one fact per claim, attributed the way the extraction prompt asks. */
function oracleFacts(w: FactsAbsorbWorld): StoredFact[] {
  return w.claims.map((c: Claim, i) => {
    const who = nameOf(w, c.entity);
    const text = c.type === 'assistant' ? `Assistant recommended ${c.value}`
      : c.type === 'third' ? `${c.source} said ${who} reported ${c.attr} of ${c.amount}`
        : c.amount !== undefined ? `${who} ${c.attr} for ${c.month} was ${c.amount}`
          : `${who} ${c.attr}: ${c.value}`;
    return { id: i + 1, fact: text, entity_slug: null, attributed_to: c.speaker, context: c.page, claim_value: c.amount ?? null };
  });
}

describe('facts-absorb world', () => {
  test('is deterministic and seed-dependent', () => {
    expect(generateFactsAbsorbWorld().fingerprint).toBe(world.fingerprint);
    expect(generateFactsAbsorbWorld({ seed: 61 }).fingerprint).not.toBe(world.fingerprint);
  });

  test('every claim, retracted value and rejection is written on its page', () => {
    const text = new Map(world.sessions.map(s => [s.slug, renderSessionNote(s).toLowerCase()]));
    for (const c of world.claims) {
      const page = text.get(c.page)!;
      if (c.amount === undefined) expect(page).toContain(c.value);
      if (c.retracted) expect(page).toContain(c.retracted);
      if (c.source) expect(page).toContain(c.source.toLowerCase());
    }
    for (const r of world.rejections) expect(text.get(r.page)!).toContain(r.value);
    expect(new Set(world.sessions.map(s => s.slug)).size).toBe(world.sessions.length);
    for (const s of world.sessions) expect(renderSessionNote(s)).toContain('type: note');
  });

  test('has enough cases of each kind to measure', () => {
    const n = (t: Claim['type']) => world.claims.filter(c => c.type === t).length;
    expect(n('self-fix')).toBeGreaterThanOrEqual(30);
    expect(n('metric-fix')).toBeGreaterThanOrEqual(16);
    expect(n('assistant')).toBeGreaterThanOrEqual(30);
    expect(n('third')).toBeGreaterThanOrEqual(15);
    expect(world.rejections.length).toBeGreaterThanOrEqual(30);
  });
});

describe('scorer', () => {
  test('amounts in every rendered form', () => {
    expect(amountsIn('MRR was $61,000')).toContain(61000);
    expect(amountsIn('burned $85k in May')).toContain(85000);
    expect(amountsIn('85 thousand dollars')).toContain(85000);
    expect(amountsIn('$1.25 million')).toContain(1250000);
    expect(amountsIn('47 people')).toContain(47);
  });

  test('the preregistered world fingerprints, and accents and singulars still match', () => {
    expect(world.fingerprint).toBe('2b3735ab474bad44ec07bfeef7446aa37bf35a4bab664eb630a6da139dd178a2');
    expect(generateFactsAbsorbWorld({ seed: 61 }).fingerprint).toBe('016811f4b668b02bdbfaeca5b32f77a8171b8bf6030412c37fabbbdc539f699b');
    const city = world.claims.find(c => c.attr === 'city' && /[ae]/.test(c.value))!;
    const accented = city.value.replace('e', 'é').replace('a', 'á');
    const allergy = world.claims.find(c => c.attr === 'allergy' && c.value.endsWith('s'))!;
    const s = scoreArm(world, [
      { id: 1, fact: `${nameOf(world, city.entity)} is based in ${accented[0].toUpperCase()}${accented.slice(1)}`, entity_slug: null, attributed_to: 'user', context: city.page, claim_value: null },
      { id: 2, fact: `${nameOf(world, allergy.entity).split(' ')[0]} has a ${allergy.value.slice(0, -1)} allergy`, entity_slug: null, attributed_to: 'user', context: allergy.page, claim_value: null },
    ]);
    expect(s.claims.find(c => c.id === city.id && c.page === city.page)!.recalled).toBe(true);
    expect(s.claims.find(c => c.id === allergy.id && c.page === allergy.page)!.recalled).toBe(true);
  });

  test('amendment 2: a claim repeated from an earlier page is recalled through the stored copy', () => {
    const w = { ...world, claims: [...world.claims] };
    const first = w.claims.find(c => c.attr === 'hobby')!;
    const later = w.sessions.find(s => s.slug > first.page)!;
    w.claims.push({ ...first, id: 'dup', page: later.slug });
    const s = scoreArm(w, [{ id: 1, fact: `${nameOf(w, first.entity)} took up ${first.value}`, entity_slug: null, attributed_to: 'user', context: first.page, claim_value: null }]);
    expect(s.claims.find(c => c.id === 'dup')!.recalled).toBe(true);
  });

  test('amendment 3: the user\'s reply about a recommendation is not an attribution error; claiming it as a choice is', () => {
    const rec = world.claims.find(c => c.type === 'assistant')!;
    const facts = (user: string): StoredFact[] => [
      { id: 1, fact: `Assistant recommended ${rec.value}`, entity_slug: null, attributed_to: 'assistant', context: rec.page, claim_value: null },
      { id: 2, fact: user, entity_slug: null, attributed_to: 'user', context: rec.page, claim_value: null },
    ];
    const ok = (user: string) => scoreArm(world, facts(user)).claims.find(c => c.id === rec.id && c.page === rec.page)!.attribution_ok;
    expect(ok(`User will look into ${rec.value}`)).toBe(true);
    expect(ok(`User decided to book ${rec.value}`)).toBe(false);
  });

  test('a perfect extractor scores 1 on every metric and passes against itself', () => {
    const s = scoreArm(world, oracleFacts(world));
    expect(s.totals.recall).toBe(1);
    expect(s.totals.precision).toBe(1);
    expect(s.totals.attribution).toBe(1);
    expect(s.totals.correction).toBe(1);
    expect(decide(s, s, valid).pass).toBe(true);
  });

  test('the disabled and drop-all mutants (no facts) fail the gate', () => {
    const base = scoreArm(world, oracleFacts(world));
    const empty = scoreArm(world, []);
    const v = decide(base, empty, valid);
    expect(v.pass).toBe(false);
    expect(v.checks.find(c => c.name === 'recall non-inferior')!.pass).toBe(false);
  });

  test('restating a retracted value fails the correction case and counts as wrong', () => {
    const fix = world.claims.find(c => c.type === 'self-fix')!;
    const facts = [...oracleFacts(world), { id: 99999, fact: `${nameOf(world, fix.entity)} ${fix.attr}: ${fix.retracted}`, entity_slug: null, attributed_to: 'user', context: fix.page, claim_value: null }];
    const s = scoreArm(world, facts);
    expect(s.claims.find(c => c.id === fix.id)!.correction_ok).toBe(false);
    expect(s.facts.find(f => f.id === 99999)!.class).toBe('wrong');
    const negated = scoreArm(world, [...oracleFacts(world), { id: 99999, fact: `${nameOf(world, fix.entity)} ${fix.attr} is not ${fix.retracted}`, entity_slug: null, attributed_to: 'user', context: fix.page, claim_value: null }]);
    expect(negated.claims.find(c => c.id === fix.id)!.correction_ok).toBe(true);
  });

  test('a metric correction restating the old amount fails', () => {
    const fix = world.claims.find(c => c.type === 'metric-fix')!;
    const s = scoreArm(world, [...oracleFacts(world), { id: 99999, fact: `${nameOf(world, fix.entity)} ${fix.attr} for ${fix.month} was ${fix.retracted_amount}`, entity_slug: null, attributed_to: 'user', context: fix.page, claim_value: fix.retracted_amount! }]);
    expect(s.claims.find(c => c.id === fix.id)!.correction_ok).toBe(false);
  });

  test('a rejected suggestion stated as fact leaks; reported as declined or as the assistant\'s it does not', () => {
    const r = world.rejections[0];
    const who = nameOf(world, r.entity);
    const leak = scoreArm(world, [...oracleFacts(world), { id: 99999, fact: `${who} works at ${r.value}`, entity_slug: null, attributed_to: 'user', context: r.page, claim_value: null }]);
    expect(leak.rejections.find(x => x.id === r.id)!.leaked_fact_ids).toEqual([99999]);
    expect(leak.totals.attribution).toBeLessThan(1);
    for (const ok of [`${who} turned down ${r.value}`, `Assistant suggested ${who} consider ${r.value}`]) {
      const s = scoreArm(world, [...oracleFacts(world), { id: 99999, fact: ok, entity_slug: null, attributed_to: ok.startsWith('Assistant') ? 'assistant' : 'user', context: r.page, claim_value: null }]);
      expect(s.rejections.find(x => x.id === r.id)!.leaked_fact_ids).toEqual([]);
      expect(s.facts.find(f => f.id === 99999)!.class).toBe('supported');
    }
  });

  test('an assistant recommendation stored as the user\'s, or hearsay without its source, fails attribution', () => {
    const facts = oracleFacts(world).map(f => {
      const c = world.claims[f.id - 1];
      if (c.type === 'assistant') return { ...f, fact: `User will use ${c.value}`, attributed_to: 'user' };
      if (c.type === 'third') return { ...f, fact: f.fact.replace(`${c.source} said `, '') };
      return f;
    });
    const s = scoreArm(world, facts);
    expect(s.totals.attribution).toBeLessThan(0.5);
    expect(decide(scoreArm(world, oracleFacts(world)), s, valid).checks.find(c => c.name === 'attribution no worse')!.pass).toBe(false);
  });

  test('a value paired with the wrong person is wrong; the assistant\'s advice given as the user\'s is wrong', () => {
    const c = world.claims.find(x => x.attr === 'city' && x.type === 'user')!;
    const other = world.entities.find(e => e.type === 'person' && e.id !== c.entity && !world.claims.some(x => x.page === c.page && x.entity === e.id))!;
    const s = scoreArm(world, [
      { id: 1, fact: `${other.name} lives in ${c.value}`, entity_slug: null, attributed_to: 'user', context: c.page, claim_value: null },
      { id: 2, fact: 'User said refundable fares are worth a premium', entity_slug: null, attributed_to: 'user', context: c.page, claim_value: null },
      { id: 3, fact: 'Assistant recommended refundable fares', entity_slug: null, attributed_to: 'assistant', context: c.page, claim_value: null },
    ]);
    expect(s.facts.map(f => f.class)).toEqual(['wrong', 'wrong', 'supported']);
  });

  test('parse failures, a failing validity check, and an unreadable fact each fail the gate', () => {
    const s = scoreArm(world, oracleFacts(world));
    expect(decide(s, s, { ...valid, unhandled_parse_failures: 1 }).pass).toBe(false);
    expect(decide(s, s, { ...valid, resolved_model_matches: false }).pass).toBe(false);
    expect(decide(s, s, { ...valid, unreadable_after_restart: 2 }).pass).toBe(false);
    expect(decide(s, s, { ...valid, jobs_not_completed: 1 }).pass).toBe(false);
  });
});

describe('runner pieces', () => {
  test('arm specs', () => {
    expect(parseArms('a=default,b=openai:gpt-6-luna,c=disabled,d=drop:anthropic:claude-haiku-5-5')).toEqual([
      { label: 'a', kind: 'default', model: null }, { label: 'b', kind: 'model', model: 'openai:gpt-6-luna' },
      { label: 'c', kind: 'disabled', model: null }, { label: 'd', kind: 'drop', model: 'anthropic:claude-haiku-5-5' },
    ]);
    expect(() => parseArms('a=gpt-6-luna')).toThrow();
  });

  test('write-cost arms: off, the default, and a named extraction model', () => {
    expect(parseWriteCostArm('off')).toEqual({ arm: 'off', enabled: false, model: null, slot: 'wc-off' });
    expect(parseWriteCostArm('on')).toEqual({ arm: 'on', enabled: true, model: null, slot: 'wc-on' });
    expect(parseWriteCostArm('on:openai:gpt-6-luna')).toMatchObject({ enabled: true, model: 'openai:gpt-6-luna', slot: 'wc-on-openai-gpt-6-luna' });
    expect(() => parseWriteCostArm('on:gpt-6-luna')).toThrow();
  });

  test('the drop mutant empties Anthropic and OpenAI chat output and keeps usage', () => {
    const anthropic = dropChatOutput(JSON.stringify({ content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '{"facts":[{"fact":"a"}]}' }], usage: { input_tokens: 5, output_tokens: 7 } }));
    expect(anthropic.dropped).toBe(true);
    expect(JSON.parse(anthropic.text).content[1].text).toBe(DROPPED_OUTPUT);
    expect(JSON.parse(anthropic.text).usage.output_tokens).toBe(7);
    const responses = dropChatOutput(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"facts":[1]}' }] }], usage: { input_tokens: 1 } }));
    expect(JSON.parse(responses.text).output[0].content[0].text).toBe(DROPPED_OUTPUT);
    const chat = dropChatOutput(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"facts":[1]}' } }] }));
    expect(JSON.parse(chat.text).choices[0].message.content).toBe(DROPPED_OUTPUT);
    expect(dropChatOutput('data: not json').dropped).toBe(false);
  });

  test('a malformed extraction consumed with no failure record is an unhandled parse failure', () => {
    const job = (id: number, slug: string, status: string, result: Record<string, unknown> | null) => ({ id, name: 'facts-absorb', status, attempts_made: 1, result, error_text: null, data: { slug } });
    const jobs = [job(1, 'a', 'completed', { inserted: 3 }), job(2, 'b', 'completed', { inserted: 0, skipped_reason: 'malformed_output' }), job(3, 'c', 'completed', { inserted: 0, skipped_reason: 'truncated_output' })];
    const counts = parseFailureCounts(jobs, [{ source_type: 'facts:absorb', source_ref: 'c', summary: 'truncated_output: cut at limit' }]);
    expect(counts.parse_failures).toBe(2);
    expect(counts.parse_failures_logged).toBe(1);
    expect(counts.unhandled_parse_failures).toBe(1);
  });

  test('natural-prose harm check', () => {
    const page = (p: string, full: number, failed = 0): NaturalPage => ({ page: p, items: 10, full, partial: 0, judge_failed: failed, facts: 5, verdicts: [] });
    const base = ['a', 'b', 'c', 'd'].map(p => page(p, 8));
    expect(pairedNatural(base, base.map((p, i) => page(p.page, i < 2 ? 7 : 8))).pass).toBe(true);
    expect(pairedNatural(base, base.map(p => page(p.page, 5))).pass).toBe(false);
    expect(pairedNatural(base, base.map(p => page(p.page, 8, 2))).pass).toBe(false);
  });
});
