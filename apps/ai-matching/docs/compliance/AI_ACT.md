# EU AI Act — Annex III.4 (employment) mapping

The ai-matching service ranks candidates for vacancies — an AI system used for
"recruitment or selection … including screening" and "evaluating candidates"
→ **Annex III.4(a)-(b), high-risk** under Regulation (EU) 2024/1689.

This document maps each high-risk obligation to what this codebase implements
vs what remains procedural/customer-owned. Status legend: ✅ implemented ·
🟡 partial · ⬜ customer/procedural.

## Art. 9 — Risk management system ⬜/🟡

- 🟡 Technical mitigations are in place and tested: scoring is bounded and
  NaN-free (`scoring.combine`), degrades cleanly (`rule_based` fallback),
  prompt-injection defenses (`sanitize.py` + red-team corpus,
  `tests/test_eval_injection.py`), circuit breaker + budget gate on LLM calls.
- ⬜ A documented, continuously-running risk management *process* (risk
  register, review cadence, incident response) is organizational — the docs
  and tests here are the technical evidence feeding it.

## Art. 10 — Data and data governance 🟡

- ✅ Canonical skills taxonomy (`canonical_skills` seed + DB) with explicit
  alias resolution — no fuzzy substring matching that systematically
  (dis)advantages non-standard CV phrasing.
- ✅ Evaluation datasets are versioned by content hash; every eval run records
  `dataset_version`, model/prompt/embedding versions (`evaluation/runner.py`).
- 🟡 Bias examination: four-fifths parity check + proxy-field audit
  (`evaluation/fairness.py`); representative real-data coverage depends on the
  ATS import (`import_ats.py`) once enough decided applications exist.
- ⬜ Data-quality sign-off on *customer* candidate data is the deployer's duty.

## Art. 11 — Technical documentation 🟡

- ✅ This docset (eval README, THREAT_MODEL, GDPR, NYC_LL144) + versioned
  `match_scores` rows + openapi contract.
- ⬜ The formal Annex IV technical file assembles these artifacts; ownership
  is procedural.

## Art. 12 — Record keeping / logging ✅

- ✅ Every persisted score carries model_version, prompt_version,
  embedding_version, source (`rule_based|hybrid|llm_rerank`), subscores and a
  human-readable explanation (`match_scores` table).
- ✅ `evaluation/decision_log.py` exports an audit-ready JSONL/CSV joined with
  the human outcome for a date range.
- ✅ LLM calls logged to `llm_usage` (provider, model, task, tokens, cost,
  correlation id).

## Art. 13 — Transparency / instructions for use ✅/🟡

- ✅ `GET /v1/scores/{cid}/{vid}/explain` returns score + subscores +
  matched/missing skills + red flags for any persisted pair.
- ✅ Source labels disclose when a score is LLM-assisted vs rules-only.
- ⬜ Candidate-facing disclosure wording is the customer's product surface
  (see GDPR.md / NYC_LL144.md).

## Art. 14 — Human oversight ✅/⬜

- ✅ The system **recommends, never auto-rejects**: output is a ranked list
  with explanations; no status mutation exists in this service — applications
  change state only through recruiter action in the monolith
  (`application_status_history` records who/when).
- ✅ Hard-filter exclusions are returned with explicit `reasons` so a human
  can audit/overrule rather than silently dropping candidates.
- ⬜ Training reviewers to recognize automation bias is procedural.

## Art. 15 — Accuracy, robustness, cybersecurity 🟡

- ✅ Accuracy is measured, not assumed: `evaluation/runner.py` reports
  NDCG@k / P@k / R@k / MRR / AUC against baselines (`docs/eval/latest.md`);
  `prompt_regression.py` is a CI gate against ordering regressions.
- ✅ Robustness: deterministic mock-mode tests, injection corpus (15 injected
  CVs, 100% flagged, none boosted), NaN-free scoring.
- 🟡 Accuracy on *customer-specific* populations requires the ATS-imported
  dataset — wire `import_ats.py` into periodic eval once live.
- ⬜ Pen-testing and infrastructure security are organizational.

## Summary

Technical controls for logging, transparency, oversight-enabling APIs and
measured accuracy are implemented and tested here. The AI Act is a
*management system* regulation: risk process, doc assembly, deployer duties
and candidate notices remain customer-owned — this service ships the evidence.
