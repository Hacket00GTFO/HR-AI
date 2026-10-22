# Seed data

Datasets used for AI evaluation, demos and local seeding live here.

Intended contents (not currently committed — see git history / team drive):

- `IT_CV_Dataset.csv` — CV corpus used to evaluate `AI_model/` matchers.
- Generated sample candidates produced by the old `generateSampleData.js` /
  `generateNewCandidates.js` scripts (removed with the legacy layout).

Note: `*.csv` is gitignored repo-wide, but `infra/seed-data/` is explicitly
un-ignored so small, non-sensitive datasets CAN be committed here. Never
commit real candidate data or PII.
