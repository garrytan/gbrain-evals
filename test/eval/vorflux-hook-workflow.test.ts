import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const source = readFileSync(new URL('../../.github/workflows/vorflux-hook.yml', import.meta.url), 'utf8');
const workflow = yaml.load(source) as any;
const job = workflow.jobs.notify;
const step = job.steps[0];

function evaluate(expression: string, context: Record<string, unknown>): any {
  const js = expression
    .replace(/\b(github|secrets)((?:\.[\w*]+)+)/g, (_m, root: string, path: string) => {
      const [base, field] = path.split('.*.');
      const access = root + base.replace(/\./g, '?.');
      return field === undefined ? access : `(${access} ?? []).map((x) => x?.${field})`;
    })
    .replace(/==/g, '===');
  const contains = (list: unknown[], item: unknown) => list.includes(item);
  return new Function('github', 'secrets', 'contains', `return (${js});`)(context.github, context.secrets, contains);
}

function rings(eventName: string, event: Record<string, unknown>): boolean {
  return Boolean(evaluate(job.if, { github: { event_name: eventName, event, repository: 'garrytan/gbrain-evals' }, secrets: {} }));
}

function stepEnv(eventName: string, event: Record<string, unknown>, hookUrl: string): Record<string, string> {
  const context = { github: { event_name: eventName, event, repository: 'garrytan/gbrain-evals', token: 'fake-token' }, secrets: { VORFLUX_HOOK_URL: hookUrl } };
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(step.env as Record<string, string>)) {
    const result = evaluate(/^\$\{\{(.*)\}\}$/.exec(value)![1], context);
    env[name] = result === undefined || result === null ? '' : String(result);
  }
  return env;
}

function runStep(eventName: string, event: Record<string, unknown>, hookUrl = 'https://hook.invalid/wh_test') {
  const dir = mkdtempSync(join(tmpdir(), 'vorflux-hook-'));
  try {
    writeFileSync(join(dir, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/curl.args"\n`);
    writeFileSync(join(dir, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/gh.args"\necho fetchedheadsha\n`);
    chmodSync(join(dir, 'curl'), 0o755);
    chmodSync(join(dir, 'gh'), 0o755);
    const result = spawnSync('bash', ['-c', step.run], {
      encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH}`, ...stepEnv(eventName, event, hookUrl) },
    });
    const curlArgs = existsSync(join(dir, 'curl.args')) ? readFileSync(join(dir, 'curl.args'), 'utf8').split('\n') : null;
    const ghCalled = existsSync(join(dir, 'gh.args'));
    const body = curlArgs ? JSON.parse(curlArgs[curlArgs.indexOf('--data') + 1]) : null;
    return { ...result, curlArgs, ghCalled, body };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const capy = { login: 'capy-ai[bot]' };
const human = { login: 'garrytan' };
const labelled = [{ name: 'documentation' }, { name: 'vorflux' }];
const pr = (extra: Record<string, unknown> = {}) => ({
  number: 547, labels: labelled, head: { sha: 'headsha547', repo: { full_name: 'garrytan/gbrain-evals' } }, html_url: 'https://github.com/garrytan/gbrain-evals/pull/547',
  merged: false, merge_commit_sha: 'testmergesha', closed_at: null, ...extra,
});
const prComment = (user = capy, labels = labelled, pullRequest: unknown = { url: 'x' }) => ({
  action: 'created',
  issue: { number: 547, labels, pull_request: pullRequest },
  comment: { id: 111, user, html_url: 'https://github.com/garrytan/gbrain-evals/pull/547#issuecomment-111' },
  sender: user,
});
const review = (user = capy) => ({ action: 'submitted', pull_request: pr(), review: { id: 222, user, html_url: 'https://github.com/garrytan/gbrain-evals/pull/547#pullrequestreview-222' }, sender: user });
const reviewComment = (user = capy) => ({ action: 'created', pull_request: pr(), comment: { id: 333, user, html_url: 'https://github.com/garrytan/gbrain-evals/pull/547#discussion_r333' }, sender: user });
const closed = (merged: boolean, labels = labelled) => ({
  action: 'closed', pull_request: pr({ merged, labels, closed_at: '2026-11-20T16:00:00Z' }), sender: human,
});

describe('Vorflux hook workflow: shape (GST-3280)', () => {
  test('listens only to new comments, submitted reviews, new review comments and closed pull requests', () => {
    expect(workflow.on).toEqual({
      issue_comment: { types: ['created'] },
      pull_request_review: { types: ['submitted'] },
      pull_request_review_comment: { types: ['created'] },
      pull_request_target: { types: ['closed'] },
    });
  });

  test('has no token permissions, no checkout and no action, one job with a job-level condition and a timeout', () => {
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs)).toEqual(['notify']);
    expect(job.permissions).toBeUndefined();
    expect(typeof job.if).toBe('string');
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job.steps).toHaveLength(1);
    expect(source).not.toMatch(/^\s*-?\s*uses:/m);
    expect(source).not.toMatch(/actions\/checkout|git (clone|fetch|checkout)/);
  });

  test('the script takes every value from env, never from an inline expression, and never traces', () => {
    expect(step.run).not.toContain('${{');
    expect(step.run).not.toMatch(/set -[a-z]*x/);
    expect(step.env.HOOK_URL).toBe('${{ secrets.VORFLUX_HOOK_URL }}');
    expect(source.match(/secrets\./g)).toHaveLength(1);
    expect(step.run).toContain('curl --fail-with-body');
    expect(step.run).toMatch(/--max-time \d+/);
    expect(step.run).toMatch(/--retry \d+/);
    expect(step.run).toContain('jq -cn');
  });
});

describe('Vorflux hook workflow: who rings', () => {
  test('rings for capy-ai[bot] on a labelled pull request and for a labelled pull request closing', () => {
    expect(rings('issue_comment', prComment())).toBe(true);
    expect(rings('pull_request_review', review())).toBe(true);
    expect(rings('pull_request_review_comment', reviewComment())).toBe(true);
    expect(rings('pull_request_target', closed(true))).toBe(true);
    expect(rings('pull_request_target', closed(false))).toBe(true);
  });

  test('stays silent for anyone else, for unlabelled pull requests and for plain issues', () => {
    expect(rings('issue_comment', prComment(human))).toBe(false);
    expect(rings('issue_comment', prComment(capy, [{ name: 'documentation' }]))).toBe(false);
    expect(rings('issue_comment', prComment(capy, labelled, null))).toBe(false);
    expect(rings('pull_request_review', review(human))).toBe(false);
    expect(rings('pull_request_review_comment', reviewComment(human))).toBe(false);
    expect(rings('pull_request_target', closed(true, []))).toBe(false);
    expect(rings('pull_request_target', { ...closed(false), action: 'opened' })).toBe(false);
  });

  test('a review or review comment on a fork pull request starts no runner, because GitHub gives it no secret', () => {
    const fork = { sha: 'forksha', repo: { full_name: 'someone/gbrain-evals' } };
    expect(rings('pull_request_review', { ...review(), pull_request: pr({ head: fork }) })).toBe(false);
    expect(rings('pull_request_review_comment', { ...reviewComment(), pull_request: pr({ head: fork }) })).toBe(false);
    expect(rings('pull_request_target', { ...closed(true), pull_request: pr({ merged: true, head: fork }) })).toBe(true);
  });
});

describe('Vorflux hook workflow: what it sends (stubbed curl, no network)', () => {
  test('a pull-request comment sends the comment id, the looked-up head and a stable delivery id', () => {
    const run = runStep('issue_comment', prComment());
    expect(run.status).toBe(0);
    expect(run.ghCalled).toBe(true);
    expect(run.body).toEqual({
      repo: 'garrytan/gbrain-evals', pr: 547, event: 'comment', github_event: 'issue_comment', author: 'capy-ai[bot]',
      head_sha: 'fetchedheadsha', html_url: 'https://github.com/garrytan/gbrain-evals/pull/547#issuecomment-111',
      delivery_id: 'garrytan/gbrain-evals#547/issue_comment/111', comment_id: 111,
    });
    expect(runStep('issue_comment', prComment()).body.delivery_id).toBe(run.body.delivery_id);
    expect(run.curlArgs).toContain('--fail-with-body');
    expect(run.curlArgs![run.curlArgs!.length - 2]).toBe('https://hook.invalid/wh_test');
  });

  test('a review and a review comment carry their own ids and the event head, with no lookup', () => {
    const r = runStep('pull_request_review', review());
    expect(r.status).toBe(0);
    expect(r.ghCalled).toBe(false);
    expect(r.body).toMatchObject({ event: 'review', review_id: 222, head_sha: 'headsha547', delivery_id: 'garrytan/gbrain-evals#547/pull_request_review/222' });
    expect(r.body.comment_id).toBeUndefined();
    const c = runStep('pull_request_review_comment', reviewComment());
    expect(c.body).toMatchObject({ event: 'comment', comment_id: 333, github_event: 'pull_request_review_comment', delivery_id: 'garrytan/gbrain-evals#547/pull_request_review_comment/333' });
  });

  test('merged sends the merge commit; closed without merging does not', () => {
    const m = runStep('pull_request_target', closed(true));
    expect(m.body).toMatchObject({ event: 'merged', merge_commit_sha: 'testmergesha', author: 'garrytan', delivery_id: 'garrytan/gbrain-evals#547/merged/testmergesha' });
    const c = runStep('pull_request_target', closed(false));
    expect(c.body).toMatchObject({ event: 'closed', delivery_id: 'garrytan/gbrain-evals#547/closed/2026-11-20T16:00:00Z' });
    expect(c.body.merge_commit_sha).toBeUndefined();
  });

  test('nothing from the comment body is sent', () => {
    const event = prComment();
    (event.comment as any).body = 'SECRET-LOOKING TEXT';
    expect(JSON.stringify(runStep('issue_comment', event).body)).not.toContain('SECRET-LOOKING');
  });

  test('an empty secret fails the run with a clear message and never calls curl', () => {
    const run = runStep('issue_comment', prComment(), '');
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('VORFLUX_HOOK_URL is empty or missing');
    expect(run.curlArgs).toBeNull();
  });
});
