import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const hasCandidate = Boolean(JSON.parse(readFileSync(resolve('node_modules/gbrain/package.json'), 'utf8')).exports?.['./memory-cues']);

test.skipIf(!hasCandidate)('candidate public durable build uses source-only gateway defaults and invalidates withdrawn or rotated evidence', () => {
  const script = `
    import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const home = mkdtempSync(join(tmpdir(), 'cat36-candidate-'));
    process.env.HOME = home;
    process.env.GBRAIN_HOME = home;
    mkdirSync(join(home, '.gbrain'));
    const model = 'anthropic:claude-haiku-4-5-20251001';
    writeFileSync(join(home,'.gbrain','config.json'), JSON.stringify({engine:'pglite',embedding_model:'openai:text-embedding-3-large',embedding_dimensions:1536,chat_model:model}));
    let network = 0;
    globalThis.fetch = async () => { network++; throw new Error('network prohibited in candidate plumbing'); };
    const { PGLiteEngine } = await import('gbrain/pglite-engine');
    const { importFromContent } = await import('gbrain/import-file');
    const gateway = await import('gbrain/ai/gateway');
    const config = await import('gbrain/config');
    if(config.configPath()!==join(home,'.gbrain','config.json') || config.loadConfig()?.embedding_model!=='openai:text-embedding-3-large') throw new Error('actual file-plane model missing');
    const api = await import('gbrain/memory-cues');
    const { operationsByName } = await import('gbrain/operations');
    const { hybridSearch } = await import('gbrain/search/hybrid');
    const { buildProductionCueIndex } = await import('./eval/runner/cat36-production.ts');
    const { offlineCat36Profile } = await import('./eval/runner/cat36-associative-retrieval.ts');
    const vector = () => { const v = new Array(1536).fill(0); v[0] = 1; return v; };
    let generated = 0, embedded = 0;
    const phrase = 'I do not take calls before 10.';
    gateway.configureGateway({embedding_model:'openai:text-embedding-3-large',embedding_dimensions:1536,chat_model:model,env:{OPENAI_API_KEY:'test-fixture-not-a-key'}});
    gateway.__setChatTransportForTests(async options => {
      generated++;
      const payload = JSON.stringify(options);
      if(payload.includes('FUTURE_QUERY_SENTINEL') || payload.includes('required_span_ids')) throw new Error('query/gold leakage');
      if(!payload.includes(phrase)) throw new Error('source evidence missing');
      const input=JSON.parse(String(options.messages[0].content));
      const excerpt=input.evidence.find(value=>value.text.includes(phrase));
      if(input.includeBridge!==false || !excerpt) throw new Error('source-selected evidence missing');
      return {text:JSON.stringify({scene:null,association_1:{kind:'horizon:explicit_constraint_applies',evidence_ref:excerpt.id,text:'Scheduling an early meeting'},association_2:null,association_3:null}),
        blocks:[],stopReason:'end',usage:{input_tokens:20,output_tokens:20,cache_read_tokens:0,cache_creation_tokens:0},model:options.model,providerId:'anthropic'};
    });
    gateway.__setEmbedTransportForTests(async ({values}) => { embedded++; return {values,embeddings:values.map(vector),usage:{tokens:20},warnings:[],response:{headers:{}}}; });
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      for(let i=0;i<9;i++) await importFromContent(engine,'notes/cue-'+i,'---\\ntype: note\\ntitle: Scheduling log '+i+'\\n---\\n\\n'+phrase+' Log entry '+i+'.',{noEmbed:true});
      const profile = {...offlineCat36Profile(),mode:'live',arm:'C1',expected_product_sha:'a'.repeat(40),generation_model:model,build_max_usd:5,cue_min_similarity:0.5,
        provider_budget:{kind:'isolated-provider-cap',approval_id:'unit-test-not-live-admission',max_usd:5}};
      for(const [key,value] of Object.entries(profile.search_config)) await engine.setConfig(key,value);
      await engine.setConfig('embedding_model',profile.embedding_model);
      await engine.setConfig('embedding_dimensions',String(profile.embedding_dimensions));
      const build = await buildProductionCueIndex(engine,['default'],profile);
      if(!build.complete || !build.observed || generated!==9 || build.receipt.generated!==9) throw new Error(JSON.stringify(build));
      if(build.receipt.passes.length!==2 || build.receipt.passes[0].status!=='partial') throw new Error('bounded passes not exercised');
      const before = await engine.executeRaw('SELECT id FROM memory_cue_windows ORDER BY id');
      const context = {engine,config:{engine:'pglite'},sourceId:'default',remote:false,dryRun:false,logger:{info(){},warn(){},error(){}}};
      await operationsByName.memory_cues.handler(context,{action:'configure',families:['scene'],generation_enabled:false,apply:true});
      const scene = await api.recallMemoryCues(engine,new Float32Array(vector()),{embeddingColumn:await api.memoryCueColumn(engine),limit:20,minSimilarity:0.5});
      if(scene.candidates.length) throw new Error('Scene selection leaked Horizon cues');
      await operationsByName.memory_cues.handler(context,{action:'configure',families:['horizon'],apply:true});
      const horizon = await api.recallMemoryCues(engine,new Float32Array(vector()),{embeddingColumn:await api.memoryCueColumn(engine),limit:20,minSimilarity:0.5});
      if(!horizon.candidates.length || generated!==9 || JSON.stringify(before)!==JSON.stringify(await engine.executeRaw('SELECT id FROM memory_cue_windows ORDER BY id'))) throw new Error('read-time ablation changed construction');
      let rejectedAccumulation=false;
      try { await buildProductionCueIndex(engine,['default'],{...profile,arm:'scene-horizon-bridge'}); }
      catch(error) { rejectedAccumulation=String(error).includes('fresh index'); }
      if(!rejectedAccumulation || generated!==9) throw new Error('Bridge accumulated onto C1 construction');
      let meta;
      const results = await hybridSearch(engine,'FUTURE_QUERY_SENTINEL scheduling an early meeting',{limit:5,tokenBudget:4096,recencyBoost:0,onMeta:value=>{meta=value;}});
      if(results.length>5 || !results.length || meta?.memory_cues?.mode!=='on' || meta.memory_cues.admitted<1) throw new Error(JSON.stringify({results,meta}));
      if(results.some(row=>!row.chunk_text.includes(phrase) || row.chunk_text.includes('Scheduling an early meeting'))) throw new Error('cue serialized as source');
      const originalColumn = await api.memoryCueColumn(engine);
      await engine.softDeletePage('notes/cue-0',{sourceId:'default'});
      const afterDelete = await api.recallMemoryCues(engine,new Float32Array(vector()),{embeddingColumn:originalColumn,limit:20,minSimilarity:0.5});
      if(afterDelete.candidates.some(row=>row.result.slug==='notes/cue-0')) throw new Error('withdrawn evidence returned');
      await engine.setConfig('embedding_columns',JSON.stringify({embedding:{provider:'openai:text-embedding-3-small',dimensions:1536,type:'vector'}}));
      gateway.configureGateway({embedding_model:'openai:text-embedding-3-small',embedding_dimensions:1536,chat_model:model,env:{OPENAI_API_KEY:'test-fixture-not-a-key'}});
      const rotated = await api.memoryCueColumn(engine);
      if(rotated.embeddingModel===originalColumn.embeddingModel || rotated.embeddingModel!=='openai:text-embedding-3-small') throw new Error('actual descriptor did not rotate');
      const stale = await api.recallMemoryCues(engine,new Float32Array(vector()),{embeddingColumn:rotated,limit:20,minSimilarity:0.5});
      if(stale.candidates.length) throw new Error('old-space cues survived model rotation');
      console.log('CAT36_CANDIDATE='+JSON.stringify({plumbing_only:true,publishable:false,network,generated,embedded,passes:build.receipt.passes.length,returned:results.length,
        read_only_ablations:true,rejected_accumulation:rejectedAccumulation,prompt_version:build.receipt.prompt_version,original_column:originalColumn,rotated_column:rotated}));
    } finally { await engine.disconnect(); gateway.__setChatTransportForTests(null); gateway.__setEmbedTransportForTests(null); rmSync(home,{recursive:true,force:true}); }
  `;
  const result = Bun.spawnSync(['bun', '-e', script], { cwd: resolve('.'), timeout: 120_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() + result.stdout.toString());
  const line = result.stdout.toString().split('\n').find(value => value.startsWith('CAT36_CANDIDATE='));
  expect(line).toBeDefined();
  const evidence = JSON.parse(line!.slice('CAT36_CANDIDATE='.length));
  expect(evidence.network).toBe(0);
  expect(evidence.publishable).toBe(false);
  expect(evidence.generated).toBe(9);
  expect(evidence.passes).toBe(2);
  expect(evidence.original_column.embeddingModel).not.toBe(evidence.rotated_column.embeddingModel);
  expect(evidence.read_only_ablations).toBe(true);
  expect(evidence.rejected_accumulation).toBe(true);
}, 130_000);

test.skipIf(!hasCandidate)('candidate summary control executes the public real synopsis service without mutating source text', () => {
  const script = `
    import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
    import { join } from 'node:path';
    import { tmpdir } from 'node:os';
    const home=mkdtempSync(join(tmpdir(),'cat36-summary-'));
    process.env.HOME=home;process.env.GBRAIN_HOME=home;mkdirSync(join(home,'.gbrain'));
    const model='anthropic:claude-haiku-4-5-20251001';
    writeFileSync(join(home,'.gbrain','config.json'),JSON.stringify({engine:'pglite',embedding_model:'openai:text-embedding-3-large',embedding_dimensions:1536,chat_model:model}));
    let network=0,summaryCalls=0;
    globalThis.fetch=async()=>{network++;throw new Error('network forbidden');};
    const {PGLiteEngine}=await import('gbrain/pglite-engine');
    const {importFromContent}=await import('gbrain/import-file');
    const gateway=await import('gbrain/ai/gateway');
    const {buildProductionSummaryIndex,cat36RuntimeSourceId}=await import('./eval/runner/cat36-production.ts');
    const {offlineCat36Profile}=await import('./eval/runner/cat36-associative-retrieval.ts');
    gateway.configureGateway({embedding_model:'openai:text-embedding-3-large',embedding_dimensions:1536,chat_model:model,env:{OPENAI_API_KEY:'test-fixture-not-a-key'}});
    gateway.__setChatTransportForTests(async options=>{summaryCalls++;if(JSON.stringify(options).includes('FUTURE_QUERY_SENTINEL'))throw new Error('query leaked');return {text:'This note records the explicit restriction against taking calls before ten.',blocks:[],stopReason:'end',model:options.model,providerId:'anthropic',usage:{input_tokens:20,output_tokens:20,cache_read_tokens:0,cache_creation_tokens:0}};});
    gateway.__setEmbedTransportForTests(async({values})=>({values,embeddings:values.map(()=>{const v=new Array(1536).fill(0);v[0]=1;return v;}),usage:{tokens:20},warnings:[],response:{headers:{}}}));
    const engine=new PGLiteEngine();await engine.connect({});await engine.initSchema();
    try {
      const source={source_id:'summary-fixture',slug:'notes/summary',title:'Scheduling note',text:'I do not take calls before 10.',visibility:'public',created_at:'2025-01-01T00:00:00.000Z',updated_at:'2025-01-02T00:00:00.000Z'};
      const id=cat36RuntimeSourceId(source.source_id);
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES($1,$1)",[id]);
      await importFromContent(engine,source.slug,'---\\ntype: note\\ntitle: Scheduling note\\n---\\n\\n'+source.text,{sourceId:id,noEmbed:true});
      const profile={...offlineCat36Profile(),mode:'live',arm:'summary',expected_product_sha:'a'.repeat(40),generation_model:model,build_max_usd:1,provider_budget:{kind:'isolated-provider-cap',approval_id:'unit-test-not-live-admission',max_usd:1}};
      profile.search_config['search.contextual_retrieval']='per_chunk_synopsis';
      const result=await buildProductionSummaryIndex(engine,[source],profile);
      if(!result.complete||!result.observed||summaryCalls!==1||result.receipt.generated_chunks!==1)throw new Error(JSON.stringify(result));
      const page=await engine.getPage(source.slug,{sourceId:id});
      const chunks=await engine.getChunks(source.slug,{sourceId:id});
      if(page.compiled_truth.trim()!==source.text||chunks.some(c=>c.chunk_text!==source.text))throw new Error('summary overwrote original source');
      console.log('CAT36_SUMMARY='+JSON.stringify({network,summaryCalls,publishable:false,kind:result.receipt.results[0].result.kind,mode:result.receipt.results[0].result.mode_applied}));
    } finally {await engine.disconnect();gateway.__setChatTransportForTests(null);gateway.__setEmbedTransportForTests(null);rmSync(home,{recursive:true,force:true});}
  `;
  const child = Bun.spawnSync(['bun', '-e', script], { cwd: resolve('.'), timeout: 90_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString() + child.stdout.toString());
  const line = child.stdout.toString().split('\n').find(value => value.startsWith('CAT36_SUMMARY='));
  expect(line).toBeDefined();
  expect(JSON.parse(line!.slice('CAT36_SUMMARY='.length))).toEqual({ network: 0, summaryCalls: 1, publishable: false, kind: 'success', mode: 'per_chunk_synopsis' });
}, 100_000);
