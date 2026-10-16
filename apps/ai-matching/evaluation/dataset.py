"""Labeled candidate↔vacancy pair dataset.

Two sources:
- `generate(seed)` — deterministic synthetic dataset (~180 pairs) across six
  job families. Ground-truth relevance (0=irrelevant .. 3=strong) is computed
  from *intended* skill overlap + experience fit + location rules BEFORE any
  surface rendering (aliases/misspellings), so noisy pairs measure resolver
  robustness honestly.
- `import_ats` (separate module) — derives labels from real application
  outcomes when SOURCE_DATABASE_URL is reachable.

Dataset shape:
    {
      'name': str, 'seed': int, 'version': str,   # version = content hash
      'pairs': [{
          'id', 'query_id', 'family',
          'vacancy': {...}, 'candidate': {...},
          'relevance': 0..3, 'tags': [...],
          'intended_skills': [...],   # pre-noise canonical intent
      }]
    }

CLI: python -m evaluation.dataset --out path.jsonl [--seed 13]
     [--queries 26] [--per-query 7]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
from pathlib import Path

# ---------------------------------------------------------------------------
# job families — pools are canonical names from seeds/skills_seed.json
# ---------------------------------------------------------------------------

FAMILIES: dict[str, dict] = {
    'backend': {
        'titles': ['Backend Engineer', 'API Developer', 'Server-Side Engineer'],
        'pools': [
            ['python', 'java', 'go', 'nodejs'],
            ['django', 'fastapi', 'spring', 'express', 'nestjs'],
            ['postgresql', 'mysql', 'redis', 'mongodb'],
            ['rest', 'docker', 'microservices', 'api-design', 'graphql', 'rabbitmq'],
        ],
    },
    'frontend': {
        'titles': ['Frontend Engineer', 'UI Developer', 'Web Developer'],
        'pools': [
            ['javascript', 'typescript'],
            ['react', 'angular', 'vue', 'nextjs'],
            ['html', 'css', 'tailwind'],
            ['jest', 'cypress', 'webpack', 'vite', 'redux'],
        ],
    },
    'data': {
        'titles': ['Data Engineer', 'ML Engineer', 'Analytics Engineer'],
        'pools': [
            ['python', 'sql'],
            ['pandas', 'spark', 'airflow', 'dbt', 'etl'],
            ['machine-learning', 'data-analysis', 'data-engineering', 'nlp'],
            ['postgresql', 'bigquery', 'snowflake', 'tableau'],
        ],
    },
    'devops': {
        'titles': ['DevOps Engineer', 'SRE', 'Platform Engineer'],
        'pools': [
            ['aws', 'azure', 'gcp'],
            ['docker', 'kubernetes', 'terraform', 'ansible'],
            ['ci-cd', 'jenkins', 'github-actions', 'gitlab-ci'],
            ['linux', 'nginx', 'prometheus', 'grafana'],
        ],
    },
    'design': {
        'titles': ['Product Designer', 'UX Designer', 'UI Designer'],
        'pools': [
            ['figma', 'ui-ux'],
            ['accessibility', 'i18n'],
            ['seo', 'communication'],
            ['html', 'css', 'wordpress'],
        ],
    },
    'pm': {
        'titles': ['Product Manager', 'Project Manager', 'Delivery Manager'],
        'pools': [
            ['product-management', 'project-management'],
            ['agile', 'scrum', 'kanban'],
            ['jira', 'confluence'],
            ['communication', 'leadership', 'recruiting'],
        ],
    },
}

LEVELS = [  # (vacancy experience_level string, required years)
    ('Entry Level', 0), ('Mid Level', 3), ('Senior Level', 5),
]
EDU_REQS = [None, 'Bachelor', 'Bachelor', 'Master']  # weighted pick
EDU_FOR_YEARS = [
    (0, 'High school diploma'), (2, 'Bachelor degree in Computer Science'),
    (4, 'Bachelor degree'), (6, 'Master degree'), (9, 'Master degree'), (12, 'PhD'),
]
CITIES = ['San Jose, CR', 'San Jose, CR', 'Heredia, CR', 'Alajuela, CR',
          'Cartago, CR', 'San Jose, CR', 'Remote']
FAR_CITIES = ['Berlin, DE', 'Toronto, CA', 'Tokyo, JP']

# resolvable aliases (taxonomy resolves them) and deliberate misspellings
ALIASES = {
    'python': ['Python 3', 'py'], 'react': ['React.js', 'ReactJS'],
    'kubernetes': ['k8s'], 'postgresql': ['Postgres', 'psql'],
    'javascript': ['JS', 'ES6'], 'typescript': ['TS'],
    'docker': ['Docker Engine'], 'aws': ['Amazon Web Services'],
    'go': ['Golang'], 'nodejs': ['Node.js'], 'express': ['Express.js'],
    'django': ['Django Framework'], 'vue': ['Vue.js'], 'angular': ['AngularJS'],
    'sql': ['T-SQL'], 'machine-learning': ['ML'], 'ci-cd': ['CI/CD'],
    'ui-ux': ['UX design'], 'spring': ['Spring Boot'], 'mongodb': ['Mongo'],
    'scikit-learn': ['sklearn'], 'pytorch': ['torch'],
    'terraform': ['HashiCorp Terraform'], 'github-actions': ['GitHub Actions'],
    'gcp': ['Google Cloud'], 'mysql': ['MariaDB'], 'nextjs': ['Next.js'],
    'rest': ['REST API'], 'figma': ['Figma'], 'agile': ['Agile methodology'],
    'jira': ['Jira'], 'linux': ['GNU/Linux'], 'spark': ['Apache Spark'],
    'airflow': ['Apache Airflow'], 'redis': ['Redis'], 'html': ['HTML5'],
    'css': ['CSS3'], 'fastapi': ['Fast API'], 'microservices': ['micro services'],
}
MISSPELLINGS = {
    'python': 'pythn', 'javascript': 'javascrip', 'postgresql': 'postgre',
    'docker': 'dockr', 'kubernetes': 'kubernets', 'typescript': 'typscript',
    'django': 'djngo', 'terraform': 'terrafrm', 'fastapi': 'fastpi',
    'spark': 'spak', 'figma': 'fimga', 'react': 'raect', 'nodejs': 'nodsj',
    'kubernetes2': 'unused', 'pandas': 'pands', 'airflow': 'airfow',
    'mongodb': 'mongdb', 'graphql': 'graphq', 'jenkins': 'jenkis',
    'scrum': 'scrm', 'agile': 'agle',
}

NAMES_A = ['Maria Garcia', 'Sofia Chen', 'Ana Rodriguez', 'Priya Patel', 'Lena Fischer']
NAMES_B = ['John Smith', 'Carlos Mora', 'James Wilson', 'Ahmed Hassan', 'Tom Becker']

_ARCHETYPES = [
    'strong', 'good', 'weak', 'irrelevant',
    'hard_neg_seniority', 'hard_neg_stack', 'noisy',
]


# ---------------------------------------------------------------------------
# relevance rule — computed on INTENT (canonical skills before surface noise)
# ---------------------------------------------------------------------------

def _exp_fit(cand_years: float, req_years: float) -> float:
    gap = req_years - cand_years
    if gap <= 0:
        return 1.0
    if gap <= 2:
        return 0.6
    if gap <= 4:
        return 0.3
    return 0.1


def relevance_label(intended: list[str], required: list[str],
                    cand_years: float, req_years: float, location_ok: bool,
                    salary_ok: bool = True) -> int:
    """0-3 graded relevance from skill overlap + experience fit + location.
    A pair a hard filter would reject is irrelevant by definition (0)."""
    if not location_ok or not salary_ok:
        return 0
    frac = len(set(intended) & set(required)) / max(len(required), 1)
    fit = _exp_fit(cand_years, req_years)
    if frac >= 0.8 and fit >= 1.0:
        return 3
    if frac >= 0.5 and fit >= 0.6:
        return 2
    if frac >= 0.3 or (frac >= 0.15 and fit >= 0.6):
        return 1
    return 0


# ---------------------------------------------------------------------------
# generation helpers
# ---------------------------------------------------------------------------

def _pick_required(rng: random.Random, pools: list[list[str]]) -> list[str]:
    """4-6 required skills: one per pool + occasional extras."""
    required: list[str] = []
    for pool in pools:
        n = 1 if rng.random() < 0.75 else 2
        required.extend(rng.sample(pool, min(n, len(pool))))
    if rng.random() < 0.4:
        extra = rng.choice(pools[-1])
        if extra not in required:
            required.append(extra)
    return required[:6]


def _education_for(rng: random.Random, years: float) -> str:
    options = [e for cutoff, e in EDU_FOR_YEARS if years >= cutoff] or ['High school diploma']
    return rng.choice(options)


def _location_ok(vacancy: dict, cand_loc: str, cand_remote_pref: str | None) -> bool:
    remote_ok = bool(vacancy.get('remote_option'))
    if not remote_ok and (cand_remote_pref or '').lower() in ('remote', 'remote_only', 'remote-only'):
        return False
    v_city = (vacancy.get('location') or '').split(',')[0].strip().lower()
    c_city = (cand_loc or '').split(',')[0].strip().lower()
    if remote_ok or not v_city or not c_city:
        return True
    return v_city == c_city


def _candidate_text(family_title: str, years: float, surface_skills: list[str],
                    extra_words: list[str] | None = None) -> str:
    """Free-text profile: role words + ~half the surface skill forms so the
    text feature carries real signal without duplicating the skills field."""
    shown = surface_skills[: max(1, len(surface_skills) // 2)]
    words = ' '.join(extra_words or [])
    return (f'{family_title} with {int(years)} years of experience. '
            f'Worked with {", ".join(shown)}. {words}'.strip())


def _render_noisy(rng: random.Random, intended: list[str]) -> tuple[list[str], int]:
    """Render intended canonical skills as surface strings: ~45% alias,
    ~35% misspelling (when defined), rest as-is. Always ≥1 misspelling."""
    surface: list[str] = []
    miss = 0
    for s in intended:
        r = rng.random()
        if r < 0.35 and s in MISSPELLINGS:
            surface.append(MISSPELLINGS[s])
            miss += 1
        elif r < 0.8 and s in ALIASES:
            surface.append(rng.choice(ALIASES[s]))
        else:
            surface.append(s)
    if miss == 0:
        fixable = [i for i, s in enumerate(intended) if s in MISSPELLINGS]
        if fixable:
            i = rng.choice(fixable)
            surface[i] = MISSPELLINGS[intended[i]]
        else:
            # families without a defined misspelling get a generic truncation
            # ('kanban' -> 'kanba') — guaranteed unresolvable.
            i = rng.randrange(len(intended))
            surface[i] = intended[i][:-1] or intended[i]
        miss += 1
    return surface, miss


# ---------------------------------------------------------------------------
# the generator
# ---------------------------------------------------------------------------

def generate(seed: int = 13, n_queries: int = 26, per_query: int = 7,
             name: str = 'synthetic-v1') -> dict:
    """Deterministic synthetic dataset. `per_query` is currently fixed at 7
    (one candidate per archetype); other values raise."""
    if per_query != len(_ARCHETYPES):
        raise ValueError(f'per_query must be {len(_ARCHETYPES)} (one per archetype)')
    rng = random.Random(seed)
    pairs: list[dict] = []
    family_names = list(FAMILIES)
    pair_id = 0

    for qi in range(n_queries):
        family = family_names[qi % len(family_names)]
        spec = FAMILIES[family]
        title = rng.choice(spec['titles'])
        required = _pick_required(rng, spec['pools'])
        level, req_years = rng.choice(LEVELS)
        edu_req = rng.choice(EDU_REQS)
        remote_ok = rng.random() < 0.45
        v_loc = 'Remote' if remote_ok else rng.choice(CITIES[:-1])
        salary_max = {0: 45000, 3: 80000, 5: 120000}[req_years]
        vacancy = {
            'id': 1000 + qi,
            'title': title,
            'description': (
                f'{title} on the {family} team. '
                f'We need {", ".join(required)}. '
                f'{level} role.'
            ),
            'requirements': (
                f'{", ".join(required)}. {level}.'
                + (f' {edu_req} degree required.' if edu_req else '')
            ),
            'skills_required': list(required),
            'experience_level': level,
            'min_experience_years': req_years,
            'location': v_loc,
            'remote_option': remote_ok,
            'salary_max': salary_max,
        }
        if edu_req:
            vacancy['education'] = edu_req

        wrong_family = family_names[(qi + 1 + rng.randrange(len(family_names) - 1)) % len(family_names)]
        wrong_pool = [s for pool in FAMILIES[wrong_family]['pools'] for s in pool]

        for archetype in _ARCHETYPES:
            pair_id += 1
            tags = [archetype]
            cand_years = float(req_years)
            salary = salary_max * rng.uniform(0.7, 1.0)
            c_loc = v_loc if not remote_ok else rng.choice(CITIES)
            remote_pref = None
            intended: list[str]
            surface: list[str]

            if archetype == 'strong':
                intended = required + rng.sample(
                    [s for pool in spec['pools'] for s in pool if s not in required], 1)
                cand_years = req_years + rng.uniform(0, 3)
            elif archetype == 'good':
                keep = max(1, round(len(required) * rng.uniform(0.55, 0.75)))
                intended = rng.sample(required, keep)
                cand_years = max(0.0, req_years - rng.uniform(0, 1))
            elif archetype == 'weak':
                keep = max(1, round(len(required) * 0.34))
                intended = rng.sample(required, keep)
                cand_years = max(0.0, req_years - rng.uniform(0, 2))
            elif archetype == 'irrelevant':
                intended = rng.sample(wrong_pool, min(4, len(wrong_pool)))
                cand_years = rng.uniform(0, 8)
            elif archetype == 'hard_neg_seniority':
                if req_years == 0:
                    # entry role: near-miss becomes "perfect fit, wrong city"
                    intended = list(required)
                    cand_years = rng.uniform(2, 6)
                    c_loc = rng.choice(FAR_CITIES)
                    tags = ['hard_neg_location']
                else:
                    intended = list(required)
                    cand_years = max(0.0, req_years - rng.uniform(4, 6))
            elif archetype == 'hard_neg_stack':
                # right seniority, wrong stack (adjacent family, some generic overlap possible)
                adjacent = family_names[(qi + 1) % len(family_names)]
                adj_pool = [s for pool in FAMILIES[adjacent]['pools'] for s in pool]
                intended = rng.sample(adj_pool, min(4, len(adj_pool)))
                cand_years = float(req_years)
            else:  # noisy
                keep = max(1, round(len(required) * rng.uniform(0.6, 0.8)))
                intended = rng.sample(required, keep)
                cand_years = req_years + rng.uniform(0, 2)

            # occasionally a remote-only candidate for on-site roles, and an
            # overpriced expectation — more ways to land at relevance 0.
            if archetype == 'irrelevant' and not remote_ok and rng.random() < 0.4:
                remote_pref = 'remote_only'
            if archetype == 'weak' and rng.random() < 0.25:
                salary = salary_max * 1.4
                tags.append('overpriced')

            if archetype == 'noisy':
                surface, n_miss = _render_noisy(rng, intended)
                if n_miss:
                    tags.append('misspelled')
            else:
                surface = list(intended)

            loc_ok = _location_ok(vacancy, c_loc, remote_pref)
            salary_ok = salary <= salary_max * 1.15  # mirrors hard_filter_reasons
            rel = relevance_label(intended, required, cand_years, req_years,
                                  loc_ok, salary_ok)

            fam_title = spec['titles'][0] if archetype != 'irrelevant' else FAMILIES[wrong_family]['titles'][0]
            if archetype == 'hard_neg_stack':
                fam_title = FAMILIES[family_names[(qi + 1) % len(family_names)]]['titles'][0]

            candidate = {
                'id': 5000 + pair_id,
                'name': rng.choice(NAMES_A if rng.random() < 0.5 else NAMES_B),
                'group': 'a' if rng.random() < 0.5 else 'b',  # synthetic cohort for fairness checks
                'skills': surface,
                'experience': round(cand_years),
                'education': _education_for(rng, cand_years),
                'location': c_loc,
                'expected_salary': round(salary),
                'summary': _candidate_text(fam_title, cand_years, surface),
            }
            if remote_pref:
                candidate['remote_preference'] = remote_pref

            pairs.append({
                'id': pair_id,
                'query_id': vacancy['id'],
                'family': family,
                'vacancy': vacancy,
                'candidate': candidate,
                'relevance': rel,
                'tags': tags,
                'intended_skills': intended,
            })

    ds = {'name': name, 'seed': seed, 'pairs': pairs}
    ds['version'] = dataset_version(ds)
    return ds


# ---------------------------------------------------------------------------
# IO
# ---------------------------------------------------------------------------

def dataset_version(ds: dict) -> str:
    """Content hash over the pairs — the dataset version recorded on runs."""
    blob = json.dumps(ds.get('pairs', []), sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def write_jsonl(ds: dict, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(json.dumps({'_meta': {k: ds[k] for k in ('name', 'seed', 'version') if k in ds}}) + '\n')
        for pair in ds['pairs']:
            fh.write(json.dumps(pair, default=str) + '\n')
    return path


def load_jsonl(path: str | Path) -> dict:
    pairs, meta = [], {}
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if '_meta' in obj:
                meta = obj['_meta']
            else:
                pairs.append(obj)
    ds = {'name': meta.get('name', Path(path).stem), 'seed': meta.get('seed'), 'pairs': pairs}
    ds['version'] = meta.get('version') or dataset_version(ds)
    return ds


def load_dataset(spec: str | Path, seed: int = 13) -> dict:
    """'synthetic' → generate(); otherwise a JSONL path."""
    if str(spec) == 'synthetic':
        return generate(seed=seed)
    return load_jsonl(spec)


def queries(ds: dict) -> list[tuple[dict, list[dict]]]:
    """Group pairs into (vacancy, [pairs]) preserving dataset order."""
    out: dict[int, list[dict]] = {}
    vacs: dict[int, dict] = {}
    for p in ds['pairs']:
        out.setdefault(p['query_id'], []).append(p)
        vacs[p['query_id']] = p['vacancy']
    return [(vacs[qid], out[qid]) for qid in out]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog='evaluation.dataset')
    ap.add_argument('--out', required=True, help='JSONL output path')
    ap.add_argument('--seed', type=int, default=13)
    ap.add_argument('--queries', type=int, default=26)
    args = ap.parse_args(argv)
    ds = generate(seed=args.seed, n_queries=args.queries)
    write_jsonl(ds, args.out)
    noisy = sum(1 for p in ds['pairs'] if 'noisy' in p['tags'])
    print(f"wrote {len(ds['pairs'])} pairs ({noisy} noisy) "
          f"over {len(queries(ds))} queries → {args.out}  version={ds['version']}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
