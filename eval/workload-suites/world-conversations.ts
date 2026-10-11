/**
 * Render world-v1 pages as conversations: the user shares their notes on one
 * entity over several turns and the assistant acknowledges them. Markdown
 * links become plain names, so no page slug reaches a model input. Extra
 * user sentences (seeded details, explicit relationship statements) are
 * inserted as their own turns or as asides.
 */
import { join } from 'node:path';
import type { Rng } from '../generators/seeded.ts';
import { loadWorldCorpus, type RichPage } from '../runner/queries/relational.ts';
import type { ChatMessage } from './types.ts';

export const WORLD_DIR = join(import.meta.dir, '../data/world-v1');

let cached: RichPage[] | null = null;
export function worldPages(): RichPage[] {
  cached ??= loadWorldCorpus(WORLD_DIR);
  return cached;
}

/** `[Forge](companies/forge-19)` becomes `Forge`; bold markers are dropped. */
export function plainText(markdown: string): string {
  return markdown.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*/g, '');
}

/** Lowercased plain text of the whole world, for value-collision checks. */
export function worldTextLower(): string {
  return worldPages().map(p => plainText(`${p.title}\n${p.compiled_truth}\n${p.timeline}`)).join('\n').toLowerCase();
}

const ACKS = [
  'Got it, I have that noted.',
  'Thanks, that is helpful context.',
  'Noted. Anything else on this?',
  'Understood, I will keep that in mind.',
  'Makes sense. Go on.',
  'Thanks for the detail.',
];

export interface WorldConversationOptions {
  /** Sentences inserted as asides at the start of random user turns after the first. */
  asides?: readonly string[];
  /** Sentences sent as one extra user turn at the end. */
  closing?: readonly string[];
}

export function worldPageConversation(page: RichPage, rng: Rng, opts: WorldConversationOptions = {}): { messages: ChatMessage[]; asideTurns: number[] } {
  const paragraphs = plainText(page.compiled_truth).split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const timeline = plainText(page.timeline).split('\n').map(s => s.replace(/^-\s*/, '').trim()).filter(Boolean);
  const userTurns: string[] = [`Here are my notes on ${page.title}. ${paragraphs[0] ?? ''}`.trim()];
  for (const p of paragraphs.slice(1)) userTurns.push(`More on ${page.title}: ${p}`);
  if (timeline.length) userTurns.push(`Key dates for ${page.title}: ${timeline.join('; ')}.`);
  const asideTurns: number[] = [];
  for (const aside of opts.asides ?? []) {
    const candidates = userTurns.map((_, i) => i).filter(i => i > 0 && !asideTurns.includes(i));
    const turn = candidates.length ? rng.pick(candidates) : userTurns.length;
    if (turn === userTurns.length) userTurns.push(aside);
    else userTurns[turn] = `${aside} ${userTurns[turn]}`;
    asideTurns.push(turn);
  }
  if (opts.closing?.length) userTurns.push(opts.closing.join(' '));
  const messages: ChatMessage[] = [];
  for (const u of userTurns) {
    messages.push({ role: 'user', content: u });
    messages.push({ role: 'assistant', content: rng.pick(ACKS) });
  }
  return { messages, asideTurns };
}
