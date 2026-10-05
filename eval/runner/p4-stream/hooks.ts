/**
 * Runs the build under test's real Claude Code hooks (`gbrain hook <event>`)
 * with the stdin payload Claude Code sends, and returns what Claude Code would
 * inject: SessionStart stdout as-is, UserPromptSubmit's
 * `hookSpecificOutput.additionalContext`.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export interface HookEnv { buildDir: string; env: NodeJS.ProcessEnv; cwd: string }
export interface HookResult { code: number; stdout: string; stderr: string; ms: number }

export function runHook(h: HookEnv, event: 'session-start' | 'user-prompt' | 'compact', payload: Record<string, unknown>, timeoutMs = 30_000): Promise<HookResult> {
  const t0 = Date.now();
  return new Promise(resolve => {
    const p = spawn('bun', [join(h.buildDir, 'src/cli.ts'), 'hook', event], { env: h.env, cwd: h.cwd });
    let stdout = '', stderr = '';
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', c => { stdout += c; });
    p.stderr.on('data', c => { stderr += c; });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', code => { clearTimeout(t); resolve({ code: code ?? -1, stdout, stderr: stderr.slice(-2000), ms: Date.now() - t0 }); });
    p.stdin.end(JSON.stringify(payload));
  });
}

/** UserPromptSubmit output → the additionalContext Claude Code injects ('' when none). */
export function additionalContext(stdout: string): string {
  for (const line of stdout.split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t) as { hookSpecificOutput?: { additionalContext?: string } };
      return j.hookSpecificOutput?.additionalContext ?? '';
    } catch { /* not the payload */ }
  }
  return '';
}
