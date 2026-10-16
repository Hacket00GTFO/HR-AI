# GDPR position — Art. 22 & candidate rights

## Art. 22 — automated decision-making

**Position: the system never produces a "decision" in the Art. 22 sense.**

- Output is a *ranked recommendation* with explanations, consumed by a human
  recruiter. No code path in this service changes an application's status;
  `applications.status` transitions happen only through recruiter action in
  the monolith and are recorded in `application_status_history`.
- Hard filters never delete or reject candidates: filtered items are returned
  in `excluded[]` with human-readable `reasons`, keeping the recruiter in the
  loop and able to override.
- The LLM rerank is bounded (±0.25 per criterion) and can only reorder, never
  veto. Under provider failure the system degrades to deterministic rules
  rather than blocking review.

Because a human makes the actual hiring decision and can see *why* each score
was produced, the processing relies on human oversight rather than the Art. 22
exceptions. Customers must not wire the score endpoint into an auto-reject
flow — that would change the legal character of the processing.

## Data protection mechanics implemented here

| Principle | Mechanism |
|---|---|
| Data minimization | `app/pii.py` strips name/email/phone/photo/URLs/IDs before any LLM call; CV parse output is re-scrubbed defensively (`_coerce_profile`). |
| Purpose limitation | Only job-relevant features feed the score (skills, experience, education, text, vector); see `evaluation/fairness.py` static inspection. |
| Storage limitation | Scores are keyed by (candidate, vacancy, model_version, prompt_version); no PII is persisted in `match_scores` beyond foreign ids. |
| Accuracy | Eval harness + prompt regression gate (docs/eval/README.md). |
| Security | CV sanitization vs prompt injection (`sanitize.py`); circuit breaker + budget cap bound external calls. |

## Candidate rights — where they land in the product

| Right | Where it is honored |
|---|---|
| Access (Art. 15) | `GET /v1/scores/{cid}/{vid}/explain` — score, subscores, matched/missing skills, red flags. The monolith/gateway exposes this to the candidate-facing surface. |
| Erasure (Art. 17) | Candidates soft-delete in the monolith (`candidates.deleted_at`); `match_scores`/`embeddings` rows keyed by candidate id are purged with the candidate — no personal data beyond the id is stored here. |
| Objection / human intervention (Art. 21–22) | Human review is the default flow; candidates can contest via the recruiter, and every score is reproducible from the persisted versioned row. |
| Rectification (Art. 16) | CV re-upload re-parses and re-scores; embedding `doc_hash` staleness detection auto-refreshes stored vectors. |

## Records of processing

- `llm_usage` logs every external call (provider/model/task/tokens/cost).
- `evaluation/decision_log.py` produces an audit-ready export of
  score+version+explanation+human-outcome for DPIA evidence or DPA requests.

## Open items (customer-owned)

- Lawful-basis register and retention schedule for CV content (the service
  stores derived features, not the CV itself).
- Candidate-facing privacy notice text and consent flows.
- Sub-processor agreements with the chosen LLM provider (OpenAI/Anthropic).
