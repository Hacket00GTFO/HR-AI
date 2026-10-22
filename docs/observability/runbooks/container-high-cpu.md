# ContainerHighCPU

**Severity**: Warning
**Alert**: `strafor:container_cpu_percent:rate2m > 85` for 10m

## Symptoms

- A container is using more than 85% CPU for 10+ minutes.
- Response times may be elevated.

## Diagnosis

1. Identify the container in the Grafana "Containers Overview" dashboard.
2. Check what the container is doing:
    ```bash
    docker compose top <service-name>
    ```
3. Check for runaway processes:
    ```bash
    docker compose exec <service-name> top
    ```

## Mitigation

### If a specific process is consuming CPU

- Identify and kill the process if it's not critical.
- Check for infinite loops or expensive queries.

### If traffic is the cause

- Consider scaling the service (add replicas in K8s).
- Check if a rate limiter is in place.

### If the service is under-provisioned

- Increase the CPU limit in docker-compose.yml or the K8s deployment.
- Monitor after the change.

## Escalation

- If CPU stays above 90% for 30+ minutes, escalate.
- If the service becomes unresponsive, restart it.
