import json,os,urllib.request,concurrent.futures as cf
import sys
ms=[json.loads(x) for x in open(sys.argv[1])]
SYS="""You label Korean text for an entity-mention linker. Each item shows a matched string N in context as before[[N]]after.
Assume the brain holds a person or organization whose name is exactly N. Label each item with one of:
NAME - the highlighted N is used as a name (of a person, organization, place or work) possibly followed by an attached particle (은, 에게, 의 ...).
WORD - N is an ordinary Korean word with the same spelling, standing as its own word (optionally with a particle), e.g. 우리 "we", 지원 "support" as a noun, 하늘 "sky".
INTERNAL - N is only part of a longer word or compound, e.g. 우리나라, 지원하는, 인하여, 한결같이, 지원금.
Reply with JSON {"labels":[...]} with one label per item in order."""
def call(batch):
    items="\n".join(f"{i+1}. {m['before'][-30:]}[[{m['name']}]]{m['after'][:20]}".replace('\n',' ') for i,m in enumerate(batch))
    body=json.dumps({"model":"gpt-6.1-sol","response_format":{"type":"json_object"},"messages":[{"role":"system","content":SYS},{"role":"user","content":items}]}).encode()
    for _ in range(3):
        try:
            r=json.load(urllib.request.urlopen(urllib.request.Request("https://api.openai.com/v1/chat/completions",body,{"Authorization":"Bearer "+os.environ["OPENAI_API_KEY"],"content-type":"application/json"}),timeout=300))
            labs=json.loads(r['choices'][0]['message']['content'])['labels']
            if len(labs)==len(batch): return labs,r['usage']
        except Exception as e: print('retry',e)
    return [None]*len(batch),{}
bs=[ms[i:i+40] for i in range(0,len(ms),40)]
tok=[0,0]
with cf.ThreadPoolExecutor(8) as ex:
    for b,(labs,u) in zip(bs,ex.map(call,bs)):
        for m,l in zip(b,labs): m['label']=l
        tok[0]+=u.get('prompt_tokens',0); tok[1]+=u.get('completion_tokens',0)
json.dump(ms,open(sys.argv[2],'w'),ensure_ascii=False)
print(tok, 'usd~', tok[0]*2e-6+tok[1]*10e-6, 'unlabeled', sum(m['label'] is None for m in ms))
