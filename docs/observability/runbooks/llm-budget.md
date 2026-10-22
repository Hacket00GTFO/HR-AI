# LLMBudgetExceeded / LLMBudgetWarning

**Severity**: Critical (>100%) / Warning (>80%)
**Alert**: `llm_budget_ratio > 1` (critical) / `> 0.8` (warning)

## Symptoms

- The AI matching service has exceeded or is close to exceeding its monthly LLM budget.
- New AI scoring requests may fail or be rate-limited.

## Diagnosis

1. Check the Grafana "AI Matching Pipeline" dashboard.
2. Check the current budget setting:
    ```bash
    docker compose exec ai-matching env | grep LLM_MONTHLY_BUDGET
    ```
3. Check the LLM cost trend in the dashboard.
4. Check which provider/model is consuming the most budget.

## Mitigation

### If the budget is exceeded

1. Increase the monthly budget: `LLM_MONTHLY_BUDGET=100` (USD)
2. Restart the ai-matching service.
3. Review recent scoring requests for anomalies.

### If the budget is being consumed too fast

1. Switch to a cheaper model (e.g., from GPT-4 to GPT-3.5).
2. Enable caching of AI scores.
3. Reduce the sampling rate for explanations.
4. Implement request batching.

## Prevention

- Monitor the budget utilization gauge weekly.
- Set up the LLMBudgetWarning alert to catch it early.
- Review the cost per candidate in the dashboard.
