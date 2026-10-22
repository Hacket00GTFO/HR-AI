# ServiceHighErrorRate / ServiceCriticalErrorRate

**Severity**: Warning (>5%) / Critical (>20%)
**Alert**: `strafor:http_error_ratio:rate5m > 0.05` for 5m (warning) / 2m (critical)

## Symptoms

- A service is returning 5xx errors at a high rate.
- Users may see error pages or failed API calls.

## Diagnosis

1. Check the Grafana "Services RED" dashboard for the affected service.
2. Check the service logs for error patterns:
    ```bash
    docker compose logs --tail=100 <service-name> | grep -i error
    ```
3. Check if a downstream dependency is failing:
    - Database: `docker compose exec db pg_isready`
    - Redis: `docker compose exec redis redis-cli ping`
    - RabbitMQ: `docker compose exec rabbitmq rabbitmq-diagnostics ping`
4. Check for recent deployments that might have introduced the errors.

## Mitigation

### If a dependency is down

- Fix the dependency first (see the relevant runbook).

### If a recent deployment caused the errors

- Roll back the deployment.
- Check the CI/CD pipeline for failed tests.

### If the errors are from a specific route

- Check the "Top Routes by RPS" panel in the Services RED dashboard.
- Look for patterns in the error responses.

## Escalation

- If error rate is above 20% for 5+ minutes, escalate immediately.
- If the service is completely down, see `service-down.md`.
