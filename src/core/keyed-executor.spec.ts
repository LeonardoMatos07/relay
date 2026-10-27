import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { KeyedExecutor } from './keyed-executor';

describe('KeyedExecutor', () => {
  it('keeps order within a key even when earlier tasks are slower', async () => {
    const ex = new KeyedExecutor(10);
    const seen: string[] = [];
    ex.submit('a', async () => {
      await sleep(30);
      seen.push('a1');
    });
    ex.submit('a', async () => {
      await sleep(1);
      seen.push('a2');
    });
    ex.submit('a', async () => {
      seen.push('a3');
    });
    await ex.drain();
    assert.deepEqual(seen, ['a1', 'a2', 'a3']);
  });

  it('runs different keys in parallel', async () => {
    const ex = new KeyedExecutor(10);
    const started = Date.now();
    for (let i = 0; i < 10; i++) ex.submit(`k${i}`, () => sleep(50));
    await ex.drain();
    assert.ok(Date.now() - started < 200, 'ten 50 ms tasks on distinct keys should overlap');
  });

  it('never exceeds the concurrency limit', async () => {
    const ex = new KeyedExecutor(3);
    let peak = 0;
    for (let i = 0; i < 20; i++) {
      ex.submit(`k${i}`, async () => {
        peak = Math.max(peak, ex.inFlight);
        await sleep(5);
      });
    }
    await ex.drain();
    assert.equal(peak, 3);
  });

  it('runs every task and reports the first error in drain', async () => {
    const ex = new KeyedExecutor(2);
    let ran = 0;
    ex.submit('a', async () => {
      ran++;
      throw new Error('boom');
    });
    ex.submit('a', async () => {
      ran++;
    });
    ex.submit('b', async () => {
      ran++;
    });
    await assert.rejects(() => ex.drain(), /boom/);
    assert.equal(ran, 3);
    await ex.drain();
  });

  it('rejects invalid concurrency', () => {
    assert.throws(() => new KeyedExecutor(0), RangeError);
  });
});
