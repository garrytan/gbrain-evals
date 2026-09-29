/**
 * Input allowlist for everything the evaluator sends to a system under test,
 * a reader model or any other component whose output is being scored
 * (plan amendment 6).
 *
 * A leak check that searches for one known substring (such as the
 * LongMemEval `answer_` prefix) only catches the leak someone already found.
 * This checker works the other way round. Each boundary declares the exact
 * fields a payload may carry and the shape of each. The checker rejects:
 *   - any field that is not declared, at any depth;
 *   - a declared field with the wrong type or pattern;
 *   - anything that is not plain JSON data (class instances such as a gold
 *     store, Maps, functions, getters, symbols, prototypes other than
 *     Object.prototype), because such a value can carry a hidden route back
 *     to evaluator state;
 *   - any evaluator-only value, such as a raw dataset session id supplied by
 *     the gold store, appearing more often than the source material the
 *     recipient is meant to see accounts for. A conversation may mention a
 *     word that happens to equal a session id; the rendered slug, title or
 *     frontmatter may not.
 */

export type FieldRule =
  | { type: 'string'; pattern?: RegExp; optional?: boolean }
  | { type: 'number'; optional?: boolean }
  | { type: 'boolean'; optional?: boolean }
  | { type: 'array'; items: FieldRule; optional?: boolean }
  | { type: 'object'; fields: Record<string, FieldRule>; optional?: boolean };

export interface Boundary {
  /** Stable name recorded in receipts, for example `longmemeval.sut.page@1`. */
  name: string;
  recipient: 'system-under-test' | 'reader';
  schema: FieldRule;
}

export interface ForbiddenValue {
  value: string;
  label: string;
  /** Occurrences that legitimately come from source material in this payload (see withPermitted). Default 0. */
  permitted?: number;
}

export class InputAllowlistError extends Error {
  constructor(readonly boundary: string, readonly violations: string[]) {
    super(`input_allowlist_violation: ${boundary}: ${violations.slice(0, 5).join('; ')}${violations.length > 5 ? ` (+${violations.length - 5} more)` : ''}`);
  }
}

/** Values shorter than this would match ordinary text by chance; the evaluator must pick meaningful secrets. */
export const MIN_FORBIDDEN_LENGTH = 6;

/** Non-overlapping, case-insensitive occurrences of needle in haystack. */
export function countOccurrences(haystack: string, needle: string): number {
  return countLowered(haystack.toLowerCase(), needle.toLowerCase());
}

function countLowered(h: string, n: string): number {
  let count = 0;
  for (let at = h.indexOf(n); at >= 0; at = h.indexOf(n, at + n.length)) count++;
  return count;
}

/** Credit each forbidden value with its occurrences in the source text the recipient is meant to see. */
export function withPermitted(values: readonly ForbiddenValue[], sourceTexts: readonly string[]): ForbiddenValue[] {
  const lowered = sourceTexts.map(t => t.toLowerCase());
  return values.map(v => ({ ...v, permitted: lowered.reduce((sum, t) => sum + countLowered(t, v.value.toLowerCase()), 0) }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function checkPayload(boundary: Boundary, payload: unknown, forbidden: readonly ForbiddenValue[] = []): string[] {
  const needles = forbidden.map(f => {
    if (typeof f.value !== 'string' || f.value.length < MIN_FORBIDDEN_LENGTH) throw new Error(`forbidden value for ${boundary.name} is shorter than ${MIN_FORBIDDEN_LENGTH} characters (${f.label})`);
    return { needle: f.value.toLowerCase(), label: f.label, permitted: f.permitted ?? 0, seen: 0, paths: [] as string[] };
  });
  const violations: string[] = [];
  const visit = (value: unknown, rule: FieldRule, path: string) => {
    if (value === undefined) {
      if (!rule.optional) violations.push(`${path}: required field missing`);
      return;
    }
    switch (rule.type) {
      case 'string': {
        if (typeof value !== 'string') { violations.push(`${path}: expected string`); return; }
        if (rule.pattern && !rule.pattern.test(value)) violations.push(`${path}: does not match ${rule.pattern}`);
        const lower = needles.length ? value.toLowerCase() : '';
        for (const n of needles) {
          const count = countLowered(lower, n.needle);
          if (count) { n.seen += count; n.paths.push(path); }
        }
        return;
      }
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`${path}: expected finite number`);
        return;
      case 'boolean':
        if (typeof value !== 'boolean') violations.push(`${path}: expected boolean`);
        return;
      case 'array': {
        if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) { violations.push(`${path}: expected plain array`); return; }
        const extra = Reflect.ownKeys(value).filter(k => k !== 'length' && !(typeof k === 'string' && /^(0|[1-9]\d*)$/.test(k)));
        if (extra.length) violations.push(`${path}: array carries extra properties ${extra.map(String).join(', ')}`);
        for (let i = 0; i < value.length; i++) {
          const d = Object.getOwnPropertyDescriptor(value, i);
          if (!d) { violations.push(`${path}[${i}]: sparse array slot`); continue; }
          if (d.get || d.set) { violations.push(`${path}[${i}]: accessor property`); continue; }
          visit(d.value, rule.items, `${path}[${i}]`);
        }
        return;
      }
      case 'object': {
        if (!isPlainObject(value)) { violations.push(`${path}: expected plain object, got ${value === null ? 'null' : (value as object).constructor?.name ?? typeof value}`); return; }
        for (const key of Reflect.ownKeys(value)) {
          if (typeof key === 'symbol') { violations.push(`${path}: symbol-keyed property`); continue; }
          if (!Object.prototype.hasOwnProperty.call(rule.fields, key)) { violations.push(`${path}.${key}: field not allowlisted`); continue; }
        }
        for (const [key, child] of Object.entries(rule.fields)) {
          const d = Object.getOwnPropertyDescriptor(value, key);
          if (d && (d.get || d.set)) { violations.push(`${path}.${key}: accessor property`); continue; }
          visit(d?.value, child, `${path}.${key}`);
        }
        return;
      }
    }
  };
  visit(payload, boundary.schema, '$');
  for (const n of needles) {
    if (n.seen > n.permitted) violations.push(`${n.paths.join(', ')}: contains evaluator-only value (${n.label}) ${n.seen} time(s), source material accounts for ${n.permitted}`);
  }
  return violations;
}

export function assertPayload(boundary: Boundary, payload: unknown, forbidden: readonly ForbiddenValue[] = []): void {
  const violations = checkPayload(boundary, payload, forbidden);
  if (violations.length) throw new InputAllowlistError(boundary.name, violations);
}
