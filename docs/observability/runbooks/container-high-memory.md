# ContainerHighMemory / ContainerCriticalMemory

**Severity**: Warning (>85%) / Critical (>95%)
**Alert**: `strafor:container_memory_percent > 85` for 10m (warning) / 2m (critical)

## Symptoms

- A container is using more than 85% (warning) or 95% (critical) of its memory limit.
- Risk of OOM kill if usage continues to rise.

## Diagnosis

1. Check memory trend in the Grafana "Container Detail" dashboard.
2. Check for memory leaks:
    ```bash
    docker compose exec <service-name> node --inspect  # for Node.js
    docker compose exec <service-name> ps aux --sort=-rss | head  # general
    ```
3. Check if the memory limit is appropriate:
    ```bash
    docker inspect <container> | grep MemoryLimit
    ```

## Mitigation

### If the limit is too low

- Increase the memory limit in docker-compose.yml (`deploy.resources.limits.memory`).
- Restart the container after the change.

### If there's a memory leak

- Restart the container as a temporary fix.
- File a bug for the memory leak.
- Check for recent code changes that might have introduced the leak.

### If the container gets OOM killed

- See the `container-oom.md` runbook.

## Escalation

- If memory is above 95% and rising, restart the container immediately.
- If OOM kills are recurring, the memory limit must be increased or the leak fixed.
