"""Ranking metrics — pure functions over relevance labels.

Conventions:
- `labels` is the sequence of graded relevances (0..3) in *ranked* order.
- A pair is "relevant" for P@k/R@k/MRR/AUC when label >= `threshold`
  (default 2, i.e. 'relevant' or 'strong' on the 0-3 scale).
- NDCG uses exponential gains (2**rel - 1) and log2(rank+1) discount.
- Functions return None when the metric is undefined for the input
  (e.g. recall with no relevant items) — callers macro-average over the
  queries where the metric is defined.
"""
from __future__ import annotations

import math
from typing import Iterable, Sequence

RELEVANT = 2  # relevance threshold for binary metrics


def _top(labels: Sequence[int], k: int | None) -> Sequence[int]:
    return labels if k is None else labels[:k]


def precision_at_k(labels: Sequence[int], k: int, threshold: int = RELEVANT) -> float | None:
    """Fraction of the top-k that is relevant. None when k <= 0 or empty."""
    top = _top(labels, k)
    if not top or k <= 0:
        return None
    hits = sum(1 for r in top if r >= threshold)
    return hits / min(k, len(top))


def recall_at_k(labels: Sequence[int], k: int, threshold: int = RELEVANT) -> float | None:
    """Fraction of all relevant items captured in the top-k.
    None when the query has no relevant items at all."""
    total_rel = sum(1 for r in labels if r >= threshold)
    if total_rel == 0:
        return None
    top = _top(labels, k)
    hits = sum(1 for r in top if r >= threshold)
    return hits / total_rel


def _dcg(labels: Iterable[int], k: int | None = None) -> float:
    out = 0.0
    for i, rel in enumerate(_top(list(labels), k)):
        out += (2 ** rel - 1) / math.log2(i + 2)
    return out


def ndcg_at_k(labels: Sequence[int], k: int) -> float | None:
    """Normalized DCG at k. None when the ideal ordering has zero gain."""
    ideal = sorted(labels, reverse=True)
    idcg = _dcg(ideal, k)
    if idcg <= 0:
        return None
    return _dcg(labels, k) / idcg


def mrr(labels: Sequence[int], threshold: int = RELEVANT) -> float | None:
    """Reciprocal rank of the first relevant item. None when none relevant."""
    for i, rel in enumerate(labels):
        if rel >= threshold:
            return 1.0 / (i + 1)
    return None


def auc(scored_labels: Sequence[tuple[float, int]], threshold: int = RELEVANT) -> float | None:
    """Pairwise AUC: P(score_pos > score_neg) with ties counting 0.5.

    `scored_labels` is a sequence of (score, relevance) pairs for ONE query.
    None when there are no positive or no negative pairs.
    """
    pos = [s for s, r in scored_labels if r >= threshold]
    neg = [s for s, r in scored_labels if r < threshold]
    if not pos or not neg:
        return None
    wins = 0.0
    for p in pos:
        for n in neg:
            if p > n:
                wins += 1.0
            elif p == n:
                wins += 0.5
    return wins / (len(pos) * len(neg))


def macro_average(values: Iterable[float | None]) -> float | None:
    """Mean over the defined values; None when all are None."""
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    return sum(vals) / len(vals)


def query_metrics(labels: Sequence[int], scored: Sequence[tuple[float, int]],
                  ks: Sequence[int] = (5, 10)) -> dict:
    """All per-query metrics in one pass. `labels` in ranked order; `scored`
    is the (score, relevance) list used for AUC."""
    out: dict[str, float | None] = {'mrr': mrr(labels), 'auc': auc(scored)}
    for k in ks:
        out[f'precision_at_{k}'] = precision_at_k(labels, k)
        out[f'recall_at_{k}'] = recall_at_k(labels, k)
        out[f'ndcg_at_{k}'] = ndcg_at_k(labels, k)
    return out
