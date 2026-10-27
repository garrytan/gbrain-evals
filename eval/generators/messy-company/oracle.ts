/**
 * Oracle for messy-company-v1: derives gold answers from the frozen world
 * plan (`world.ts`) without reading any page text.
 *
 * - Ownership on a date ([start, end) stints; overlap stints count as owned).
 * - The governing record for (account, attribute, as-of date).
 * - Annual contract value on a date (seats x price x (1 - discount)).
 * - Owner-phrase resolution: which account(s) a phrase such as
 *   "Dana's freight account" refers to on a date, or why it refers to none.
 */
import { ACCOUNTS, RECORDS, STINTS, TEAMS, accountById, personById, type Attr, type RecordDoc, type Stint } from './world.ts';

export const addDays = (d: string, n: number): string => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
export const daysBetween = (a: string, b: string): number => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

export type View = 'full' | 'public';

/** Stints as seen with full access, or with private-only evidence removed (an end stated only privately becomes open). */
export function stintsFor(view: View): Stint[] {
  if (view === 'full') return STINTS;
  const privateStarts = STINTS.filter(s => s.evidence_visibility === 'private_only');
  return STINTS.filter(s => s.evidence_visibility === 'public').map(s => {
    const hiddenSuccessor = privateStarts.find(p => p.account === s.account && p.start === s.end && s.role === 'primary');
    return hiddenSuccessor ? { ...s, end: null } : s;
  });
}

export function inStint(s: Stint, date: string): boolean {
  return (s.start === null || s.start <= date) && (s.end === null || date < s.end);
}

export function ownedOn(owner: string, date: string, view: View = 'full', roles: Stint['role'][] = ['primary', 'team', 'overlap']): Stint[] {
  return stintsFor(view).filter(s => s.owner === owner && roles.includes(s.role) && inStint(s, date));
}

export function everOwned(owner: string, view: View = 'full', roles: Stint['role'][] = ['primary', 'team']): Stint[] {
  return stintsFor(view).filter(s => s.owner === owner && roles.includes(s.role));
}

export function ownersOn(account: string, date: string, view: View = 'full'): Stint[] {
  return stintsFor(view).filter(s => s.account === account && inStint(s, date));
}

export interface Governing { record: RecordDoc; value: string | number }

/** Signed records with effective <= asOf that set attr for the account; latest effective wins, then latest signed. */
export function governing(account: string, attr: Attr, asOf: string): Governing | null {
  let best: Governing | null = null;
  for (const r of RECORDS) {
    if (r.status !== 'signed' || !r.effective || r.effective > asOf) continue;
    const set = r.sets.find(s => s.attr === attr && s.scope.includes(account));
    if (!set) continue;
    if (!best || r.effective > best.record.effective! || (r.effective === best.record.effective && (r.signed ?? '') > (best.record.signed ?? ''))) best = { record: r, value: set.value };
  }
  return best;
}

export function acv(account: string, date: string): number {
  const seats = governing(account, 'seats', date)?.value;
  const price = governing(account, 'price_per_seat', date)?.value;
  const disc = governing(account, 'discount_pct', date)?.value ?? 0;
  if (typeof seats !== 'number' || typeof price !== 'number') return 0;
  return Math.round(seats * price * (1 - Number(disc) / 100));
}

// ─── Owner-phrase resolution ────────────────────────────────────────

export type OwnerForm =
  | { form: 'poss_desc'; desc: string; noun?: string }
  | { form: 'runs'; verb?: string }
  | { form: 'renewal' }
  | { form: 'biggest'; pronoun?: boolean; noun?: string }
  | { form: 'region_inherited'; region: string; word?: string }
  | { form: 'region'; region: string; word?: string }
  | { form: 'former'; desc: string }
  | { form: 'former_runs' }
  | { form: 'team'; desc: string; short?: boolean }
  | { form: 'acting'; desc?: string }
  | { form: 'took_over'; desc?: string; when?: string }
  | { form: 'new_account' }
  | { form: 'initials'; desc: string };

export type Reason =
  | 'unique_owned_match' | 'ambiguous_two_owned' | 'no_owned_match' | 'undated_unique' | 'undated_ambiguous'
  | 'former_owner_cued' | 'team_owner' | 'acting_cover' | 'largest_by_acv' | 'renewal_window' | 'inherited_region'
  | 'nonowner_object' | 'contact_login' | 'contact_employer' | 'vendor_relationship' | 'narrative_account' | 'no_acv_yet';

export interface Resolution { accounts: string[]; reason: Reason; stints: string[] }

const descMatch = (accountId: string, desc: string) => accountById(accountId).descriptors.some(d => d.toLowerCase() === desc.toLowerCase());
const uniq = <T>(xs: T[]) => [...new Set(xs)];

function decide(stints: Stint[], dated: boolean, okReason: Reason): Resolution {
  const accounts = uniq(stints.map(s => s.account));
  const ids = stints.map(s => s.id);
  if (accounts.length === 1) return { accounts, reason: dated ? okReason : 'undated_unique', stints: ids };
  if (accounts.length === 0) return { accounts: [], reason: 'no_owned_match', stints: [] };
  return { accounts: [], reason: dated ? 'ambiguous_two_owned' : 'undated_ambiguous', stints: ids };
}

/** Resolve a person-anchored account phrase on a date (null = undated page). */
export function resolveOwner(owner: string, f: OwnerForm, date: string | null, view: View = 'full'): Resolution {
  const dated = date !== null;
  const owned = (roles: Stint['role'][] = ['primary', 'team', 'overlap']) => (dated ? ownedOn(owner, date!, view, roles) : everOwned(owner, view, roles.filter(r => r !== 'overlap')));
  switch (f.form) {
    case 'poss_desc':
    case 'initials':
      return decide(owned().filter(s => descMatch(s.account, f.desc)), dated, 'unique_owned_match');
    case 'runs':
      return decide(owned(), dated, 'unique_owned_match');
    case 'team':
      return decide(owned(['team']).filter(s => descMatch(s.account, f.desc)), dated, 'team_owner');
    case 'acting': {
      const st = dated ? ownedOn(owner, date!, view, ['acting']) : everOwned(owner, view, ['acting']);
      const filtered = f.desc ? st.filter(s => descMatch(s.account, f.desc!)) : st;
      if (!f.desc) return filtered.length ? { accounts: uniq(filtered.map(s => s.account)), reason: 'acting_cover', stints: filtered.map(s => s.id) } : { accounts: [], reason: 'no_owned_match', stints: [] };
      return decide(filtered, dated, 'acting_cover');
    }
    case 'region_inherited': {
      const st = owned(['primary']).filter(s => accountById(s.account).region === f.region && stintsFor(view).some(p => p.account === s.account && p.role === 'primary' && p.end === s.start && p.owner !== owner));
      return decide(st, dated, 'inherited_region');
    }
    case 'region':
      return decide(owned().filter(s => accountById(s.account).region === f.region), dated, 'unique_owned_match');
    case 'former':
    case 'former_runs': {
      const all = stintsFor(view).filter(s => s.owner === owner && s.role === 'primary' && s.end !== null && (!dated || s.end <= date!));
      const st = f.form === 'former' ? all.filter(s => descMatch(s.account, f.desc)) : all;
      const r = decide(st, true, 'former_owner_cued');
      return r;
    }
    case 'took_over': {
      if (!dated) return { accounts: [], reason: 'undated_ambiguous', stints: [] };
      let st = owned(['primary']).filter(s => s.start !== null && stintsFor(view).some(p => p.account === s.account && p.role === 'primary' && p.end === s.start && p.owner !== owner));
      if (f.desc) st = st.filter(s => descMatch(s.account, f.desc!));
      if (f.when) st = st.filter(s => s.start!.startsWith(f.when!));
      return decide(st, dated, 'unique_owned_match');
    }
    case 'new_account': {
      if (!dated) return { accounts: [], reason: 'undated_ambiguous', stints: [] };
      const st = owned(['primary']).filter(s => s.start !== null && daysBetween(s.start, date!) <= 90);
      return decide(st, dated, 'unique_owned_match');
    }
    case 'renewal': {
      if (!dated) return { accounts: [], reason: 'undated_ambiguous', stints: [] };
      const st = owned(['primary', 'team']).filter(s => {
        const rd = governing(s.account, 'renewal_date', date!)?.value;
        return typeof rd === 'string' && rd >= date! && daysBetween(date!, rd) <= 60;
      });
      return decide(st, dated, 'renewal_window');
    }
    case 'biggest': {
      if (!dated) {
        const ever = everOwned(owner, view, ['primary']);
        return ever.length === 1 ? { accounts: [ever[0].account], reason: 'undated_unique', stints: [ever[0].id] } : { accounts: [], reason: 'undated_ambiguous', stints: ever.map(s => s.id) };
      }
      const st = owned(['primary', 'overlap']);
      const scored = uniq(st.map(s => s.account)).map(a => ({ a, v: acv(a, date!) })).sort((x, y) => y.v - x.v);
      if (scored.length === 0) return { accounts: [], reason: 'no_owned_match', stints: [] };
      if (scored[0].v === 0) return { accounts: [], reason: 'no_acv_yet', stints: [] };
      if (scored.length > 1 && scored[1].v === scored[0].v) return { accounts: [], reason: 'ambiguous_two_owned', stints: st.map(s => s.id) };
      return { accounts: [scored[0].a], reason: 'largest_by_acv', stints: st.filter(s => s.account === scored[0].a).map(s => s.id) };
    }
  }
}

/** How the page date sits against the stint that supports a link. */
export function windowRelation(stintIds: string[], date: string | null): string {
  if (date === null) return 'undated';
  const s = STINTS.find(x => x.id === stintIds[0]);
  if (!s) return 'none';
  if (s.role === 'overlap') return 'belated_overlap';
  if (s.role === 'acting') return 'acting_window';
  if (s.end !== null && date >= s.end) return 'after_window';
  if (s.start === date) return 'start_day';
  if (s.end !== null && addDays(s.end, -1) === date) return 'last_day';
  if (s.start === null) return 'inside_unknown_start';
  return s.end === null ? 'inside_open_ended' : 'inside';
}

/** Render the surface text for an owner form. */
export function surfaceFor(owner: string, f: OwnerForm): string {
  const team = TEAMS.find(t => t.id === owner);
  const p = team ? null : personById(owner);
  const first = p?.first ?? '';
  const poss = `${first}'s`;
  const pron = p?.pronoun === 'she' ? 'her' : p?.pronoun === 'he' ? 'his' : 'its';
  switch (f.form) {
    case 'poss_desc': return `${poss} ${f.desc} ${f.noun ?? 'account'}`;
    case 'initials': return `${p!.initials}'s ${f.desc} acct`;
    case 'runs': return `the account ${first} ${f.verb ?? 'runs'}`;
    case 'renewal': return `${poss} renewal`;
    case 'biggest': return f.pronoun ? `${pron} biggest ${f.noun ?? 'customer'}` : `${poss} biggest ${f.noun ?? 'account'}`;
    case 'region_inherited': return `the ${f.word ?? f.region} one ${first} inherited`;
    case 'region': return `${poss} ${f.word ?? f.region} account`;
    case 'former': return `${poss} old ${f.desc} account`;
    case 'former_runs': return `the account ${first} used to run`;
    case 'team': return f.short ? `the team's ${f.desc} account` : `the ${team!.short} ${team!.id === 'team-strategic' ? 'pod' : 'team'}'s ${f.desc} account`;
    case 'acting': return f.desc ? `the ${f.desc} account ${first} is covering` : `the accounts ${first} is covering`;
    case 'took_over': return f.desc ? `the ${f.desc} account ${first} took over` : `the account ${first} took over${f.when ? ` in ${monthName(f.when)}` : ''}`;
    case 'new_account': return `${poss} new account`;
  }
}

function monthName(ym: string): string {
  return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(ym.slice(5, 7)) - 1];
}

export const accountIds = ACCOUNTS.map(a => a.id);
