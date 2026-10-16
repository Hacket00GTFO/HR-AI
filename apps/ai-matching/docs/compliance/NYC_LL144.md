# NYC Local Law 144 — AEDT checklist

NYC LL144 regulates Automated Employment Decision Tools used to screen
candidates for jobs located in NYC. The service is an AEDT when used for
NYC-located roles; obligations split between vendor (us) and employer
(customer). This is the working checklist.

## Annual bias audit (customer-commissioned, we supply the tooling)

- [ ] Independent auditor selected by the employer/customer.
- [ ] Audit computes **selection rates and impact ratios per protected group**
  (sex, race/ethnicity, and intersections) against the most-selected group —
  `evaluation/fairness.py::four_fifths_report` produces exactly this table
  (selection = top-k or score ≥ threshold, both supported).
- [ ] Source data: scored pairs + outcomes exported via
  `python -m evaluation.decision_log --since ... --out audit.jsonl`.
- [ ] Protected-attribute data comes from the customer's EEOC self-ID flow —
  this service never infers or stores it (verified by
  `evaluation/fairness.py::accessed_candidate_fields` — no protected field is
  read by the scorer, and `app/pii.py` strips identifiers before any LLM call).
- [ ] Audit published on the employer's website; `docs/eval/fairness.md` is
  the internal evidence draft.

## Candidate notification (≥10 business days before use — customer-owned)

- [ ] Notice that an AEDT is used in screening.
- [ ] The **job qualifications and characteristics** the tool assesses —
  provided by the explain API: canonical skills matched/missing, experience
  fit, education level, text relevance (`match_scores.explanation`).
- [ ] Data type, source, and retention policy for the AEDT.
- [ ] Instructions to request an alternative selection process or accommodation.

## What this repo provides vs. what remains the customer's

| Obligation | Owner | Artifact |
|---|---|---|
| Impact-ratio computation | us (tooling) | `evaluation/fairness.py` |
| Representative audit dataset | shared | `decision_log.py` export + customer EEOC data |
| Proxy discrimination check | us | `fairness.py::perturbation_check` / `proxy` audit |
| Publish audit results | customer | — |
| 10-day candidate notice | customer | explain API supplies the "characteristics" content |
| Alternative process on request | customer | ranking is advisory; recruiters can always bypass |

## Notes

- LL144's "selection rate" math requires a defined selection threshold —
  configure via score ≥ T or top-k; both are supported by the report
  functions (rows take a `selected` bool).
- The audit must rerun **annually** and after material model/prompt changes —
  model_version/prompt_version on every `match_scores` row makes scope clear.
