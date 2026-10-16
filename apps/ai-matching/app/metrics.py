"""Domain-specific Prometheus metrics for the AI matching pipeline."""
from prometheus_client import Counter, Histogram, Gauge

# Pipeline metrics
ai_score_duration = Histogram(
    "ai_score_duration_seconds",
    "AI candidate scoring duration by stage",
    ["service", "stage"],
)

ai_rank_candidates = Counter(
    "ai_rank_candidates_total",
    "Total candidates ranked",
    ["service"],
)

ai_cv_parse_total = Counter(
    "ai_cv_parse_total",
    "Total CV parse operations",
    ["service", "outcome"],
)

# LLM metrics
llm_requests = Counter(
    "llm_requests_total",
    "Total LLM API requests",
    ["service", "provider", "model", "kind"],
)

llm_tokens = Counter(
    "llm_tokens_total",
    "Total LLM tokens used",
    ["service", "provider", "model", "direction"],
)

llm_cost = Counter(
    "llm_cost_usd_total",
    "Total LLM cost in USD",
    ["service", "provider", "model"],
)

llm_budget_ratio = Gauge(
    "llm_budget_ratio",
    "LLM monthly budget utilization ratio (0-1+)",
    ["service"],
)

ai_explanations = Counter(
    "ai_explanations_generated_total",
    "Total AI match explanations generated",
    ["service"],
)
