/**
 * A Claude Code-shaped session transcript (JSONL), written as the streaming
 * conversation runs, so gbrain's real hooks read it the way they read Claude
 * Code's: user and assistant lines, assistant `message.usage`, and a
 * `system`/`compact_boundary` line at each compaction.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface TranscriptUsage { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number }

export class ClaudeTranscript {
  private parent: string | null = null;
  constructor(readonly path: string, readonly sessionId: string, readonly cwd: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
  }
  private line(row: Record<string, unknown>): string {
    const uuid = randomUUID();
    appendFileSync(this.path, `${JSON.stringify({ parentUuid: this.parent, isSidechain: false, userType: 'external', cwd: this.cwd, sessionId: this.sessionId, version: '2.1.289', uuid, timestamp: new Date().toISOString(), ...row })}\n`);
    this.parent = uuid;
    return uuid;
  }
  user(text: string): void {
    this.line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  }
  assistant(text: string, model: string, usage?: TranscriptUsage): void {
    this.line({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text }], ...(usage ? { usage } : {}) } });
  }
  /** A compaction boundary; returns its uuid (the pressure notice keys its segment on it). */
  compactBoundary(trigger: 'auto' | 'manual' = 'auto'): string {
    return this.line({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger } });
  }
}
