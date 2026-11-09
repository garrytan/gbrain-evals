#!/usr/bin/env bun
/**
 * Paraphrases for conditions recall (GBEV-55 G2), written by claude-opus-5-5.
 *
 *   bun eval/runner/live-recall/paraphrase-opus.ts --dir <generated dir> --out <paraphrases.jsonl> \
 *     --paid --budget-run-id <id> [--budget-ledger <path>]
 *
 * For each question in a directory from eval/generators/conditions-recall-gen.ts
 * it shows Opus the exact form and the gold pages (all fictional) and asks for
 * the same request in other words, under live batch 2's rule: no
 * identifier-like token (identifierTokens in run.ts) shared with the exact
 * form. A reply that breaks the rule gets one retry; a second break leaves the
 * id out, and the generator then refuses the file by that id. Feed the output
 * back with conditions-recall-gen.ts --paraphrases <file>. A batch-3 directory
 * from eval/generators/batch3-synthetic-gen.ts works the same way and takes
 * the file back through batch3-synthetic-gen.ts --paraphrases <file>.
 *
 * It spends money, so requirePaidArm (paid-arm.ts) refuses it without --paid
 * and --budget-run-id naming an open budget-ledger run, before any client or
 * request exists. Every request goes through the ledger's paid-request guard
 * (startPaidRun), which reserves, sends and reconciles from response usage;
 * the receipt beside the output records the ledger's cost block.
 */
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fitAnthropicRequest, withThinkingRoom } from '../anthropic-request.ts';
import { budgetOptionsFrom, receiptCost, startPaidRun } from '../budget-ledger.ts';
import { PaidArmRefusal, requirePaidArm } from '../paid-arm.ts';
import { paraphraseRuleBreaks } from '../../generators/conditions-recall-gen.ts';
import { identifierTokens, parseQuestions } from './run.ts';
import { readSyntheticDir } from './synthetic.ts';

export const MODEL = 'claude-opus-5-5';
export const PROMPT_VERSION = 'conditions-recall-paraphrase/v1';
/** Rough planning estimate per question (about 2k input and 1.5k output tokens with thinking at Opus 5.5 prices); not a measurement. */
export const ESTIMATE_USD_PER_QUESTION = 0.04;

type Client = Pick<Anthropic, 'messages'>;

export function paraphrasePrompt(exact: string, pages: Array<{ slug: string; body: string }>, retry: boolean): string {
  const tokens = [...identifierTokens(exact)];
  return [
    'You are writing one search question for a retrieval benchmark built on invented notes.',
    'Someone wants the information in the page or pages below. Their exact-wording question is:',
    '<exact>' + exact + '</exact>',
    'Write the same request the way a person who remembers what it is about, but not its wording, would type it.',
    'Rules: ask for the same information; use no identifier, ticket number, error code, contract number or date' + (tokens.length ? ', and none of these tokens: ' + tokens.join(', ') : '') + '; avoid the pages\' distinctive wording; one sentence under 25 words.',
    ...(retry ? ['Your previous answer reused a token from the exact question. Use none of them.'] : []),
    'Reply with the question only.',
    ...pages.map(p => '<page slug="' + p.slug + '">\n' + p.body + '\n</page>'),
  ].join('\n');
}

async function paraphrase(client: Client, prompt: string): Promise<string> {
  const res = await client.messages.create(fitAnthropicRequest({ model: MODEL, max_tokens: withThinkingRoom(MODEL, 512), messages: [{ role: 'user', content: prompt }] }));
  const text = res.content.find((b): b is Anthropic.Messages.TextBlock => b.type === 'text')?.text ?? '';
  return text.trim().split('\n')[0].trim().replace(/^["']|["']$/g, '');
}

export async function main(argv: string[], deps: { makeClient?: () => Client } = {}): Promise<number> {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = flag('--dir'), out = flag('--out');
  if (!dir || !out) {
    console.error('usage: bun eval/runner/live-recall/paraphrase-opus.ts --dir <generated dir> --out <paraphrases.jsonl> --paid --budget-run-id <id>');
    return 2;
  }
  const { pages, questionsText, protocol } = readSyntheticDir(dir);
  const questions = parseQuestions(questionsText, protocol);
  const paid = (() => {
    try {
      const estimateUsd = questions.length * ESTIMATE_USD_PER_QUESTION;
      const { budgetRunId } = requirePaidArm(argv, { arm: 'conditions-recall paraphrases (' + MODEL + ')', estimateUsd });
      return startPaidRun('conditions-recall-paraphrases', { ...budgetOptionsFrom(argv), runId: budgetRunId, estimateUsd });
    } catch (error) {
      if (!(error instanceof PaidArmRefusal)) throw error;
      console.error('paraphrase-opus: REFUSED: ' + error.message);
      return null;
    }
  })();
  if (!paid) return 2;
  const bySlug = new Map(pages.map(p => [p.slug, p]));
  const rows: Array<{ id: string; paraphrase: string }> = [];
  const failed: string[] = [];
  let stoppedBy: string | null = null;
  try {
    const client = (deps.makeClient ?? (() => new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })))();
    for (const q of questions) {
      if (paid.guard.exhausted) break;
      const gold = q.gold.map(g => bySlug.get(g.slug)!);
      try {
        let text = await paraphrase(client, paraphrasePrompt(q.forms.exact, gold, false));
        if (!text || paraphraseRuleBreaks([{ id: q.id, forms: { exact: q.forms.exact, paraphrase: text } }]).length) text = await paraphrase(client, paraphrasePrompt(q.forms.exact, gold, true));
        if (!text || paraphraseRuleBreaks([{ id: q.id, forms: { exact: q.forms.exact, paraphrase: text } }]).length) failed.push(q.id);
        else rows.push({ id: q.id, paraphrase: text });
      } catch (error) {
        stoppedBy = q.id + ': ' + (error as Error).message;
        break;
      }
    }
  } finally {
    paid.guard.uninstall();
  }
  const body = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(out, body);
  const missing = questions.length - rows.length;
  writeFileSync(out + '.receipt.json', JSON.stringify({
    model: MODEL,
    prompt_version: PROMPT_VERSION,
    questions_sha256: createHash('sha256').update(questionsText).digest('hex'),
    paraphrases_sha256: createHash('sha256').update(body).digest('hex'),
    written: rows.length,
    rule_failures: failed,
    not_attempted: missing - failed.length,
    budget_exhausted: paid.guard.exhausted,
    stopped_by_error: stoppedBy,
    cost: receiptCost(paid.run.close()),
  }, null, 2) + '\n');
  if (stoppedBy) console.error('paraphrase-opus: stopped at ' + stoppedBy + '; the paraphrases already paid for are kept');
  console.log('paraphrase-opus: ' + rows.length + ' of ' + questions.length + ' paraphrases written to ' + out + (missing ? '; ' + missing + ' missing, so the generator will refuse this file until they are filled' : ''));
  return missing ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
