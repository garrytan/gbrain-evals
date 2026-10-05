/**
 * Cat 40 Hard: a free difficulty proxy for the reference forms (amendment A1).
 * No model is called; it builds the ledger and reads the rendered documents.
 *
 * Per family, over the oracle documents of every task:
 *   name verbatim   share of the task's event records (oracle documents that refer to an account) whose text
 *                   contains the name the task asks about, case-sensitive, averaged over tasks
 *   one name grep   share of the same event records that one case-insensitive grep for that name returns
 *                   (over the file an fs agent reads, front matter included), averaged over tasks
 *   then code       the same, for a grep of the name and a second grep of the account's codes (which the CRM
 *                   record next to the name gives): what the round-2 search strategy reaches
 *   then nickname   adding a third grep for the nickname (from the account sheet); the records left use the
 *                   manager form, which no fixed string finds
 * The asked name is the account string in the question or the H5 session messages (H3: the ambiguous first word
 * or code prefix); H1 questions name no account, so each member or near miss is asked by its canonical name, one
 * grep per account.
 *
 *   bun eval/runner/cat40/hard-proxy.ts --knobs <knobs.json> [--knobs <knobs.json> ...] [--seed N] [--scale large]
 */
import { renderDoc } from '../../generators/model-ladder-gen.ts';
import { HARD_FAMILIES, HARD_SEEDS, REF_FORMS, type HardFamily } from '../../generators/hard/schema.ts';
import { aliasesOf, buildHardLedger, loadKnobs, type HardAccount, type HardBuild } from '../../generators/model-ladder-hard.ts';

export interface ProxyRow { family: HardFamily; tasks: number; records: number; names_it: number; one_grep: number; name_or_code: number; with_nickname: number }
export interface ProxyReport { rows: ProxyRow[]; forms: Record<string, number>; oracle_forms: Record<string, number> }

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function referenceProxy(b: HardBuild): ProxyReport {
  const all = [...b.accounts, ...b.appended];
  const byId = new Map(all.map(a => [a.id, a]));
  const entityOf = (a: HardAccount) => byId.get(a.mergedInto ?? a.id)!;
  const docs = new Map(b.docs.map(d => {
    const title = typeof d.title === 'function' ? d.title() : d.title, body = typeof d.body === 'function' ? d.body() : d.body;
    return [d.id, { text: `${title}\n${body}`, file: renderDoc({ ...d, title, body } as Parameters<typeof renderDoc>[0]).toLowerCase(), refs: (d.refs ?? []).map(I => entityOf(I.account)), forms: (d.refs ?? []).map(I => I.resolved?.form ?? 'v1') }];
  }));
  const forms: Record<string, number> = {}, oracleForms: Record<string, number> = {};
  for (const d of docs.values()) for (const f of d.forms) forms[f] = (forms[f] ?? 0) + 1;
  const codes = (e: HardAccount) => [e.code, ...(e.former ? [e.former.code] : []), ...e.mergedIn.map(m => m.code)];
  const nicknames = (e: HardAccount) => [e.nickname, ...e.mergedIn.map(m => m.nickname)].filter((n): n is string => !!n);
  const rows = HARD_FAMILIES.map(family => {
    const tasks = b.tasks.filter(t => t.family === family);
    const shares: Record<'names_it' | 'one_grep' | 'name_or_code' | 'with_nickname', number[]> = { names_it: [], one_grep: [], name_or_code: [], with_nickname: [] };
    let records = 0;
    for (const t of tasks) {
      const said = [t.question, ...(t.sessions ?? [])].join('\n');
      const h3 = /the (\S+) account whose|code starts with (\S+) and/.exec(t.question);
      const asked = (e: HardAccount) => (h3 ? h3[1] ?? h3[2] : [e.name, ...aliasesOf(e)].filter(n => said.includes(n)).sort((x, y) => y.length - x.length)[0] ?? e.name);
      const evidence = t.relevant.map(id => docs.get(id)!).filter(d => d.refs.length);
      if (!evidence.length) continue;
      records += evidence.length;
      for (const d of evidence) for (const f of d.forms) oracleForms[f] = (oracleForms[f] ?? 0) + 1;
      const greps = [...new Set(evidence.flatMap(d => d.refs.map(asked)))].map(s => s.toLowerCase());
      const reach = (extra: (e: HardAccount) => string[]) => evidence.filter(d => greps.some(g => d.file.includes(g)) || d.refs.some(e => extra(e).some(x => d.file.includes(x.toLowerCase())))).length / evidence.length;
      shares.names_it.push(evidence.filter(d => d.refs.some(e => d.text.includes(asked(e)))).length / evidence.length);
      shares.one_grep.push(reach(() => []));
      shares.name_or_code.push(reach(codes));
      shares.with_nickname.push(reach(e => [...codes(e), ...nicknames(e)]));
    }
    return { family, tasks: tasks.length, records, names_it: mean(shares.names_it), one_grep: mean(shares.one_grep), name_or_code: mean(shares.name_or_code), with_nickname: mean(shares.with_nickname) };
  });
  return { rows, forms, oracle_forms: oracleForms };
}

export function proxyMarkdown(label: string, r: ProxyReport): string {
  const pc = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a');
  const total = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  const share = (o: Record<string, number>) => [...REF_FORMS, 'v1'].filter(f => o[f]).map(f => `${f} ${pc(o[f] / total(o))}`).join(', ');
  return [
    `### ${label}`, '',
    '| Family | tasks | event records in oracle docs | name verbatim | one name grep | name, then code grep | name, code, then nickname grep |',
    '|---|---|---|---|---|---|---|',
    ...r.rows.map(x => `| ${x.family} | ${x.tasks} | ${x.records} | ${pc(x.names_it)} | ${pc(x.one_grep)} | ${pc(x.name_or_code)} | ${pc(x.with_nickname)} |`),
    `| all | ${r.rows.reduce((a, x) => a + x.tasks, 0)} | ${r.rows.reduce((a, x) => a + x.records, 0)} | ${(['names_it', 'one_grep', 'name_or_code', 'with_nickname'] as const).map(k => pc(mean(r.rows.map(x => x[k])))).join(' | ')} |`, '',
    `Reference forms over every event record: ${share(r.forms)}. In oracle documents: ${share(r.oracle_forms)}.`, '',
  ].join('\n');
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const all = (n: string) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));
  const seed = Number(all('--seed')[0] ?? HARD_SEEDS.calibration);
  const scale = (all('--scale')[0] ?? 'v1') as 'v1' | 'large';
  if (!all('--knobs').length || !Number.isSafeInteger(seed) || (scale !== 'v1' && scale !== 'large')) {
    console.error('usage: bun eval/runner/cat40/hard-proxy.ts --knobs <knobs.json> [--knobs <knobs.json> ...] [--seed N] [--scale large]');
    process.exit(2);
  }
  for (const path of all('--knobs')) console.log(proxyMarkdown(`${path}, seed ${seed}, ${scale === 'large' ? '50k' : '4k'}`, referenceProxy(buildHardLedger(seed, loadKnobs(path), { scale }))));
}
