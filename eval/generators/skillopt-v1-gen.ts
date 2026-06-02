/**
 * Deterministic generator for the skillopt-v1 fixture corpus (SkillOpt cats 30-33).
 *
 * Emits, per deficient seed skill: SKILL.md (the flawed seed), benchmark.jsonl
 * (15 tasks → split 1:1:1 gives train5/sel5/test5, satisfying D_sel>=5), and
 * held-out.jsonl (6 tasks with DISJOINT task_ids — the independent gate the
 * optimizer is NOT trained against). Each seed has exactly ONE fixable flaw the
 * optimizer should discover. Rule judges are deterministic + free (no LLM judge
 * cost); only the target rollouts + optimizer reflects cost money.
 *
 * Placeholder-only content (CLAUDE.md privacy): generic business scenarios, no
 * real people/companies. Deterministic (no randomness) so re-running is stable.
 *
 * Run: bun eval/generators/skillopt-v1-gen.ts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(process.cwd(), 'eval/data/skillopt-v1');

type Check = { op: string; arg: string | number };
interface Seed {
  name: string;
  skill: string;
  checks: Check[];
  benchTopics: string[];
  heldTopics: string[];
}

const DECISION_TOPICS = [
  'whether a seed-stage dev-tools startup should ship a free tier',
  'if a two-person team should adopt Kubernetes now or wait',
  'whether to open-source a core library or keep it proprietary',
  'if a B2B SaaS should move from usage-based to seat-based pricing',
  'whether a fintech should build payments in-house or use a provider',
  'if an AI startup should fine-tune or rely on prompting',
  'whether to hire a first salesperson before or after product-market fit',
  'if a marketplace should subsidize supply or demand first',
  'whether a hardware startup should manufacture domestically',
  'if a content site should gate articles behind a paywall',
  'whether to raise a bridge round or cut burn',
  'if a mobile app should launch single-platform or cross-platform',
  'whether to acquire a small competitor or build the feature',
  'if a data startup should sell to engineers or to executives',
  'whether to run a paid pilot or a free design partnership',
];
const HELD_TOPICS = [
  'whether a solo founder should take on a technical cofounder',
  'if a startup should relocate to be near its customers',
  'whether to deprecate a legacy API with active users',
  'if a team should switch from REST to GraphQL',
  'whether to build an internal tool or buy SaaS',
  'if a startup should enter a regulated market',
];

function frontmatter(name: string, trigger: string, body: string): string {
  return `---\nname: ${name}\nversion: 0.1.0\ndescription: ${body.split('\n')[0]?.replace(/^#\s*/, '') ?? name}\ntriggers:\n  - "${trigger}"\nbrain_first: exempt\n---\n\n${body}\n`;
}

// Judges are deliberately ROBUST so the eval measures the STRUCTURE the optimizer
// is supposed to add, not an exact-string lottery: `section_present` matches a
// heading at any depth/case; `regex` checks tolerate case + ':'/'='. Exact
// `contains` zeroed out correct fixes that wrote "## Key risks" (lowercase r),
// which made the median-of-3 land at 0 and the validation gate reject real gains.
// Every seed starts genuinely DEFICIENT (baseline ~0) so there is headroom for
// the optimizer to demonstrably improve it.
const SEEDS: Seed[] = [
  {
    // FLAW: never asks for a ## Key Risks section or a Confidence line.
    name: 'seed-missing-structure',
    skill: frontmatter('brief-writer-example', 'write a brief',
      `# Brief Writer\n\nWhen asked, write a short, clear research brief that answers the question.\nKeep it focused and readable. Lead with the answer.`),
    checks: [{ op: 'section_present', arg: 'Key Risks' }, { op: 'regex', arg: '[Cc]onfidence\\s*[:=]' }],
    benchTopics: DECISION_TOPICS,
    heldTopics: HELD_TOPICS,
  },
  {
    // FLAW: actively encourages length; never bounds it.
    name: 'seed-verbose',
    skill: frontmatter('thorough-analyst-example', 'analyze the decision',
      `# Thorough Analyst\n\nWhen asked, analyze the decision as thoroughly and completely as you can.\nExplore every angle, consider many scenarios, and be exhaustive and detailed. Write multiple paragraphs.`),
    checks: [{ op: 'max_chars', arg: 1200 }],
    benchTopics: DECISION_TOPICS,
    heldTopics: HELD_TOPICS,
  },
  {
    // FLAW: explicitly answers from model memory and avoids tools, so the
    // baseline never calls search (headroom to learn brain-first). Earlier seed
    // wording let the model search anyway → baseline 1.0, nothing to improve.
    name: 'seed-no-brain-first',
    skill: frontmatter('quick-answerer-example', 'answer the question',
      `# Quick Answerer\n\nAnswer immediately from your own knowledge. Do NOT look anything up, search, or use any tools — just reply directly and concisely from memory.`),
    checks: [{ op: 'tool_called', arg: 'search' }],
    benchTopics: DECISION_TOPICS,
    heldTopics: HELD_TOPICS,
  },
  {
    // FLAW: never asks for a decision verdict line; rambles without committing.
    name: 'seed-no-verdict',
    skill: frontmatter('advisor-example', 'advise on the decision',
      `# Advisor\n\nWhen asked, discuss the considerations around the decision so the\nreader can make up their own mind.`),
    checks: [{ op: 'regex', arg: '[Rr]ecommendation\\s*[:=]' }, { op: 'regex', arg: '[Cc]onfidence\\s*[:=]' }],
    benchTopics: DECISION_TOPICS,
    heldTopics: HELD_TOPICS,
  },
];

const VERB: Record<string, string> = {
  'seed-missing-structure': 'Write a brief on',
  'seed-verbose': 'Analyze the decision of',
  'seed-no-brain-first': 'Answer: should we decide',
  'seed-no-verdict': 'Advise on',
};

function jsonl(prefix: string, topics: string[], verb: string, checks: Check[]): string {
  return topics.map((t, i) => JSON.stringify({
    task_id: `${prefix}-${String(i + 1).padStart(3, '0')}`,
    task: `${verb} ${t}.`,
    judge: { kind: 'rule', checks },
  })).join('\n') + '\n';
}

let total = 0;
for (const seed of SEEDS) {
  const dir = join(ROOT, seed.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), seed.skill, 'utf8');
  const verb = VERB[seed.name]!;
  writeFileSync(join(dir, 'benchmark.jsonl'), jsonl('bm', seed.benchTopics, verb, seed.checks), 'utf8');
  writeFileSync(join(dir, 'held-out.jsonl'), jsonl('hd', seed.heldTopics, verb, seed.checks), 'utf8');
  process.stderr.write(`[skillopt-v1-gen] ${seed.name}: 15 bench + 6 held-out, judge=${JSON.stringify(seed.checks)}\n`);
  total += 1;
}
process.stderr.write(`[skillopt-v1-gen] wrote ${total} seed fixtures under ${ROOT}\n`);
