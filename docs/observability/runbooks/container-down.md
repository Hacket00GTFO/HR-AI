# ContainerDown

**Severity**: Critical
**Alert**: `strafor:probe_success{job="blackbox-http"} == 0` for 2m

## Symptoms

- A container is not responding to health probes.
- The Service Health dashboard shows the service as "down".
- Users may experience errors when accessing the affected service.

## Diagnosis

1. Check which container is down:

    ```bash
    docker compose ps | grep -v "healthy"
    ```

2. Check container logs:

    ```bash
    docker compose logs --tail=100 <service-name>
    ```

3. Check if the container is running at all:

    ```bash
    docker compose ps <service-name>
    ```

4. Check resource usage on the host:
    ```bash
    docker stats
    ```

## Mitigation

### If the container is stopped

```bash
docker compose up -d <service-name>
```

### If the container is running but unhealthy

```bash
docker compose restart <service-name>
```

### If the container keeps crashing

1. Check for OOM kills: `docker inspect <container> | grep -i oom`
2. Check disk space: `df -h`
3. Check if the database is reachable: `docker compose exec <service> wget -qO- http://db:5432`
4. Check if Redis is reachable: `docker compose exec <service> redis-cli -h redis ping`

## Escalation

- If the container cannot be restarted after 3 attempts, escalate to the platform team.
- If the database is down, escalate immediately — all services depend on it.
- Check the Grafana "Containers Overview" dashboard for correlated issues.
