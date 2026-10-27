# Relay

**High-throughput, multi-channel messaging service** — SMS, e-mail, WhatsApp and push —
built the way production notification platforms are: a transactional outbox, Kafka
partitioned by recipient, provider failover with circuit breakers, fleet-wide rate limiting,
tiered retries and a dead-letter topic.

NestJS · TypeScript · Kafka (Redpanda) · PostgreSQL · Redis · Prometheus · Grafana ·
Kubernetes · k6

## Why

Sending a message is easy. Sending millions a day means answering harder questions:

- What happens to an accepted message when Kafka is down? **It waits in the outbox, never lost.**
- What if the SMS gateway dies at peak? **Traffic fails over inside the same attempt.**
- What if the client retries a timed-out request? **The idempotency key returns the original.**
- How do 12 autoscaled pods respect a 1,500 msg/s contract? **One token bucket in Redis.**
- How do two OTPs for the same person stay in order? **Kafka key per recipient.**

Each answer is a decision with trade-offs, recorded in [`docs/adr`](docs/adr/README.md).

## Architecture

```mermaid
flowchart LR
  client([Client]) -- "POST /v1/messages<br/>Idempotency-Key" --> api[API]
  api -- "one transaction:<br/>message + outbox row" --> pg[(PostgreSQL)]
  pub[Outbox publisher<br/>leader via advisory lock] -- "FOR UPDATE SKIP LOCKED" --> pg
  pub -- "key = channel:recipient" --> main[[relay.&lt;channel&gt;]]
  main --> worker[Workers<br/>keyed concurrency]
  worker -- "token bucket (Lua)" --> redis[(Redis)]
  worker -- "priority + weight<br/>circuit breakers" --> pa[Provider A]
  worker -. failover .-> pb[Provider B]
  worker -- "attempt N failed" --> retry[[retry.1 · 5s<br/>retry.2 · 30s<br/>retry.3 · 5m]]
  retry --> worker
  worker -- "exhausted / 4xx" --> dlq[[relay.&lt;channel&gt;.dlq]]
  worker -- "status" --> pg
```

One image, four roles chosen by `APP_ROLE`:

| Role        | Does                                                                     | Scales                                  |
| ----------- | ------------------------------------------------------------------------ | --------------------------------------- |
| `api`       | Validates, stores message + outbox row in one transaction, answers `202` | Horizontally (stateless)                |
| `publisher` | Drains the outbox into Kafka in batches                                  | 2 replicas, 1 active (leader lock)      |
| `worker`    | Consumes, rate-limits, routes to providers, retries, dead-letters        | Horizontally, up to the partition count |
| `migrate`   | Applies schema migrations under an advisory lock                         | Job                                     |

## Delivery guarantees

- **No accepted message is lost.** `202` means the message and its outbox row are committed.
- **At-least-once into providers, with duplicates removed at every hop** (client key, status
  guard, provider idempotency key). The one remaining window, a worker dying after a provider
  that ignores idempotency keys accepted the message, is inherent to external providers
  ([ADR 3](docs/adr/0003-at-least-once-with-idempotency-at-every-hop.md)).
- **Per-recipient order** on the main path. A message that goes through a retry tier can be
  overtaken by a newer one for the same recipient, which is what you want for OTPs.

## Run it

Requirements: Docker, Node 22 and pnpm (`corepack enable`).

```bash
pnpm install          # first time: creates pnpm-lock.yaml, commit it
make up               # Kafka, Postgres, Redis, the 4 roles, 6 simulated providers, Prometheus, Grafana
make e2e              # end-to-end tests against the running stack
```

| URL                   |                                                       |
| --------------------- | ----------------------------------------------------- |
| http://localhost:3000 | API                                                   |
| http://localhost:3030 | Grafana, dashboard "Relay — overview"                 |
| http://localhost:8081 | Redpanda Console (topics, consumer lag, DLQ contents) |
| http://localhost:9090 | Prometheus                                            |

Send a message:

```bash
curl -i localhost:3000/v1/messages \
  -H 'content-type: application/json' -H 'idempotency-key: signup-otp-42' \
  -d '{"channel":"sms","to":"+5571999999999","body":"Your code is 123456"}'

curl localhost:3000/v1/messages/<id>
```

### Break things on purpose

The simulated providers take commands at runtime, which is how the e2e tests exercise failover:

```bash
# Primary SMS gateway goes down: watch traffic move to sms-beta in Grafana
curl -X POST localhost:8091/admin/config -d '{"outage": true}'

# Degrade it instead: 30% errors, 300 ms latency
curl -X POST localhost:8091/admin/config -d '{"outage": false, "failureRate": 0.3, "latencyMs": 300}'

# Back to normal
curl -X POST localhost:8091/admin/reset
```

## API

| Method | Path                            |                                                                                                                                                                                 |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/messages`                  | `202 {id, status}` · `200` + `Idempotent-Replayed: true` for a repeated key and payload · `409` for a repeated key with a different payload · `400` with every validation error |
| `GET`  | `/v1/messages/:id`              | Status, attempts, provider used, last error                                                                                                                                     |
| `GET`  | `/health/live`, `/health/ready` | Liveness (process only) and readiness (dependencies of the role)                                                                                                                |
| `GET`  | `/metrics`                      | Prometheus                                                                                                                                                                      |

Set `API_KEYS` to require `X-Api-Key`.

## Load test

```bash
make load RATE=2000 DURATION=5m   # k6, constant arrival rate, realistic channel mix
make report DURATION=5m           # numbers from Prometheus, as a Markdown table
```

The report reads the services' own metrics, so it measures **delivery to providers**, not only
how fast the API said "accepted".

### Results

> To be filled with the output of `make report` after running on a known machine. Record the
> hardware (CPU, RAM), the number of worker replicas and the provider latencies used.

| Metric                     | Value     |
| -------------------------- | --------- |
| Accepted by the API        | _pending_ |
| Delivered to providers     | _pending_ |
| End-to-end p50 / p95 / p99 | _pending_ |
| Max outbox age             | _pending_ |

## Kubernetes

```bash
make kind-up   # kind cluster, image, base manifests + local Redpanda/Postgres/Redis and mocks
```

`k8s/base` is environment-agnostic: probes, resource requests, non-root read-only containers,
spread constraints, PodDisruptionBudgets and HPAs. `k8s/overlays/kind` adds single-node
dependencies for local runs; a production overlay would point the same base at managed
Kafka, Postgres and Redis. HPAs need `metrics-server` in the cluster.

## Project layout

```
src/
  core/        pure domain logic, no framework: validation, idempotency fingerprint, retry
               tiers, circuit breaker, provider router, token bucket, keyed executor, UUIDv7
  api/         HTTP API (controller, repository, API-key guard)
  publisher/   outbox → Kafka, leader election
  worker/      Kafka consumers, delivery, provider client, rate limiter
  infra/       Postgres, Kafka, Redis, metrics, health, migrations
  mock-provider/  dependency-free fake gateway with runtime-controllable failures
test/e2e/      end-to-end tests that cause real outages through the mocks
load/          k6 scenario and the Prometheus report
k8s/           kustomize base and kind overlay
ops/           Prometheus and Grafana provisioning
docs/adr/      architecture decision records
```

The core has no dependency on NestJS, Kafka or Postgres, so the logic that decides retries,
failover and rate limits is unit-tested in isolation (`pnpm test`).

## Next steps

- OpenTelemetry tracing across API → Kafka → worker → provider.
- KEDA scaling on consumer lag instead of CPU.
- Priority lanes (OTP ahead of marketing) as separate topics with their own worker pools.
- Delivery receipts: provider webhooks updating the final status.
- A DLQ replay command.
