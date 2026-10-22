# StraforAI — prod overlay (Azure AKS)

`kubectl apply -k` overlay that turns the dev-grade `../../base` into a
production deployment on AKS: immutable images, PVCs everywhere, HPA/PDB,
default-deny NetworkPolicies, hardened pod securityContexts, cert-manager
TLS, and Azure Key Vault secrets via the Secrets Store CSI driver.

## Required on the cluster (install before applying)

| Component                                         | Why                                                           | Install                                                                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ingress-nginx**                                 | Ingress controller for `ingress.yaml`                         | `helm install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx --create-namespace` (or the AKS `app-routing` addon — adjust the NetworkPolicy namespace selector accordingly) |
| **cert-manager**                                  | Issues `strafor-tls` via the `letsencrypt-prod` ClusterIssuer | `helm install cert-manager jetstack/cert-manager -n cert-manager --set crds.enabled=true`, then create the `letsencrypt-prod` ClusterIssuer (manual — see below)                        |
| **secrets-store-csi-driver** + **azure provider** | Mounts Key Vault objects; syncs `strafor-secrets`             | `az aks update -g <rg> -n <cluster> --enable-addons azure-keyvault-secrets-provider` (AKS addon installs both)                                                                          |
| **metrics-server**                                | HPAs need pod CPU metrics                                     | usually preinstalled on AKS (`kubectl get deploy metrics-server -n kube-system`)                                                                                                        |
| **Workload Identity**                             | CSI → Key Vault auth without stored creds                     | `az aks update --enable-workload-identity --enable-oidc-issuer`; create a managed identity + federated credential for `strafor-workload`/`strafor` (manual — see below)                 |
| **kube-state-metrics**                            | `kube_*` metrics for `kubernetes.yml` alert rules             | `helm install kube-state-metrics prometheus-community/kube-state-metrics -n strafor-observability` (or via prometheus-stack)                                                            |

## Secret inventory — create these in Azure Key Vault

Object names must be kebab-case (KV forbids `_`). `objectAlias` in
`secretproviderclass.yaml` maps them back to the env var names; the synced
`strafor-secrets` Secret feeds the base `envFrom: secretRef` wiring —
`DATABASE_URL`/`RABBITMQ_URL` stay composed from `$(POSTGRES_PASSWORD)` /
`$(RABBITMQ_PASSWORD)` at container start, so per-service connection
strings need no separate secrets.

| Key Vault secret name     | Env key synced            | Used by                                                                                                     |
| ------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `postgres-password`       | `POSTGRES_PASSWORD`       | db, api, identity-auth, documents-resumes, notifications, ai-matching(+worker), analytics (via `$(…)` URLs) |
| `rabbitmq-password`       | `RABBITMQ_PASSWORD`       | rabbitmq + same consumers via `RABBITMQ_URL`                                                                |
| `minio-root-user`         | `MINIO_ROOT_USER`         | minio, api, documents-resumes                                                                               |
| `minio-root-password`     | `MINIO_ROOT_PASSWORD`     | minio, api, documents-resumes                                                                               |
| `jwt-secret`              | `JWT_SECRET`              | legacy HS256 fallback (api)                                                                                 |
| `jwt-private-key`         | `JWT_PRIVATE_KEY`         | identity-auth (RS256 signing)                                                                               |
| `jwt-public-key`          | `JWT_PUBLIC_KEY`          | identity-auth, services verifying RS256                                                                     |
| `settings-encryption-key` | `SETTINGS_ENCRYPTION_KEY` | api                                                                                                         |
| `service-auth-token`      | `SERVICE_AUTH_TOKEN`      | service-to-service auth                                                                                     |
| `smtp-user`               | `SMTP_USER`               | notifications                                                                                               |
| `smtp-pass`               | `SMTP_PASS`               | notifications                                                                                               |
| `openai-api-key`          | `OPENAI_API_KEY`          | ai-matching(+worker)                                                                                        |
| `anthropic-api-key`       | `ANTHROPIC_API_KEY`       | ai-matching(+worker)                                                                                        |
| `metrics-token`           | `METRICS_TOKEN`           | all services exposing `/metrics`                                                                            |
| `alert-webhook-token`     | `ALERT_WEBHOOK_TOKEN`     | api (Alertmanager webhook)                                                                                  |

## Manual steps that stay manual

1. **Key Vault + identity.** Create the vault (`az keyvault create -n
strafor-prod-kv …`), load the secrets above, create a user-assigned
   managed identity with `Key Vault Secrets User`, and a federated
   credential binding it to `system:serviceaccount:strafor:strafor-workload`.
2. **Fill the placeholders.** In `secretproviderclass.yaml`:
   `<AKV_NAME>`, `<AZURE_TENANT_ID>`, `<WI_CLIENT_ID>` (×2: SA annotation +
   `clientID` param). In `patches/ingress-tls.yaml` +
   `patches/configmap-prod.yaml`: `strafor.example.com` → real DNS name,
   `smtp.example.com` → real SMTP host. In `kustomization.yaml`: real
   image tags (or let CI inject them — see below).
3. **ClusterIssuer.** Create `letsencrypt-prod`
   (`cert-manager.io/v1`, ACME production, http01 via ingress-nginx).
4. **Per-service databases.** Same as base: `kubectl exec -n strafor
strafor-db-0 -- psql -U strafor -c 'CREATE DATABASE …'` for
   `strafor_identity`, `strafor_documents`, `strafor_notifications`,
   `strafor_ai`, `strafor_analytics`, `strafor_recruitment`.
5. **DNS + GHCR pull secret.** Point the host at the ingress LB; if
   `ghcr.io/strafor/*` is private, create an `imagePullSecrets` secret and
   reference it in the pods (not included — see open decisions).
6. **k8s alert rules.** `infra/observability/prometheus/rules/
kubernetes.yml` is the source of truth; add it as a `kubernetes.yml`
   key to the `prometheus-alert-rules` ConfigMap (k8s observability
   stack) so the in-cluster Prometheus evaluates it.

## Deploy

```sh
kubectl kustomize infra/k8s/overlays/prod        # render/verify
kubectl apply -k infra/k8s/overlays/prod         # apply
kubectl -n strafor rollout status deployment/gateway
```

CI injects real image tags with:

```sh
cd infra/k8s/overlays/prod
kustomize edit set image ghcr.io/strafor/api=ghcr.io/strafor/api:v1.2.3 …
```

(or by rendering a generated `images:` section over this file).

## What the overlay changes vs base

- **Images** → `ghcr.io/strafor/*` with CI-injected tags; third-party
  images pinned (redis 7.4.2-alpine, rabbitmq 3.13.7-management-alpine,
  minio RELEASE.2025-04-22T22-12-26Z, pgvector pg16).
- **Storage** → redis/rabbitmq `emptyDir` → PVCs; `strafor-exports` PVC
  added for the api exports dir (compose parity); every claim pinned to
  `managed-csi-premium`.
- **Scaling/HA** → `autoscaling/v2` HPAs (min 2, CPU 70%) on the eight
  stateless services; PDB `minAvailable: 1` on every workload.
- **Network** → default-deny in/out; ingress only from ingress-nginx,
  in-namespace peers that need it, and `strafor-observability` for
  scraping; egress = DNS + intra-namespace + :443 (+ SMTP ports for
  notifications).
- **Security** → non-root numeric uids, `RuntimeDefault` seccomp,
  `readOnlyRootFilesystem` + `emptyDir` for `/tmp` (and
  `/var/run/postgresql`, `/var/log/rabbitmq`, `.next/cache`), drop ALL
  caps, no privilege escalation.
- **TLS** → cert-manager `letsencrypt-prod`, host `strafor.example.com`,
  SSL redirect + HSTS/frame-deny/nosniff via built-in annotations.
- **Removed** → `strafor-mailpit` (dev SMTP sink).
- **Changed** → gateway Service `LoadBalancer` → `ClusterIP` (ingress is
  the only public entrypoint).

## Verify after apply

```sh
kubectl -n strafor get pods                    # all Ready
kubectl -n strafor get secret strafor-secrets  # synced by CSI on first mount
kubectl -n strafor get certificate strafor-tls # Ready once DNS points at the LB
kubectl -n strafor get hpa,pdb,networkpolicy
```
