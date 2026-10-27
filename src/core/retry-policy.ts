/**
 * Tiered retry topics.
 *
 * A failed message is not retried in place (that would block its partition) nor re-queued on
 * the main topic (that would retry it immediately). It goes to a retry topic whose every
 * message waits the same delay. Because delays are equal within a topic, messages become due
 * in the order they arrive, so the consumer only ever waits for the head of the partition.
 */
export interface RetryTier {
  tier: number;
  delayMs: number;
}

export const DEFAULT_TIERS: readonly RetryTier[] = [
  { tier: 1, delayMs: 5_000 },
  { tier: 2, delayMs: 30_000 },
  { tier: 3, delayMs: 300_000 },
];

export type RetryDecision =
  | { kind: 'retry'; tier: RetryTier; notBefore: number }
  | { kind: 'dead-letter'; reason: string };

/**
 * Decides what happens after failed attempt number `attempt` (1-based).
 * Attempts beyond the last tier, and non-retryable errors, go to the dead-letter topic.
 */
export function decideRetry(
  attempt: number,
  retryable: boolean,
  now: number,
  tiers: readonly RetryTier[] = DEFAULT_TIERS,
): RetryDecision {
  if (!retryable) return { kind: 'dead-letter', reason: 'non-retryable error' };
  if (attempt < 1) throw new RangeError('attempt is 1-based');
  const tier = tiers[attempt - 1];
  if (!tier) return { kind: 'dead-letter', reason: `gave up after ${attempt} attempts` };
  return { kind: 'retry', tier, notBefore: now + tier.delayMs };
}

/** Exponential backoff with full jitter, used for short in-process waits (e.g. no provider up). */
export function backoffWithJitter(
  attempt: number,
  baseMs: number,
  capMs: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * exp);
}
