# Evaluation harness

Offline-first evaluation of the candidate↔vacancy matching pipeline. Everything
runs deterministically under `MockProvider` — no API keys, no database required
(persistence to `eval_results` is optional and best-effort).

## Layout

```
evaluation/
  dataset.py           synthetic labeled dataset (~182 pairs, 6 job families)
  import_ats.py        derive labels from real application outcomes (SOURCE_DATABASE_URL)
  metrics.py           precision@k / recall@k / ndcg@k / mrr / auc (pure, unit-tested)
  baselines.py         legacy_heuristic, bm25_filters, hybrid_no_llm, full_pipeline
  runner.py            scores a callable over the dataset, macro-averages metrics
  report.py            renders docs/eval/latest.md
  prompt_regression.py CI gate: ordering regression vs recorded golden NDCG
  fairness.py          four-fifths impact ratio + proxy/perturbation checks
  decision_log.py      audit-ready export of match_scores + human outcome
  corpora/             injected_cvs.jsonl, regression_pairs.jsonl
  golden/              ndcg_baseline.json (recorded reference run)
```

## Quick start (container — there is no local python)

```sh
docker run --rm -v "$PWD/apps/ai-matching:/app" -w /app python:3.12-slim sh -c \
  "pip install -q -r requirements.txt -r requirements-dev.txt && \
   python -m evaluation.runner"            # all 4 baselines → docs/eval/latest.md
```

Individual pieces:

```sh
python -m evaluation.runner --scorer full_pipeline --persist   # needs DATABASE_URL
python -m evaluation.dataset --out data.jsonl --seed 13        # regenerate dataset
python -m evaluation.prompt_regression                         # CI gate (exit≠0 on drop)
python -m evaluation.fairness --out docs/eval/fairness.md      # parity + proxy report
python -m evaluation.decision_log --since 2026-01-01 --out decisions.jsonl
SOURCE_DATABASE_URL=postgres://... python -m evaluation.import_ats --out ats.jsonl
python -m evaluation.runner --dataset ats.jsonl                # evaluate on real outcomes
```

## Dataset design

- 26 vacancies across backend / frontend / data / devops / design / PM,
  7 candidates each (~182 pairs). Fully deterministic from `--seed`.
- Labels 0–3 are computed from **intended** skill overlap + experience fit +
  location, before surface rendering — so noisy pairs measure resolver
  robustness rather than being self-fulfilling.
- Archetypes per vacancy: `strong`, `good`, `weak`, `irrelevant`,
  `hard_neg_seniority` (right stack, far too junior), `hard_neg_stack`
  (right seniority, wrong stack) or `hard_neg_location` for entry roles,
  and `noisy` (≥20 pairs render skills as aliases or misspellings like
  `pythn` / `Postgres` / `k8s`).

## Baselines

| scorer | what it is |
|---|---|
| `legacy_heuristic` | bug-for-bug port of `AI_model/CandidateMatcher.js` @99c0516 — substring skills, entry-level auto-pass, constant-0.5 education, naive keyword overlap |
| `bm25_filters` | hard filters + BM25-lite text retrieval only |
| `hybrid_no_llm` | `score_pair` on every pair — canonical skills + experience + education + text + embeddings |
| `full_pipeline` | `rank_candidates` — production path incl. LLM rerank (deterministic no-op under MockProvider) |

## Reading the numbers

- Metrics are macro-averaged per query; a metric is `null` when undefined
  (e.g. recall on a query with no relevant candidates).
- **Known bias:** synthetic labels are built from skill overlap, which
  structurally favors lexical matchers. The gap between `full_pipeline` and
  `bm25_filters` understates the real-world delta; the ATS-imported dataset
  (`import_ats.py`) is the unbiased check once outcomes accumulate.
- Under `MockProvider`, `full_pipeline ≈ hybrid_no_llm` (rerank is a no-op and
  embeddings are pseudo-random); their near-equality is a sanity check, not a
  claim about LLM rerank value — rerun against a real provider for that.

## CI gates

- `pytest tests/` — includes metric unit tests, dataset determinism, the
  injection corpus, perturbation invariance.
- `python -m evaluation.prompt_regression` — exits 1 when NDCG@5 on the
  curated suite drops >2% relative to `golden/ndcg_baseline.json`
  (re-bless with `--record` after intentional prompt/model changes).
- `POST /v1/eval/run` — in-service smoke check for one scorer, emits
  `strafor.matching.eval_run_completed`.
