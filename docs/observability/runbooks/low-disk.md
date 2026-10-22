# PrometheusTSDBLowDisk

**Severity**: Critical
**Alert**: Host disk free space < 15%

## Symptoms

- Prometheus TSDB may not be able to write new data.
- Retention may be compromised.
- All services on the host may be affected.

## Diagnosis

1. Check disk space:

    ```bash
    df -h
    ```

2. Check Docker disk usage:

    ```bash
    docker system df
    ```

3. Check Prometheus data size:

    ```bash
    docker compose exec prometheus du -sh /prometheus
    ```

4. Check Loki data size:
    ```bash
    docker compose exec loki du -sh /loki
    ```

## Mitigation

### Immediate: free disk space

```bash
# Remove unused Docker images
docker image prune -a

# Remove unused volumes (CAREFUL)
docker volume prune

# Remove old Prometheus data (reduces retention)
docker compose exec prometheus rm -rf /prometheus/wal
docker compose restart prometheus
```

### Long-term: reduce retention

- Prometheus: `--storage.tsdb.retention.time=30d` (from 90d)
- Loki: `retention_period: 168h` (from 720h)
- Tempo: `block_retention: 72h` (from 336h)

### Long-term: add disk space

- Increase the VM/disk size.
- Move the data directory to a larger volume.

## Escalation

- If disk is above 95%, stop non-critical services to free space.
- If Prometheus runs out of disk, it will stop collecting metrics.
