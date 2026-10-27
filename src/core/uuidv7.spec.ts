import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { uuidv7, uuidv7Timestamp } from './uuidv7';

describe('uuidv7', () => {
  it('has the v7 version and RFC variant', () => {
    const id = uuidv7();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('embeds the timestamp', () => {
    const now = Date.UTC(2026, 9, 27, 12, 0, 0);
    assert.equal(uuidv7Timestamp(uuidv7(now)), now);
  });

  it('sorts by creation time', () => {
    const ids = [3, 1, 2].map((t) => uuidv7(1_700_000_000_000 + t));
    assert.deepEqual([...ids].sort(), [ids[1], ids[2], ids[0]]);
  });
});
