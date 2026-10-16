import collections
from evaluation import (dataset, metrics, baselines, runner, fairness,
                        decision_log, import_ats, prompt_regression, report)
print('imports ok')
ds = dataset.generate()
print(len(ds['pairs']), 'pairs', ds['version'])
print(collections.Counter(p['relevance'] for p in ds['pairs']))
print(collections.Counter(t for p in ds['pairs'] for t in p['tags']))
