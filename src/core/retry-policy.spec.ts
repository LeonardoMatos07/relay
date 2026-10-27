import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { backoffWithJitter, decideRetry, DEFAULT_TIERS } from './retry-policy';

describe('decideRetry', () => {
  const now = 1_000_000;

  it('walks the tiers in order', () => {
    DEFAULT_TIERS.forEach((tier, i) => {
      const d = decideRetry(i + 1, true, now);
      assert.equal(d.kind, 'retry');
      if (d.kind === 'retry') {
        assert.equal(d.tier.tier, tier.tier);
        assert.equal(d.notBefore, now + tier.delayMs);
      }
    });
  });

  it('dead-letters after the last tier', () => {
    const d = decideRetry(DEFAULT_TIERS.length + 1, true, now);
    assert.equal(d.kind, 'dead-letter');
  });

  it('dead-letters non-retryable errors immediately', () => {
    assert.deepEqual(decideRetry(1, false, now), { kind: 'dead-letter', reason: 'non-retryable error' });
  });

  it('rejects a zero attempt', () => {
    assert.throws(() => decideRetry(0, true, now), RangeError);
  });
});

describe('backoffWithJitter', () => {
  it('stays within [0, cap) and grows with the attempt', () => {
    assert.equal(
      backoffWithJitter(1, 100, 10_000, () => 0.999),
      99,
    );
    assert.equal(
      backoffWithJitter(4, 100, 10_000, () => 0.999),
      799,
    );
    assert.equal(
      backoffWithJitter(20, 100, 10_000, () => 0.999),
      9990,
    );
    assert.equal(
      backoffWithJitter(3, 100, 10_000, () => 0),
      0,
    );
  });
});
