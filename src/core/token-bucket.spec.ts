import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { takeTokens } from './token-bucket';

describe('takeTokens', () => {
  it('starts full and allows a burst', () => {
    let state;
    for (let i = 0; i < 5; i++) {
      const r = takeTokens(state, 0, 10, 5);
      assert.equal(r.allowed, true);
      state = r.state;
    }
    const denied = takeTokens(state, 0, 10, 5);
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterMs, 100, '1 token at 10/s is 100 ms away');
  });

  it('refills over time and never above the burst', () => {
    const empty = { tokens: 0, updatedAt: 0 };
    assert.equal(takeTokens(empty, 50, 10, 5).allowed, false);
    assert.equal(takeTokens(empty, 100, 10, 5).allowed, true);
    const later = takeTokens(empty, 60_000, 10, 5);
    assert.equal(later.state.tokens, 4);
  });

  it('holds the rate over a long run', () => {
    let state;
    let allowed = 0;
    for (let t = 0; t <= 10_000; t += 1) {
      const r = takeTokens(state, t, 100, 10);
      state = r.state;
      if (r.allowed) allowed++;
    }
    assert.ok(allowed >= 1000 && allowed <= 1011, `expected ~1010, got ${allowed}`);
  });

  it('ignores clocks that go backwards', () => {
    const r = takeTokens({ tokens: 1, updatedAt: 1000 }, 900, 10, 5);
    assert.equal(r.allowed, true);
    assert.equal(r.state.tokens, 0);
  });
});
