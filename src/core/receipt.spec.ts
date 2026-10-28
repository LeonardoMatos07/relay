import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { advance, suppresses, validateReceipt, type DeliveryStatus, type ReceiptType } from './receipt';

const valid = {
  schema: 1,
  id: 'ses:abc:Delivery:2026-10-27T22:12:54.994Z',
  provider: 'ses',
  providerMessageId: '010100abc',
  relayMessageId: '01a17f6c-6929-761e-8307-76cdee1dc7fc',
  channel: 'email',
  recipient: 'ana@example.com',
  type: 'delivered',
  occurredAt: '2026-10-27T22:12:54.994Z',
};

describe('validateReceipt', () => {
  it('accepts a complete receipt and normalizes the date', () => {
    const r = validateReceipt({ ...valid, occurredAt: '2026-10-27T19:12:54.994-03:00' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.occurredAt, '2026-10-27T22:12:54.994Z');
  });

  it('accepts a receipt that only knows the provider message id', () => {
    const { relayMessageId: _omitted, ...rest } = valid;
    assert.equal(validateReceipt(rest).ok, true);
  });

  it('needs some way to find the message', () => {
    const { relayMessageId: _a, providerMessageId: _b, ...rest } = valid;
    const r = validateReceipt(rest);
    assert.deepEqual(r, { ok: false, errors: ['relayMessageId or providerMessageId is required'] });
  });

  it('lists every problem', () => {
    const r = validateReceipt({ schema: 2, type: 'opened', channel: 'fax', occurredAt: 'yesterday' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.errors.includes('schema must be 1'));
      assert.ok(r.errors.includes('id is required'));
      assert.ok(r.errors.some((e) => e.startsWith('type must be one of')));
      assert.ok(r.errors.some((e) => e.startsWith('channel must be one of')));
      assert.ok(r.errors.includes('occurredAt must be an ISO 8601 date'));
    }
  });

  it('rejects a relay id that is not a UUID and non-object bodies', () => {
    assert.equal(validateReceipt({ ...valid, relayMessageId: 'abc' }).ok, false);
    assert.equal(validateReceipt('x').ok, false);
    assert.equal(validateReceipt(null).ok, false);
  });
});

describe('advance', () => {
  const order: ReceiptType[] = ['sent', 'delayed', 'delivered', 'bounced', 'complained'];

  it('moves forward through the lifecycle', () => {
    let status: DeliveryStatus = 'pending';
    for (const next of order) {
      status = advance(status, next);
      assert.equal(status, next);
    }
  });

  it('ignores a receipt that arrives late', () => {
    assert.equal(advance('delivered', 'sent'), 'delivered');
    assert.equal(advance('delivered', 'delayed'), 'delivered');
    assert.equal(advance('complained', 'bounced'), 'complained');
  });

  it('lets a bounce or a complaint override a delivery', () => {
    assert.equal(advance('delivered', 'bounced'), 'bounced');
    assert.equal(advance('delivered', 'complained'), 'complained');
  });

  it('is idempotent', () => {
    for (const type of order) assert.equal(advance(type, type), type);
  });
});

describe('suppresses', () => {
  it('suppresses hard bounces and complaints only', () => {
    assert.equal(suppresses({ type: 'bounced', permanent: true }), true);
    assert.equal(suppresses({ type: 'complained' }), true);
    assert.equal(suppresses({ type: 'bounced', permanent: false }), false);
    assert.equal(suppresses({ type: 'bounced' }), false);
    assert.equal(suppresses({ type: 'delivered' }), false);
    assert.equal(suppresses({ type: 'rejected' }), false);
  });
});
