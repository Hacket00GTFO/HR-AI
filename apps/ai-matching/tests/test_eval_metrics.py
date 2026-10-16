"""Unit tests for evaluation.metrics — every value hand-computed."""
import math

from evaluation import metrics as M


# -- precision_at_k ----------------------------------------------------------

def test_precision_at_k_basic():
    labels = [3, 0, 2, 1, 0]  # relevant (>=2): positions 1 and 3
    assert M.precision_at_k(labels, 5) == 2 / 5
    assert M.precision_at_k(labels, 1) == 1.0
    assert M.precision_at_k(labels, 2) == 0.5


def test_precision_at_k_edges():
    assert M.precision_at_k([], 5) is None
    assert M.precision_at_k([0, 0], 5) == 0.0
    # k larger than list divides by len(top)
    assert M.precision_at_k([2], 10) == 1.0 / 1


# -- recall_at_k -------------------------------------------------------------

def test_recall_at_k_basic():
    labels = [3, 0, 2, 1, 0]
    assert M.recall_at_k(labels, 5) == 1.0   # both relevant captured
    assert M.recall_at_k(labels, 1) == 0.5
    assert M.recall_at_k([0, 0, 0], 5) is None  # no relevant → undefined


# -- ndcg_at_k ---------------------------------------------------------------

def test_ndcg_at_k_hand_computed():
    labels = [3, 0, 2]
    dcg = (2 ** 3 - 1) / math.log2(2) + 0 / math.log2(3) + (2 ** 2 - 1) / math.log2(4)
    ideal = (2 ** 3 - 1) / math.log2(2) + (2 ** 2 - 1) / math.log2(3) + 0 / math.log2(4)
    assert abs(M.ndcg_at_k(labels, 3) - dcg / ideal) < 1e-9
    assert M.ndcg_at_k([3, 2, 0], 3) == 1.0  # ideal ordering


def test_ndcg_at_k_undefined_when_no_gain():
    assert M.ndcg_at_k([0, 0, 0], 5) is None
    assert M.ndcg_at_k([2], 1) == 1.0


# -- mrr ----------------------------------------------------------------------

def test_mrr():
    assert M.mrr([0, 0, 3, 2]) == 1 / 3
    assert M.mrr([2, 0]) == 1.0
    assert M.mrr([0, 1, 0]) is None


# -- auc ----------------------------------------------------------------------

def test_auc_pairwise():
    assert M.auc([(0.9, 3), (0.8, 0), (0.7, 0)]) == 1.0
    assert M.auc([(0.1, 3), (0.9, 0)]) == 0.0
    assert M.auc([(0.5, 2), (0.5, 0)]) == 0.5  # tie
    assert M.auc([(0.5, 1), (0.5, 0)]) is None  # no positives
    assert M.auc([(0.5, 3)]) is None           # no negatives


# -- macro_average ------------------------------------------------------------

def test_macro_average_skips_none():
    assert M.macro_average([0.5, None, 1.0]) == 0.75
    assert M.macro_average([None, None]) is None
