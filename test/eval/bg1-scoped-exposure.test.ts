import { describe, expect, test } from 'bun:test';
import { exposure } from '../../eval/runner/bg1/exposure.ts';
import { rescore, scopedExposure, scopedGold, scopedSentence, slotEntity, worldQuestions } from '../../eval/runner/bg1/scoped-exposure.ts';

const NONE_FORMS = ['none', 'no one', 'nothing', 'called off', 'cancelled', 'canceled', 'not happening', 'no longer'];
const q = (stratum: string, gold: string[], stale: string[] = [], ordered = false) => ({ id: `t:${stratum}`, bg1: { stratum, family: 'primary', form: 'exact', slot: 'x-01.y', gold_values: gold, stale_values: stale, decoy_values: [], ...(ordered ? { ordered: true } : {}) } }) as any;
const withdrawn = (stale: string) => q('s5_withdrawn', NONE_FORMS, [stale]);

describe('scoped exposure', () => {
  test('a withdrawal phrased without a gold word counts, where exposure.ts misses it', () => {
    const text = 'It fell through: Corbel Systems walked away from the merger with Rookwood Design.';
    expect(scopedGold(withdrawn('Rookwood Design'), text, 'Corbel Systems')).toBe(true);
    expect(exposure(withdrawn('Rookwood Design'), text, { rawText: false }).gold).toBe(false);
    expect(scopedGold(withdrawn('Ghent'), 'Please ignore the report that Fenwick Labs is holding its team offsite in Ghent; it turned out to be false.', 'Fenwick Labs')).toBe(true);
    expect(scopedGold(withdrawn('Kinglet Telecom'), '- (4, fact) User clarified that Project Tamarind is not running a pilot with Kinglet Telecom, as that was only a rumor', 'Project Tamarind')).toBe(true);
  });
  test('another entity\'s withdrawal does not count, where exposure.ts counts it', () => {
    const text = 'Corbel Systems agreed to merge with Rookwood Design.\nVantor Biotech cancelled its team offsite in Rotterdam.';
    expect(scopedGold(withdrawn('Rookwood Design'), text, 'Corbel Systems')).toBe(false);
    expect(exposure(withdrawn('Rookwood Design'), text, { rawText: false }).gold).toBe(true);
  });
  test('a withdrawal of the same entity\'s other slot does not count', () => {
    expect(scopedGold(withdrawn('Ambergrove Partners'), 'Change of plans: Tidewell Energy cancelled its team offsite in Valencia.', 'Tidewell Energy')).toBe(false);
  });
  test('a possessive names the entity, and a Project entity is named without the word Project', () => {
    expect(scopedGold(withdrawn('Aarhus'), "Halcyon Freight's team offsite in Aarhus was only a rumour and is not happening.", 'Halcyon Freight')).toBe(true);
    expect(scopedGold(withdrawn('Quarryhill Materials'), 'User mentions the cancellation of the Tamarind pilot with Quarryhill Materials.', 'Project Tamarind')).toBe(true);
  });
  test('outside S5 a value counts only beside its entity; an ordered question needs every value', () => {
    expect(scopedGold(q('s1_updated', ['Leeds']), 'Nadia Brennan lives in Leeds.', 'Luca Novak')).toBe(false);
    expect(scopedSentence(q('s1_updated', ['Leeds']), 'Nadia Brennan lives in Leeds. Luca Novak lives in Leeds.', 'Luca Novak')).toBe('Luca Novak lives in Leeds.');
    const h = q('s8_history', ['Leeds', 'Kyoto', 'Tallinn'], [], true);
    expect(scopedGold(h, 'Luca Novak lives in Leeds.\nLuca Novak moved to Kyoto. Luca Novak relocated to Tallinn.', 'Luca Novak')).toBe(true);
    expect(scopedGold(h, 'Luca Novak lives in Leeds.\nLuca Novak moved to Kyoto. Someone relocated to Tallinn.', 'Luca Novak')).toBe(false);
    expect(scopedGold(h, 'Luca Novacek lives in Leeds. Luca Novacek moved to Kyoto and Tallinn.', 'Luca Novak')).toBe(false);
  });
  test('scopedExposure keeps exposure.ts\'s stale and deciding line and replaces only the gold check', () => {
    const text = 'Corbel Systems agreed to merge with Rookwood Design.\nVantor Biotech cancelled its team offsite in Rotterdam.';
    expect(scopedExposure(withdrawn('Rookwood Design'), text, { rawText: false, entity: 'Corbel Systems' })).toEqual({ ...exposure(withdrawn('Rookwood Design'), text, { rawText: false }), gold: false });
    expect(exposure(withdrawn('Rookwood Design'), text, { rawText: false }).stale).toBe(true);
  });
  test('entities come from the world plan', () => {
    expect(slotEntity({ entities: [{ id: 'company-05', name: 'Fenwick Labs' }] }, 'company-05.offsite')).toBe('Fenwick Labs');
    expect(() => slotEntity({ entities: [] }, 'company-05.offsite')).toThrow(/does not list/);
    const qs = worldQuestions('eval/data/changing-facts-v1/dev/worlds', ['bg1-dev-01', 'bg1-dev-02', 'bg1-dev-03']);
    expect(qs.size).toBe(192);
    expect(qs.get('bg1-dev-02:s5_withdrawn:6')!.entity).toBe('Fenwick Labs');
  });
  test('rescore counts both checks per stratum and lists where they disagree', () => {
    const qs = new Map([['w:s5_withdrawn:0', { ...withdrawn('Rookwood Design'), id: 'w:s5_withdrawn:0', entity: 'Corbel Systems' }], ['w:s1_updated:0', { ...q('s1_updated', ['Leeds']), id: 'w:s1_updated:0', entity: 'Luca Novak' }]]);
    const r = rescore([{ key: 'r|w:s5_withdrawn:0|p', prompt: 'Corbel Systems walked away from the merger with Rookwood Design.' }, { key: 'r|w:s1_updated:0|p', prompt: 'Luca Novak lives in Leeds.' }, { key: 'r|other:q|p', prompt: 'x' }], qs);
    expect(r.by_stratum).toEqual({ s5_withdrawn: { contexts: 1, literal: 0, scoped: 1 }, s1_updated: { contexts: 1, literal: 1, scoped: 1 } });
    expect(r.disagreements).toEqual([{ question: 'w:s5_withdrawn:0', literal: false, scoped: true, sentence: 'Corbel Systems walked away from the merger with Rookwood Design.' }]);
  });
});
