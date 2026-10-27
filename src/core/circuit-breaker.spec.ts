import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { BreakerState, CircuitBreaker } from './circuit-breaker';

const options = { windowSize: 10, minimumCalls: 4, failureRateThreshold: 0.5, openMs: 1000, halfOpenProbes: 2 };

function setup() {
  let t = 0;
  const changes: BreakerState[] = [];
  const breaker = new CircuitBreaker(
    'p',
    options,
    () => t,
    (_, s) => changes.push(s),
  );
  return { breaker, changes, advance: (ms: number) => (t += ms) };
}

describe('CircuitBreaker', () => {
  it('stays closed below the minimum number of calls', () => {
    const { breaker } = setup();
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    assert.equal(breaker.getState(), 'closed');
  });

  it('opens when the failure rate reaches the threshold', () => {
    const { breaker, changes } = setup();
    breaker.recordSuccess();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.getState(), 'open');
    assert.equal(breaker.tryAcquire(), false);
    assert.deepEqual(changes, ['open']);
  });

  it('half-opens after the cool-down and closes when every probe succeeds', () => {
    const { breaker, advance, changes } = setup();
    for (let i = 0; i < 4; i++) breaker.recordFailure();
    advance(1000);
    assert.equal(breaker.getState(), 'half-open');
    assert.equal(breaker.tryAcquire(), true);
    assert.equal(breaker.tryAcquire(), true);
    assert.equal(breaker.tryAcquire(), false, 'only halfOpenProbes concurrent probes');
    breaker.recordSuccess();
    breaker.recordSuccess();
    assert.equal(breaker.getState(), 'closed');
    assert.deepEqual(changes, ['open', 'half-open', 'closed']);
  });

  it('reopens on a failed probe and restarts the cool-down', () => {
    const { breaker, advance } = setup();
    for (let i = 0; i < 4; i++) breaker.recordFailure();
    advance(1000);
    assert.equal(breaker.tryAcquire(), true);
    breaker.recordFailure();
    assert.equal(breaker.getState(), 'open');
    advance(999);
    assert.equal(breaker.getState(), 'open');
    advance(1);
    assert.equal(breaker.getState(), 'half-open');
  });

  it('forgets old outcomes outside the window', () => {
    const { breaker } = setup();
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    for (let i = 0; i < 10; i++) breaker.recordSuccess();
    breaker.recordFailure();
    assert.equal(breaker.getState(), 'closed');
  });
});
