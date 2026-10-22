# PrometheusDown

**Severity**: Critical
**Alert**: `up{job="prometheus"} == 0` for 1m

## Symptoms

- No metrics are being collected.
- Dashboards show stale data.
- Alerts stop firing (including this one — so it may only fire once).

## Diagnosis

1. Check if the Prometheus container is running:

    ```bash
    docker compose ps prometheus
    ```

2. Check Prometheus logs:

    ```bash
    docker compose logs --tail=100 prometheus
    ```

3. Check if the TSDB is full:

    ```bash
    docker compose exec prometheus df -h /prometheus
    ```

4. Check if the config is valid:
    ```bash
    docker compose exec prometheus promtool check config /etc/prometheus/prometheus.yml
    ```

## Mitigation

### If the container is stopped

```bash
docker compose up -d prometheus
```

### If the TSDB is full

1. Reduce retention: `--storage.tsdb.retention.time=30d`
2. Or increase disk space.
3. Restart Prometheus.

### If the config is invalid

1. Fix the config file.
2. Reload: `docker compose exec prometheus kill -HUP 1`

## Escalation

- If Prometheus cannot be restarted, all monitoring is blind.
- Escalate immediately.
