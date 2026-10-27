# 5. Provider failover with per-process circuit breakers

- **Status:** Accepted

## Context

Messaging platforms contract several providers per channel, for price and for resilience.
When the primary degrades, traffic must move to the secondary within seconds, without a human
and without first burning every message through the retry tiers.

## Decision

- Providers are configured per channel with a **priority** and, within a priority, a
  **weight** (e.g. 75/25 split between two SMS gateways).
- Each delivery attempt walks the providers in that order and **fails over within the same
  attempt** on retryable errors (5xx, 429, timeouts, network errors). A non-retryable error
  (bad recipient) stops immediately: another provider would reject it too.
- Each provider has a **count-based circuit breaker** (window 50, minimum 20 calls, opens at
  50% failures, half-open after 15 s with 3 probes). Open providers are skipped, so a dead
  provider costs a skipped check rather than a timeout per message.
- Client errors and local rate limiting do **not** count against a provider's circuit: they
  say nothing about its health.
- Breakers live **in each worker process**, with no shared state.

## Consequences

- An outage of the primary is invisible to users: messages fail over inside one attempt, and
  after ~20 failed calls per worker the primary is skipped entirely until it recovers.
- Per-process breakers avoid a coordination round trip on every call, at the cost of each pod
  learning about an outage on its own (N pods × 20 calls). Sharing state through Redis would
  shave that and add a dependency to the hot path; not worth it at this scale.
- Recovery is automatic and gradual (half-open probes) instead of all traffic snapping back.
