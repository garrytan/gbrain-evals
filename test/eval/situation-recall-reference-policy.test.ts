import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cat36Hash } from '../../eval/runner/cat36-corpus.ts';
import { regressionPackageHash } from '../../eval/runner/situation-recall-provenance.ts';
import { resolveSourceOnlyDevelopmentPolicy, type SourceOnlyDevelopmentProfile } from '../../eval/runner/situation-recall-experiment-policy.ts';

const prompt = 'Controlled v4 source-reference fixture. ' + 'x'.repeat(4096);

function profile(arm: 'B' | 'C0' | 'C1' = 'C1', stage: 'construction' | 'replay' = 'construction'): SourceOnlyDevelopmentProfile {
  return {
    schema_version: 1, kind: 'source-only-development', experiment: 'longmemeval-m-source-only-dev-v2',
    question_id: 'synthetic-q-1', attempt_id: 'v4-attempt-1', arm, stage,
    registration_sha256: '1'.repeat(64), source_manifest_sha256: '2'.repeat(64), expected_product_sha: 'a'.repeat(40), expected_package_sha256: 'b'.repeat(64),
    allocation: { id: `${arm}-${stage}-v4-attempt-1`, usd: stage === 'replay' ? arm === 'C1' ? 5 : 1 : arm === 'C1' ? 95 : 9 },
    ...(arm === 'C1' ? { cue_mode: 'on', cue_pipeline_version: 'situation-v4', cue_prompt_sha256: cat36Hash(prompt) } : { cue_mode: 'off' }),
    ...(stage === 'replay' ? { construction_receipt_sha256: '3'.repeat(64) } : {}),
  } as SourceOnlyDevelopmentProfile;
}

function formatterSource(units: number): string {
  return `export function formatCueEvidence(source,includeBridge) {
    if(includeBridge!==false)throw new Error('explicit false includeBridge required');
    const evidence=[];let text='';
    for(const point of source) {
      if(text.length+point.length>${units}) { evidence.push({id:evidence.length+1,text});text=''; }
      text+=point;
    }
    if(text)evidence.push({id:evidence.length+1,text});
    let start=0;
    const excerpts=evidence.map(entry=>{const excerpt={...entry,start,end:start+entry.text.length};start=excerpt.end;return excerpt;});
    const content=JSON.stringify({includeBridge,evidence});
    return {excerpts,content,inputTokenCeiling:Buffer.byteLength(content),maximumInputTokenCeiling:65536};
  }`;
}

function inFixture(p: SourceOnlyDevelopmentProfile, action: string, options: { units?: number; formatter?: string | null; version?: string; prompt?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'source-reference-policy-'));
  try {
    const runner = join(root, 'eval/runner');
    mkdirSync(runner, { recursive: true });
    for (const file of ['situation-recall-development.ts', 'situation-recall-experiment-policy.ts', 'situation-recall-provenance.ts']) cpSync(resolve('eval/runner', file), join(runner, file));
    const pkg = join(root, 'node_modules/gbrain');
    mkdirSync(join(pkg, 'src/core'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies: { gbrain: `github:synthetic/gbrain#${p.expected_product_sha}` } }));
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'gbrain', version: 'synthetic-v4-policy-fixture', type: 'module', exports: {} }));
    writeFileSync(join(pkg, 'src/core/embedding-pricing.ts'), 'export const lookupEmbeddingPrice=()=>({kind:"known",pricePerMTok:0.13});');
    if (p.arm === 'C1') {
      mkdirSync(join(pkg, 'src/core/memory-cues'));
      writeFileSync(join(pkg, 'src/core/model-pricing.ts'), 'export const canonicalLookup=()=>({input:3,output:15});');
      writeFileSync(join(pkg, 'src/core/memory-cues/types.ts'), `export const MEMORY_CUE_PROMPT_VERSION=${JSON.stringify(options.version ?? 'situation-v4')};`);
      writeFileSync(join(pkg, 'src/core/memory-cues/providers.ts'), `export const CUE_SYSTEM_PROMPT=${JSON.stringify(options.prompt ?? prompt)};`);
      if (options.formatter !== null) writeFileSync(join(pkg, 'src/core/memory-cues/evidence.ts'), options.formatter ?? formatterSource(options.units ?? 128));
    }
    p.expected_package_sha256 = regressionPackageHash(pkg);
    const script = `
      import {strict as assert} from 'node:assert';
      import {existsSync} from 'node:fs';
      import {join} from 'node:path';
      import {startSourceOnlyDevelopmentGuard,developmentChatOptions} from './eval/runner/situation-recall-development.ts';
      const profile=${JSON.stringify(p)},root=${JSON.stringify(root)},prompt=${JSON.stringify(prompt)};
      const sdkGatewayPath=${JSON.stringify(resolve('node_modules/gbrain/src/core/ai/gateway.ts'))};
      const model='openrouter:anthropic/claude-sonnet-4.6';
      const options={journalPath:join(root,'requests.ndjson'),verifiedPackagePath:join(root,'node_modules/gbrain')};
      const embedUrl='https://openrouter.ai/api/v1/embeddings',chatUrl='https://openrouter.ai/api/v1/chat/completions';
      const body=evidence=>({model:'anthropic/claude-sonnet-4.6',max_tokens:1200,temperature:0,
        messages:[{role:'system',content:prompt},{role:'user',content:JSON.stringify({includeBridge:false,evidence})}],
        ...developmentChatOptions(model)[model]});
      const contentBody=content=>{const request=body([]);request.messages[1].content=content;return request;};
      const send=value=>fetch(chatUrl,{method:'POST',body:JSON.stringify(value)});
      let calls=0;
      const responseContent='[{"evidence_ref":999,"text":"output validation belongs to the product"}]';
      globalThis.fetch=async(input,init)=>{
        const request=new Request(input,init),value=await request.json();calls++;
        return Response.json({id:'synthetic-v4-response',object:'chat.completion',created:1,model:request.url===embedUrl?'text-embedding-3-large':value.model,
          choices:[{index:0,message:{role:'assistant',content:responseContent},finish_reason:'stop'}],
          usage:{prompt_tokens:1,completion_tokens:1,cost:0.00000013,is_byok:false}});
      };
      ${action}
      console.log('REFERENCE_POLICY_OK');
    `;
    const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', script], { cwd: root, env: { PATH: process.env.PATH, HOME: root }, timeout: 120_000 });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString() + child.stdout.toString());
    expect(child.stdout.toString()).toContain('REFERENCE_POLICY_OK');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test.each(['B', 'C0', 'C1'] as const)('%s v2 preserves every existing stage ceiling while recording the distinct excerpt contract', arm => {
  for (const stage of ['construction', 'replay'] as const) {
    const v4 = profile(arm, stage);
    const v3 = { ...v4, experiment: 'longmemeval-m-source-only-dev-v1', ...(arm === 'C1' ? { cue_pipeline_version: 'situation-v3' } : {}) } as SourceOnlyDevelopmentProfile;
    const before = resolveSourceOnlyDevelopmentPolicy(v3);
    const { id, evidence_max_excerpts, excerpt_max_utf16_units, ...after } = resolveSourceOnlyDevelopmentPolicy(v4);
    const { id: oldId, ...oldLimits } = before;
    expect(oldId).toBe('longmemeval-m-source-only-dev-v1');
    expect(id).toBe('longmemeval-m-source-only-dev-v2');
    expect(after).toEqual(oldLimits);
    expect(evidence_max_excerpts).toBe(64);
    expect(excerpt_max_utf16_units).toBe(640);
    expect('evidence_max_excerpts' in before).toBe(false);
  }
});

test('experiment and pipeline versions cannot be interchanged or caller-extended', () => {
  for (const patch of [
    { experiment: 'longmemeval-m-source-only-dev-v1' }, { cue_pipeline_version: 'situation-v3' },
    { experiment: 'longmemeval-m-source-only-dev-v3', cue_pipeline_version: 'situation-v5' },
    { evidence_max_excerpts: 65 }, { excerpt_max_utf16_units: 641 }, { max_chat_request_bytes: 131072 },
  ]) expect(() => resolveSourceOnlyDevelopmentPolicy({ ...profile(), ...patch } as SourceOnlyDevelopmentProfile)).toThrow();
});

test('v4 worst-case escaped source and 64 excerpts fit the unchanged 64 KiB SDK-shaped wire ceiling', () => {
  inFixture(profile(), `
    const {formatCueEvidence}=await import('./node_modules/gbrain/src/core/memory-cues/evidence.ts');
    const guard=await startSourceOnlyDevelopmentGuard(profile,options);
    try {
      for(const source of ['a'.repeat(8192),String.fromCharCode(34).repeat(8192),String.fromCharCode(92).repeat(8192),String.fromCharCode(1).repeat(8192),'😀'.repeat(2048),'界'.repeat(2730)+'ab']) {
        const formatted=formatCueEvidence(source,false),request=contentBody(formatted.content);
        const excerpts=JSON.parse(formatted.content).evidence;
        assert.equal(excerpts.map(x=>x.text).join(''),source);
        assert.equal(Buffer.byteLength(source),8192);
        assert.ok(excerpts.length<=64&&excerpts.every(x=>x.text.length<=640));
        assert.ok(Buffer.byteLength(JSON.stringify(request))<=65536);
        assert.deepEqual(Object.keys(request).sort(),['max_tokens','messages','model','provider','reasoning','temperature']);
        const response=await send(request);
        assert.equal((await response.json()).choices[0].message.content,responseContent);
      }
      assert.equal(formatCueEvidence('a'.repeat(8192),false).excerpts.length,64);
      assert.equal(calls,6);
      assert.equal(guard.snapshot().policy_context.policy.id,'longmemeval-m-source-only-dev-v2');
      assert.equal(guard.snapshot().publishable,false);
      assert.equal(guard.snapshot().limits.max_requests,5968);
    } finally {guard.restore();}
  `);
});

test('v4 enforces UTF-16 excerpt length and UTF-8 total source independently', () => {
  inFixture(profile(), `
    const {formatCueEvidence}=await import('./node_modules/gbrain/src/core/memory-cues/evidence.ts');
    const guard=await startSourceOnlyDevelopmentGuard(profile,options);
    try {
      const exact='😀'.repeat(320);
      assert.equal(exact.length,640);
      await send(contentBody(formatCueEvidence(exact,false).content));
      const wire=source=>JSON.parse(formatCueEvidence(source,false).content).evidence;
      for(const evidence of [[{id:1,text:exact+'a'}],wire('a'.repeat(8193)),wire('😀'.repeat(2049)),wire(String.fromCharCode(1).repeat(8193))]) {
        await assert.rejects(()=>send(body(evidence)),/no request dispatched/);
      }
      assert.equal(calls,1);
    } finally {guard.restore();}
  `, { units: 640 });
});

test('v4 rejects malformed IDs, duplicate/order changes, extra fields and noncanonical segmentation', () => {
  inFixture(profile(), `
    const {formatCueEvidence}=await import('./node_modules/gbrain/src/core/memory-cues/evidence.ts');
    const guard=await startSourceOnlyDevelopmentGuard(profile,options);
    try {
      const formatted=formatCueEvidence('a'.repeat(256),false);
      const canonical=JSON.parse(formatted.content).evidence;
      await send(body(canonical));
      const variants=[[], 'v3 source string', formatted.excerpts, [{id:0,text:'a'}], [{id:'1',text:'a'}], [{id:1.5,text:'a'}],
        [{id:2,text:'a'}],[{id:1,text:''}],[{id:1,text:'a',quote:'extra'}],[null],
        [{id:1,text:'a'},{id:1,text:'b'}],[{id:1,text:'a'},{id:3,text:'b'}],canonical.slice().reverse(),
        [{id:1,text:'a'.repeat(127)},{id:2,text:'a'.repeat(129)}],
        Array.from({length:65},(_,i)=>({id:i+1,text:'a'}))];
      for(const evidence of variants)await assert.rejects(()=>send(body(evidence)),/no request dispatched/);
      const extra=body(canonical);extra.messages[1].content=JSON.stringify({includeBridge:false,evidence:canonical,question:'not admitted'});
      await assert.rejects(()=>send(extra),/no request dispatched/);
      const reordered=body(canonical.map(x=>({text:x.text,id:x.id})));
      await assert.rejects(()=>send(reordered),/no request dispatched/);
      assert.equal(calls,1);
    } finally {guard.restore();}
  `);
});

test('actual-shaped formatter content passes the real SDK with required false and internal excerpt metadata', () => {
  inFixture(profile(), `
    const {formatCueEvidence}=await import('./node_modules/gbrain/src/core/memory-cues/evidence.ts');
    assert.throws(()=>formatCueEvidence('source'),/explicit false/);
    const formatted=formatCueEvidence('source',false);
    assert.deepEqual(Object.keys(formatted).sort(),['content','excerpts','inputTokenCeiling','maximumInputTokenCeiling']);
    assert.equal(formatted.excerpts[0].start,0);assert.equal(formatted.excerpts[0].end,6);
    assert.deepEqual(JSON.parse(formatted.content),{includeBridge:false,evidence:[{id:1,text:'source'}]});
    const request=contentBody(formatted.content);
    assert.deepEqual(Object.keys(request).sort(),['max_tokens','messages','model','provider','reasoning','temperature']);
    const gateway=await import(sdkGatewayPath);
    gateway.configureGateway({chat_model:model,provider_chat_options:developmentChatOptions(model),env:{OPENROUTER_API_KEY:'synthetic-v4-not-a-key'}});
    const guard=await startSourceOnlyDevelopmentGuard(profile,options);
    try {
      const response=await gateway.chat({model,system:prompt,messages:[{role:'user',content:formatted.content}],maxTokens:1200,temperature:0});
      assert.equal(response.text,responseContent);
      assert.equal(calls,1);assert.equal(guard.snapshot().reserved_usd,0);
    } finally {guard.restore();}
  `);
});

test('v4 keeps the registered prompt, Scene/Horizon shape, route and provider controls closed', () => {
  inFixture(profile(), `
    const guard=await startSourceOnlyDevelopmentGuard(profile,options);
    try {
      const valid=body([{id:1,text:'synthetic source'}]);await send(valid);
      const variants=[];
      for(const key of ['stream','tools','n','max_completion_tokens','response_format','unknown'])variants.push({...valid,[key]:false});
      variants.push({...valid,model:'qwen/qwen3.7-flash'},{...valid,temperature:1},{...valid,max_tokens:1201},
        {...valid,reasoning:{enabled:true}},{...valid,provider:{...valid.provider,allow_fallbacks:true}},
        {...valid,messages:[{role:'system',content:'Answer the question'},valid.messages[1]]},
        {...valid,messages:[valid.messages[0],{role:'assistant',content:valid.messages[1].content}]},
        {...valid,messages:[...valid.messages,{role:'user',content:'extra'}]},
        {...valid,messages:[valid.messages[0],{role:'user',content:JSON.stringify({includeBridge:true,evidence:[{id:1,text:'synthetic source'}]})}]});
      for(const request of variants)await assert.rejects(()=>send(request),/no request dispatched/);
      await assert.rejects(()=>fetch('https://api.anthropic.com/v1/messages',{method:'POST',body:JSON.stringify(valid)}),/no request dispatched/);
      guard.sealConstruction();await assert.rejects(()=>send(valid),/no request dispatched/);
      assert.equal(calls,1);
    } finally {guard.restore();}
  `);
});

test.each(['B', 'C0'] as const)('v2 %s still needs no cue API or formatter and rejects all chat', arm => {
  inFixture(profile(arm), `
    assert.equal(existsSync(join(options.verifiedPackagePath,'src/core/memory-cues')),false);
    const guard=await startSourceOnlyDevelopmentGuard(profile,options);
    try {
      await assert.rejects(()=>send(body([{id:1,text:'source'}])),/no request dispatched/);
      await fetch(embedUrl,{method:'POST',body:JSON.stringify({model:'openai/text-embedding-3-large',dimensions:1536,input:['source']})});
      assert.equal(calls,1);
    } finally {guard.restore();}
  `);
});

test.each(['B', 'C0', 'C1'] as const)('v2 %s replay remains chat sealed with unchanged leaf allocation', arm => {
  inFixture(profile(arm, 'replay'), `
    const guard=await startSourceOnlyDevelopmentGuard(profile,options);
    try {
      await assert.rejects(()=>send(body([{id:1,text:'source'}])),/no request dispatched/);
      guard.sealConstruction();
      assert.equal(calls,0);assert.equal(guard.snapshot().chat_sealed,true);
      assert.equal(guard.snapshot().limits.max_requests,32);
      assert.equal(guard.snapshot().limits.max_usd,${arm === 'C1' ? 5 : 1});
    } finally {guard.restore();}
  `);
});

test.each([
  { formatter: null }, { formatter: 'export const formatCueEvidence=[];' }, { version: 'situation-v3' }, { prompt: 'changed prompt' },
])('v4 missing or mismatched registered preflight fails without inference: %j', options => {
  inFixture(profile(), `
    await assert.rejects(()=>startSourceOnlyDevelopmentGuard(profile,options));
    assert.equal(calls,0);assert.equal(existsSync(options.journalPath),false);
  `, options);
});

test.each([
  'export const formatCueEvidence=(source,includeBridge)=>[{id:1,text:source}];',
  'export const formatCueEvidence=source=>({evidence:[{id:1,text:source}]});',
  'export const formatCueEvidence=(source,includeBridge)=>({excerpts:[],content:JSON.stringify({includeBridge,evidence:[{id:1,text:source.slice(1)}]}),inputTokenCeiling:1,maximumInputTokenCeiling:1});',
  'export const formatCueEvidence=(source,includeBridge)=>({excerpts:[],content:null,inputTokenCeiling:1,maximumInputTokenCeiling:1});',
  'export const formatCueEvidence=(source,includeBridge)=>JSON.stringify({includeBridge,evidence:[{id:1,text:source}]});',
  'export const formatCueEvidence=source=>{throw new Error("synthetic formatter failure");};',
])('v4 refuses a payload when its verified formatter cannot reproduce the claimed complete source', formatter => {
  inFixture(profile(), `
    const guard=await startSourceOnlyDevelopmentGuard(profile,options);
    try {await assert.rejects(()=>send(body([{id:1,text:'source'}])),/no request dispatched/);assert.equal(calls,0);}
    finally {guard.restore();}
  `, { formatter });
});

test('the pinned v4 package formatter and production provider pass through the closed guard with mocked SDK transport', () => {
  const script = `
    import {strict as assert} from 'node:assert';
    import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
    import {tmpdir} from 'node:os';
    import {join} from 'node:path';
    import {createHash} from 'node:crypto';
    import {startSourceOnlyDevelopmentGuard,developmentChatOptions} from './eval/runner/situation-recall-development.ts';
    import {regressionPackageHash} from './eval/runner/situation-recall-provenance.ts';
    import {CUE_SYSTEM_PROMPT,formatCueEvidence} from './node_modules/gbrain/src/core/memory-cues/evidence.ts';
    import {liveMemoryCueProviders} from './node_modules/gbrain/src/core/memory-cues/providers.ts';
    import {MEMORY_CUE_PROMPT_VERSION} from './node_modules/gbrain/src/core/memory-cues/types.ts';
    const gateway=await import('gbrain/ai/gateway');
    const root=mkdtempSync(join(tmpdir(),'actual-v4-guard-'));
    process.env.HOME=root;process.env.GBRAIN_HOME=root;
    const model='openrouter:anthropic/claude-sonnet-4.6';
    const source='I do not take calls before 10.';
    const formatted=formatCueEvidence(source,false);
    const promptHash=createHash('sha256').update(CUE_SYSTEM_PROMPT).digest('hex');
    assert.equal(MEMORY_CUE_PROMPT_VERSION,'situation-v4');
    assert.equal(promptHash,'2756e59d6cd2979f248a98b0bdd48547c2893a86130bca9b3807ca8af619d0ad');
    const p={schema_version:1,kind:'source-only-development',experiment:'longmemeval-m-source-only-dev-v2',question_id:'synthetic-actual-package',attempt_id:'attempt-1',arm:'C1',stage:'construction',
      registration_sha256:'1'.repeat(64),source_manifest_sha256:createHash('sha256').update(source).digest('hex'),
      expected_product_sha:JSON.parse(readFileSync('package.json','utf8')).dependencies.gbrain.split('#')[1],expected_package_sha256:regressionPackageHash('node_modules/gbrain'),
      allocation:{id:'synthetic-no-spend-authorization',usd:1},cue_mode:'on',cue_pipeline_version:'situation-v4',cue_prompt_sha256:promptHash};
    let calls=0;
    globalThis.fetch=async(input,init)=>{
      const request=new Request(input,init);
      assert.equal(request.url,'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(request.headers.get('authorization'),'Bearer synthetic-actual-v4-only');
      const wire=await request.json();calls++;
      assert.equal(wire.model,'anthropic/claude-sonnet-4.6');
      assert.equal(wire.messages[0].content,CUE_SYSTEM_PROMPT);
      assert.equal(wire.messages[1].content,formatted.content);
      assert.equal(wire.max_tokens,1200);assert.equal(wire.temperature,0);
      assert.deepEqual(wire.reasoning,{enabled:false});
      assert.deepEqual(wire.provider,developmentChatOptions(model)[model].provider);
      return Response.json({id:'synthetic-production-provider',object:'chat.completion',created:1,model:wire.model,
        choices:[{index:0,message:{role:'assistant',content:JSON.stringify([{family:'horizon',relation:'explicit_constraint_applies',evidence_ref:1,text:'Scheduling an early meeting'}])},finish_reason:'stop'}],
        usage:{prompt_tokens:100,completion_tokens:15,total_tokens:115,cost:0.000525,is_byok:false}});
    };
    gateway.configureGateway({chat_model:model,provider_chat_options:developmentChatOptions(model),env:{OPENROUTER_API_KEY:'synthetic-actual-v4-only'}});
    const guard=await startSourceOnlyDevelopmentGuard(p,{journalPath:join(root,'requests.ndjson'),verifiedPackagePath:join(process.cwd(),'node_modules/gbrain')});
    try {
      const result=await liveMemoryCueProviders.generate({evidence:source,includeBridge:false,model,signal:AbortSignal.timeout(5000)});
      assert.equal(calls,1);
      assert.deepEqual(result.output,[{family:'horizon',relation:'explicit_constraint_applies',text:'Scheduling an early meeting',quote:source,quoteStart:0}]);
      assert.equal(guard.snapshot().reserved_usd,0);
      assert.equal(guard.snapshot().publishable,false);
    } finally {guard.restore();}
    const old={...p,experiment:'longmemeval-m-source-only-dev-v1',cue_pipeline_version:'situation-v3'};
    await assert.rejects(()=>startSourceOnlyDevelopmentGuard(old,{journalPath:join(root,'old-v3.ndjson'),verifiedPackagePath:join(process.cwd(),'node_modules/gbrain')}),/pipeline or prompt identity mismatch/);
    assert.equal(calls,1);
    rmSync(root,{recursive:true,force:true});
    console.log('ACTUAL_V4_PACKAGE_GUARD_OK');
  `;
  const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', script], {
    cwd: resolve('.'), env: { PATH: process.env.PATH, HOME: '/nonexistent-keyless-home' }, timeout: 30_000,
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString() + child.stdout.toString());
  expect(child.stdout.toString()).toContain('ACTUAL_V4_PACKAGE_GUARD_OK');
}, 35_000);
