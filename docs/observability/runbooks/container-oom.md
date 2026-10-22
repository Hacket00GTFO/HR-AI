# ContainerOOMKilled

**Severity**: Critical
**Alert**: `strafor:container_oom:increase15m > 0` for 0m

## Symptoms

- A container was killed by the OOM killer.
- The container will be restarted by Docker/K8s (if restart policy allows).

## Diagnosis

1. Confirm the OOM kill:

    ```bash
    docker inspect <container> --format '{{.State.OOMKilled}}'
    ```

2. Check the container's memory limit:

    ```bash
    docker inspect <container> --format '{{.HostConfig.Memory}}'
    ```

3. Check what was consuming memory before the kill:
    ```bash
    docker compose logs --tail=200 <service-name>
    ```

## Mitigation

1. Increase the memory limit:

    ```yaml
    deploy:
        resources:
            limits:
                memory: 1G # increase from 512M
    ```

2. Restart the container:

    ```bash
    docker compose up -d <service-name>
    ```

3. Monitor memory usage after restart.

## Prevention

- Set memory limits on all containers.
- Monitor memory trends in Grafana.
- Investigate memory leaks before they cause OOM kills.
