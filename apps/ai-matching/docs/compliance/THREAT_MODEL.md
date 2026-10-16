# Threat model — CV prompt injection & LLM-adjacent abuse

## Context

The pipeline sends sanitized CV text and compact candidate profiles to an LLM
(`cv_parse`, top-K `rerank`). Resumes are attacker-controlled content:
candidates who know an ATS is AI-assisted have an incentive to embed
instructions that inflate their ranking. Real-world reports put CV injection
attempts at roughly ~1% of applications — rare but real, and cheap to try.

## Assets

- Integrity of the ranking (score ordering must reflect qualifications).
- Confidentiality of the prompt + system internals.
- Fairness: a successful injection is also an integrity/fairness incident
  (unearned advantage over honest candidates).

## Attack surface

| Surface | Entry | Sink |
|---|---|---|
| CV text (direct or via documents-service `document_id`) | `/v1/cv/parse` | `complete_structured` prompt |
| Candidate/vacancy dict fields | `/v1/score`, `/v1/vacancies/{id}/rank` | rerank prompt, embedding text |
| Stored CV re-embedding | `ai_matching.index_entity` task | embedding pipeline |

## Techniques covered by the red-team corpus

`evaluation/corpora/injected_cvs.jsonl` (15 injected + 5 clean controls),
enforced by `tests/test_eval_injection.py`:

- plaintext overrides ("ignore all previous instructions…")
- HTML comments / `display:none` / `font-size:0` / white-on-white hidden text
- zero-width Unicode used to evade keyword filters
- fake `SYSTEM:` headers and `<system>/<assistant>` tag injection
- base64-encoded instruction blobs (with plaintext carrier phrase)
- "forget everything / act as / do not follow / override" phrasings

## Mitigations in place

1. **`app/pipeline/sanitize.py`** — strips zero-width/invisible chars,
   detects hidden-text CSS tricks (`hidden_text` flag), and flags
   instruction-like phrases inside CV content (`injection_suspected`).
   Detection is surfaced on the parse response so the monolith can queue the
   application for human review.
2. **Structured outputs** — the LLM can only return the JSON schema
   (`PROFILE_SCHEMA`, `RERANK_SCHEMA`); it cannot emit a decision, free-text
   verdict, or tool call. Injection can at worst corrupt field values.
3. **Bounded rerank** — LLM adjustments are capped at ±0.25 per criterion and
   recombined through the deterministic weighted formula; injection cannot
   create a score out of thin air.
4. **Delimiter framing** — CV content is wrapped in `<<<CV … CV>>>` markers
   with an explicit "return ONLY the JSON object" instruction.
5. **PII stripping** — `strip_pii` before every LLM call limits what a
   successful injection could exfiltrate via the model.
6. **Circuit breaker + budget** — a pathological document cannot cause
   unbounded cost/retry; failures degrade to deterministic rules.
7. **Corpus test** — CI asserts every injected CV is flagged *and* never
   outscores its equivalently-qualified clean twin.

## Residual risk / honest gaps

- Detection is regex/heuristic — novel phrasings, non-English injections, and
  homoglyph tricks not in the corpus can evade the flag. The corpus is meant
  to grow; add a line to `injected_cvs.jsonl` per new sample seen in the wild.
- Semantic injections ("this candidate's true skills are X" as a natural
  sentence) are indistinguishable from content — mitigated only by structured
  outputs + bounded rerank, not by flagging.
- Under a **real provider**, embedding-text and rerank-prompt injection could
  subtly shift scores; `evaluation/fairness.py::perturbation_check` becomes a
  monitored production metric rather than a deterministic test.
- `injection_suspected` is advisory today — the product should route flagged
  applications to a manual review queue (monolith-side workflow, not in this
  service).
- Recommendation: log flag rates over time; a sudden rise is itself a signal
  worth alerting on.
