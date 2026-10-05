/**
 * A small JSON Schema checker for eval/schemas/workload-suite.schema.json:
 * type, enum, const, required, properties, additionalProperties, items,
 * oneOf and local $ref. Enough to hold every emitted record to its schema
 * without adding a dependency.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Schema = Record<string, unknown>;

export const WORKLOAD_SCHEMA_PATH = join(import.meta.dir, '../schemas/workload-suite.schema.json');
let cached: Schema | null = null;
export function workloadSchema(): Schema {
  cached ??= JSON.parse(readFileSync(WORKLOAD_SCHEMA_PATH, 'utf8')) as Schema;
  return cached;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function check(root: Schema, schema: Schema, value: unknown, path: string, errors: string[]): void {
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/$defs/', '');
    const target = (root.$defs as Record<string, Schema>)[name];
    if (!target) { errors.push(`${path}: unknown $ref ${schema.$ref}`); return; }
    check(root, target, value, path, errors);
    return;
  }
  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as Schema[]).filter(s => { const e: string[] = []; check(root, s, value, path, e); return e.length === 0; }).length;
    if (passing !== 1) errors.push(`${path}: matches ${passing} of oneOf`);
    return;
  }
  if ('const' in schema && value !== schema.const) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
    const t = typeOf(value);
    if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) { errors.push(`${path}: expected ${types.join('|')}, got ${t}`); return; }
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) if (!(key in obj)) errors.push(`${path}: missing ${key}`);
    const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [key, v] of Object.entries(obj)) {
      if (key in props) check(root, props[key]!, v, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected ${key}`);
      else if (typeof schema.additionalProperties === 'object') check(root, schema.additionalProperties as Schema, v, `${path}.${key}`, errors);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => check(root, schema.items as Schema, v, `${path}[${i}]`, errors));
}

/** Errors for `value` against the root schema (`def` omitted) or one of its $defs. */
export function schemaErrors(value: unknown, def?: string): string[] {
  const root = workloadSchema();
  const errors: string[] = [];
  check(root, def ? { $ref: `#/$defs/${def}` } : root, value, def ?? 'manifest', errors);
  return errors;
}
