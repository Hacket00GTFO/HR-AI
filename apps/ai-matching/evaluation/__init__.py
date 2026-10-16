"""Evaluation, fairness and compliance harness for the ai-matching service.

Offline-first: every entrypoint works against MockProvider with no database.
When DATABASE_URL / SOURCE_DATABASE_URL are reachable, results persist to the
eval_datasets / eval_results tables and ATS outcomes can be imported.

Entrypoints:
    python -m evaluation.runner            — run all baselines, write report
    python -m evaluation.report            — re-render docs/eval/latest.md
    python -m evaluation.prompt_regression — CI gate vs golden NDCG
    python -m evaluation.fairness          — four-fifths + proxy report
    python -m evaluation.import_ats        — build dataset from real ATS data
    python -m evaluation.decision_log      — export audit-ready decision log
"""
