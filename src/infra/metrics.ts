import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/** One registry per process, exposed at GET /metrics by every role. */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequests = new Counter({
  name: 'relay_http_requests_total',
  help: 'HTTP requests handled by the API',
  labelNames: ['route', 'status'] as const,
  registers: [registry],
});

export const messagesAccepted = new Counter({
  name: 'relay_messages_accepted_total',
  help: 'Messages accepted by the API (new, not idempotent replays)',
  labelNames: ['channel'] as const,
  registers: [registry],
});

export const idempotentReplays = new Counter({
  name: 'relay_idempotent_replays_total',
  help: 'Requests answered from an existing message because the idempotency key was reused',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const receiptsRecorded = new Counter({
  name: 'relay_receipts_total',
  help: 'Delivery receipts received from providers',
  labelNames: ['provider', 'type', 'outcome'] as const,
  registers: [registry],
});

export const outboxPublished = new Counter({
  name: 'relay_outbox_published_total',
  help: 'Outbox rows published to Kafka',
  registers: [registry],
});

export const outboxOldestAge = new Gauge({
  name: 'relay_outbox_oldest_age_seconds',
  help: 'Age of the oldest unpublished outbox row (0 when empty)',
  registers: [registry],
});

export const publisherIsLeader = new Gauge({
  name: 'relay_publisher_is_leader',
  help: '1 when this publisher holds the leader lock',
  registers: [registry],
});

export const deliveries = new Counter({
  name: 'relay_deliveries_total',
  help: 'Delivery outcomes per channel and provider',
  labelNames: ['channel', 'provider', 'outcome'] as const,
  registers: [registry],
});

export const providerCallDuration = new Histogram({
  name: 'relay_provider_call_duration_seconds',
  help: 'Latency of provider HTTP calls',
  labelNames: ['provider', 'outcome'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const endToEndLatency = new Histogram({
  name: 'relay_end_to_end_seconds',
  help: 'Time from API acceptance to provider acknowledgement',
  labelNames: ['channel'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300, 900],
  registers: [registry],
});

export const retriesScheduled = new Counter({
  name: 'relay_retries_scheduled_total',
  help: 'Messages sent to a retry tier',
  labelNames: ['channel', 'tier'] as const,
  registers: [registry],
});

export const deadLettered = new Counter({
  name: 'relay_dead_lettered_total',
  help: 'Messages sent to the dead-letter topic',
  labelNames: ['channel', 'reason'] as const,
  registers: [registry],
});

export const duplicatesSkipped = new Counter({
  name: 'relay_duplicates_skipped_total',
  help: 'Kafka redeliveries skipped because the message was already final',
  labelNames: ['channel'] as const,
  registers: [registry],
});

export const rateLimitWaits = new Histogram({
  name: 'relay_rate_limit_wait_seconds',
  help: 'Time spent waiting for a provider rate-limit token',
  labelNames: ['provider'] as const,
  buckets: [0, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  registers: [registry],
});

export const breakerState = new Gauge({
  name: 'relay_circuit_breaker_state',
  help: 'Circuit state per provider in this process: 0 closed, 1 half-open, 2 open',
  labelNames: ['provider'] as const,
  registers: [registry],
});
