/**
 * Outcome of a provider call that did not succeed.
 *
 * `retryable` drives the retry policy (try again later, possibly elsewhere).
 * `countsAgainstProvider` drives the circuit breaker: a 400 because the recipient is invalid
 * says nothing about the provider's health and must not open its circuit.
 */
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly countsAgainstProvider: boolean,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

export function classifyHttpStatus(status: number, detail = ''): DeliveryError {
  const msg = `provider answered ${status}${detail ? `: ${detail}` : ''}`;
  if (status === 429) return new DeliveryError(msg, true, true, status);
  if (status === 408) return new DeliveryError(msg, true, true, status);
  // Our credentials or account at this provider are broken: the message is fine, the provider
  // is unusable. Retryable (so it fails over) and it counts (so the circuit opens).
  if (status === 401 || status === 403) return new DeliveryError(msg, true, true, status);
  if (status >= 500) return new DeliveryError(msg, true, true, status);
  if (status >= 400) return new DeliveryError(msg, false, false, status);
  return new DeliveryError(msg, true, true, status);
}

export function classifyNetworkError(error: unknown): DeliveryError {
  const msg = error instanceof Error ? error.message : String(error);
  return new DeliveryError(`network error: ${msg}`, true, true);
}

/**
 * A failure of our own infrastructure (Redis, Postgres, Kafka) during a delivery attempt.
 * It says nothing about the provider, so the router must not record it against a circuit or
 * fail over: it propagates to the consumer, which leaves the offset uncommitted.
 */
export class InfrastructureError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'InfrastructureError';
  }
}

export class NoProviderAvailableError extends DeliveryError {
  constructor(channel: string) {
    super(`no provider available for ${channel}: every circuit is open`, true, false);
    this.name = 'NoProviderAvailableError';
  }
}
