import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { regressionPackageHash } from '../../eval/runner/situation-recall-provenance.ts';
import { resolveSourceOnlyDevelopmentPolicy, type SourceOnlyDevelopmentProfile } from '../../eval/runner/situation-recall-experiment-policy.ts';

const hash = 'a'.repeat(64);
const promptHash = '44506bb8d722adb75fd4a0b1ec3a3265d71bb77de7e9a2db07214caee97c94d0';
const profile = (arm: 'B' | 'C0' | 'C1', stage: 'construction' | 'replay' = 'construction'): SourceOnlyDevelopmentProfile => ({
  schema_version: 1, kind: 'source-only-development', experiment: 'longmemeval-m-source-only-dev-v3',
  question_id: 'synthetic-source-only', attempt_id: 'synthetic-v5', arm, stage,
  registration_sha256: hash, source_manifest_sha256: hash, expected_product_sha: 'b'.repeat(40), expected_package_sha256: hash,
  allocation: { id: 'synthetic-no-authorization', usd: stage === 'construction' ? arm === 'C1' ? 95 : 9 : arm === 'C1' ? 5 : 1 },
  ...(arm === 'C1' ? { cue_mode: 'on', cue_pipeline_version: 'situation-v5', cue_prompt_sha256: promptHash } : { cue_mode: 'off' }),
  ...(stage === 'replay' ? { construction_receipt_sha256: hash } : {}),
} as SourceOnlyDevelopmentProfile);

test.each(['B', 'C0', 'C1'] as const)('v5 %s retains the v4 bounds across both stages', arm => {
  for (const stage of ['construction', 'replay'] as const) {
    const current = resolveSourceOnlyDevelopmentPolicy(profile(arm, stage));
    const previous = resolveSourceOnlyDevelopmentPolicy({ ...profile(arm, stage), experiment: 'longmemeval-m-source-only-dev-v2',
      ...(arm === 'C1' ? { cue_pipeline_version: 'situation-v4' } : {}) } as SourceOnlyDevelopmentProfile);
    expect({ ...current, id: previous.id }).toEqual(previous);
    expect(current.evidence_max_bytes).toBe(8192);
    expect(current.evidence_max_excerpts).toBe(64);
    expect(current.excerpt_max_utf16_units).toBe(640);
    expect(current.max_chat_request_bytes).toBe(arm === 'C1' && stage === 'construction' ? 65536 : 0);
    expect(current.max_output_tokens).toBe(arm === 'C1' && stage === 'construction' ? 1200 : 0);
  }
});

test('v5 rejects mixed generations, unknown versions, and caller-expanded limits', () => {
  for (const patch of [
    { cue_pipeline_version: 'situation-v4' }, { experiment: 'longmemeval-m-source-only-dev-v2' },
    { experiment: 'longmemeval-m-source-only-dev-v4' }, { cue_prompt_sha256: 'not-a-hash' },
    { evidence_max_bytes: 8193 }, { max_requests: 5969 }, { generation_model: 'other' },
  ]) expect(() => resolveSourceOnlyDevelopmentPolicy({ ...profile('C1'), ...patch } as SourceOnlyDevelopmentProfile)).toThrow();
  expect(() => resolveSourceOnlyDevelopmentPolicy({ ...profile('B'), cue_pipeline_version: 'situation-v5' } as SourceOnlyDevelopmentProfile)).toThrow();
});

test('v5 controlled source-reference guard admits canonical SDK wire and rejects mutations before dispatch', () => {
  const root = mkdtempSync(join(tmpdir(), 'v5-controlled-'));
  try {
    const runner = join(root, 'eval/runner');
    const pkg = join(root, 'node_modules/gbrain');
    mkdirSync(runner, { recursive: true });
    mkdirSync(join(pkg, 'src/core/memory-cues'), { recursive: true });
    for (const file of ['situation-recall-development.ts', 'situation-recall-experiment-policy.ts', 'situation-recall-provenance.ts'])
      cpSync(resolve('eval/runner', file), join(runner, file));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies: { gbrain: 'file:./node_modules/gbrain' } }));
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'gbrain', version: 'controlled-v5', type: 'module', exports: {} }));
    writeFileSync(join(pkg, 'src/core/embedding-pricing.ts'), 'export const lookupEmbeddingPrice=()=>({kind:"known",pricePerMTok:0.13});');
    writeFileSync(join(pkg, 'src/core/model-pricing.ts'), 'export const canonicalLookup=()=>({input:3,output:15});');
    writeFileSync(join(pkg, 'src/core/memory-cues/types.ts'), 'export const MEMORY_CUE_PROMPT_VERSION="situation-v5";');
    writeFileSync(join(pkg, 'src/core/memory-cues/providers.ts'), 'export const CUE_SYSTEM_PROMPT="synthetic-v5";');
    writeFileSync(join(pkg, 'src/core/memory-cues/evidence.ts'), `export const formatCueEvidence=(source,includeBridge)=>{
      const excerpts=[{id:1,text:source}];return {excerpts,content:JSON.stringify({includeBridge,evidence:excerpts}),inputTokenCeiling:300,maximumInputTokenCeiling:65536};};`);
    const p = { ...profile('C1'), allocation: { id: 'synthetic-smoke-one-dollar', usd: 1 }, expected_package_sha256: regressionPackageHash(pkg), cue_prompt_sha256: createHash('sha256').update('synthetic-v5').digest('hex') };
    const script = `
      import {strict as assert} from 'node:assert';
      import {join} from 'node:path';
      import {startSourceOnlyDevelopmentGuard,developmentChatOptions} from './eval/runner/situation-recall-development.ts';
      const p=${JSON.stringify(p)},pkg=${JSON.stringify(pkg)},root=${JSON.stringify(root)};
      let calls=0;globalThis.fetch=async request=>{calls++;return Response.json({model:'anthropic/claude-sonnet-4.6',usage:{prompt_tokens:1,completion_tokens:1,cost:0.000018,is_byok:false}})};
      const guard=await startSourceOnlyDevelopmentGuard(p,{journalPath:join(root,'requests.ndjson'),verifiedPackagePath:pkg,sourceSmoke:true});
      const model='openrouter:anthropic/claude-sonnet-4.6';
      const body=(evidence)=>({model:'anthropic/claude-sonnet-4.6',messages:[{role:'system',content:'synthetic-v5'},
        {role:'user',content:JSON.stringify({includeBridge:false,evidence})}],max_tokens:1200,temperature:0,...developmentChatOptions(model)[model]});
      const send=value=>fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',body:JSON.stringify(value)});
      try{
        await send(body([{id:1,text:'synthetic full source'}]));
        assert.equal(calls,1);
        await assert.rejects(()=>send(body([{id:2,text:'synthetic full source'}])),/no request dispatched/);
        assert.equal(calls,1);
        assert.equal(guard.snapshot().limits.max_requests,1);
      }finally{guard.restore()}
      await assert.rejects(()=>startSourceOnlyDevelopmentGuard({...p,experiment:'longmemeval-m-source-only-dev-v2',cue_pipeline_version:'situation-v4'},
        {journalPath:join(root,'invalid.ndjson'),verifiedPackagePath:pkg,sourceSmoke:true}),/v5 source smoke/);
      console.log('V5_CONTROLLED_OK');`;
    const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', script], { cwd: root,
      env: { PATH: process.env.PATH, HOME: root }, timeout: 30_000 });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString() + child.stdout.toString());
    expect(child.stdout.toString()).toContain('V5_CONTROLLED_OK');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
