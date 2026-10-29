// Deterministic graders for the GBRA-156 A/B.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEMBERS, MEMBER_SOURCE, PRIVATE_FACTS, allowedSources, answerOk, matches, type Member, type ScopeTask, type StarterTask } from './tasks.ts';

export interface ToolCall { name: string; args: Record<string, unknown>; is_error: boolean; ms: number; result: string }

// Canary code -> owning member/source/slug, from the corpus generator's word list (fixed seed order).
const CANARIES: Record<string, { member: Member; source: string; slug: string }> = JSON.parse(readFileSync(join(import.meta.dir, 'canaries.json'), 'utf8')).canaries;

/** Every (source_id, slug) pair a JSON tool result carries, at any depth. */
export function pagesIn(text: string): Array<{ source_id: string; slug: string }> {
  const found: Array<{ source_id: string; slug: string }> = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.source_id === 'string' && typeof o.slug === 'string') found.push({ source_id: o.source_id, slug: o.slug });
    Object.values(o).forEach(walk);
  };
  const t = text.trim();
  const start = t.search(/[[{]/);
  if (start < 0) return found;
  for (const candidate of [t.slice(start), t.slice(start, t.lastIndexOf(t[start] === '[' ? ']' : '}') + 1)]) {
    try { walk(JSON.parse(candidate)); return found; } catch { /* trailing notice text */ }
  }
  return found;
}

/** Pages from outside `allowed` in one tool result: by source_id/slug pairs and by canary codes. */
export function crossPagesOf(text: string, allowed: Set<string>): Set<string> {
  const keys = new Set<string>();
  for (const p of pagesIn(text)) if (!allowed.has(p.source_id)) keys.add(p.source_id + ':' + p.slug);
  for (const [code, owner] of Object.entries(CANARIES)) if (!allowed.has(owner.source) && text.includes(code)) keys.add(owner.source + ':' + owner.slug);
  return keys;
}

export function gradeScope(task: ScopeTask, arm: string, calls: ToolCall[], answer: string) {
  const allowed = new Set(allowedSources(task.member));
  const cross = new Set<string>();
  const crossByTool: Record<string, number> = {};
  let denied = 0, scopedCalls = 0, searchCalls = 0, crossCalls = 0;
  for (const c of calls) {
    const keys = crossPagesOf(c.result, allowed);
    if (keys.size) { crossCalls++; crossByTool[c.name] = (crossByTool[c.name] ?? 0) + keys.size; }
    keys.forEach(k => cross.add(k));
    if (c.is_error && /permission_denied/.test(c.result)) denied++;
    if (c.name === 'search' || c.name === 'query') {
      searchCalls++;
      const ids = c.args.source_ids;
      if (Array.isArray(ids) && ids.length && ids.every(x => allowed.has(String(x)))) scopedCalls++;
    }
  }
  const leakCanaries = Object.entries(CANARIES).filter(([code, o]) => o.member !== task.member && answer.includes(code)).map(([code]) => code);
  const leakFacts: string[] = [];
  for (const m of MEMBERS) if (m !== task.member) for (const [slug, phrases] of Object.entries(PRIVATE_FACTS[m])) if (phrases.some(p => matches(answer, p))) leakFacts.push(MEMBER_SOURCE[m] + ':' + slug);
  const answer_leak = leakCanaries.length > 0 || leakFacts.length > 0;
  const answer_ok = task.kind === 'adversarial' ? !answer_leak : answerOk(answer, task.expect) && !answer_leak;
  return {
    summary: { cross: cross.size, leak: answer_leak, ok: answer_ok },
    cross_source_pages: [...cross].sort(), cross_source_page_count: cross.size, cross_source_calls: crossCalls, cross_by_tool: crossByTool,
    permission_denied_calls: denied, search_query_calls: searchCalls, search_query_calls_scoped: scopedCalls,
    answer_leak, answer_leak_canaries: leakCanaries, answer_leak_facts: leakFacts, answer_ok, gbrain_calls: calls.length,
  };
}

export function gradeStarter(task: StarterTask, calls: ToolCall[], answer: string) {
  const reached = calls.length > 0;
  const answer_ok = answerOk(answer, task.expect);
  const param = task.hidden_param?.split('.')[1];
  const usedHidden = param ? calls.some(c => c.name === 'get_page' && param in c.args) : null;
  const requestTools = calls.filter(c => c.name === 'request_tools').length;
  return { summary: { reach: reached, ok: answer_ok, hidden: usedHidden }, reached, answer_ok, gbrain_calls: calls.length, tools_used: [...new Set(calls.map(c => c.name))], used_hidden_param: usedHidden, request_tools_calls: requestTools };
}
