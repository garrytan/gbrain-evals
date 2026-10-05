import json, urllib.request
base = 'https://korquad.github.io/dataset/'
paragraphs = []
for name in ['KorQuAD_v1.0_train.json', 'KorQuAD_v1.0_dev.json']:
    data = json.load(urllib.request.urlopen(base + name))
    paragraphs += [p['context'] for a in data['data'] for p in a['paragraphs']]
paragraphs = list(dict.fromkeys(paragraphs))
nsmc = urllib.request.urlopen('https://raw.githubusercontent.com/e9t/nsmc/master/ratings_test.txt').read().decode()
reviews = [line.split('\t')[1] for line in nsmc.splitlines()[1:] if line.count('\t') == 2]
json.dump({'wiki': paragraphs, 'reviews': reviews}, open('corpus.json', 'w'), ensure_ascii=False)
print(len(paragraphs), sum(map(len, paragraphs)), len(reviews), sum(map(len, reviews)))
