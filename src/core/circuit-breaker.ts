export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  /** Size of the rolling window of recent calls used to compute the failure rate. */
  windowSize: number;
  /** Calls required in the window before the failure rate is considered. */
  minimumCalls: number;
  /** Failure rate (0-1) at or above which the breaker opens. */
  failureRateThreshold: number;
  /** How long the breaker stays open before letting a probe through. */
  openMs: number;
  /** Probes allowed concurrently while half-open. */
  halfOpenProbes: number;
}

export const DEFAULT_BREAKER: BreakerOptions = {
  windowSize: 50,
  minimumCalls: 20,
  failureRateThreshold: 0.5,
  openMs: 15_000,
  halfOpenProbes: 3,
};

/**
 * Count-based circuit breaker.
 *
 * Closed: calls flow, outcomes fill a rolling window; opens when the failure rate crosses the
 * threshold. Open: calls are rejected until `openMs` passes. Half-open: a few probes go
 * through; one failure reopens, all probes succeeding closes it.
 *
 * State is per process on purpose: each worker reacts to what it sees, with no coordination
 * round-trip on the hot path. With N workers a dead provider costs about N × minimumCalls
 * failed calls before every breaker opens.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private outcomes: boolean[] = [];
  private openedAt = 0;
  private probesInFlight = 0;
  private probeSuccesses = 0;

  constructor(
    readonly name: string,
    private readonly options: BreakerOptions = DEFAULT_BREAKER,
    private readonly now: () => number = Date.now,
    private readonly onStateChange?: (name: string, state: BreakerState) => void,
  ) {}

  getState(): BreakerState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.options.openMs) {
      this.transition('half-open');
    }
    return this.state;
  }

  /** Returns true if a call may proceed. A true result in half-open reserves a probe slot. */
  tryAcquire(): boolean {
    const state = this.getState();
    if (state === 'closed') return true;
    if (state === 'open') return false;
    if (this.probesInFlight >= this.options.halfOpenProbes) return false;
    this.probesInFlight += 1;
    return true;
  }

  /** Gives back a half-open probe slot without recording an outcome. */
  release(): void {
    if (this.state === 'half-open') this.probesInFlight = Math.max(0, this.probesInFlight - 1);
  }

  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      this.probeSuccesses += 1;
      if (this.probeSuccesses >= this.options.halfOpenProbes) this.transition('closed');
      return;
    }
    this.push(true);
  }

  recordFailure(): void {
    if (this.state === 'half-open') {
      this.transition('open');
      return;
    }
    this.push(false);
    if (this.outcomes.length < this.options.minimumCalls) return;
    const failures = this.outcomes.filter((ok) => !ok).length;
    if (failures / this.outcomes.length >= this.options.failureRateThreshold) {
      this.transition('open');
    }
  }

  private push(ok: boolean): void {
    this.outcomes.push(ok);
    if (this.outcomes.length > this.options.windowSize) this.outcomes.shift();
  }

  private transition(next: BreakerState): void {
    if (next === this.state) return;
    this.state = next;
    this.probesInFlight = 0;
    this.probeSuccesses = 0;
    if (next === 'open') this.openedAt = this.now();
    if (next === 'closed') this.outcomes = [];
    this.onStateChange?.(this.name, next);
  }
}
