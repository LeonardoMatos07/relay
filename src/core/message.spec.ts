import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isValidIdempotencyKey, partitionKey, requestFingerprint, topics, validateSendRequest } from './message';

describe('validateSendRequest', () => {
  it('accepts a valid e-mail and trims the recipient', () => {
    const r = validateSendRequest({ channel: 'email', to: ' ana@example.com ', subject: 'Hi', body: 'Hello' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.to, 'ana@example.com');
  });

  it('accepts sms with an E.164 number and no subject', () => {
    const r = validateSendRequest({ channel: 'sms', to: '+5571999999999', body: 'code 123456' });
    assert.equal(r.ok, true);
  });

  it('collects every error at once', () => {
    const r = validateSendRequest({ channel: 'fax', body: '' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.errors.some((e) => e.startsWith('channel')));
      assert.ok(r.errors.includes('to is required'));
      assert.ok(r.errors.includes('body is required'));
    }
  });

  it('checks the recipient format per channel', () => {
    const r = validateSendRequest({ channel: 'sms', to: '71999999999', body: 'x' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors[0]!, /E\.164/);
  });

  it('requires a subject for e-mail', () => {
    const r = validateSendRequest({ channel: 'email', to: 'a@b.co', body: 'x' });
    assert.deepEqual(r, { ok: false, errors: ['subject is required for email'] });
  });

  it('rejects non-string metadata values and non-object bodies', () => {
    assert.equal(
      validateSendRequest({ channel: 'sms', to: '+5571999999999', body: 'x', metadata: { a: 1 } }).ok,
      false,
    );
    assert.equal(validateSendRequest([]).ok, false);
    assert.equal(validateSendRequest(null).ok, false);
  });

  it('rejects bodies over the limit', () => {
    const r = validateSendRequest({ channel: 'sms', to: '+5571999999999', body: 'x'.repeat(4001) });
    assert.equal(r.ok, false);
  });
});

describe('idempotency', () => {
  it('validates key format', () => {
    assert.equal(isValidIdempotencyKey('order-123:otp'), true);
    assert.equal(isValidIdempotencyKey('short'), false);
    assert.equal(isValidIdempotencyKey('has spaces in it'), false);
    assert.equal(isValidIdempotencyKey(undefined), false);
  });

  it('fingerprints ignore metadata key order but not content', () => {
    const base = { channel: 'sms' as const, to: '+5571999999999', body: 'x' };
    const a = requestFingerprint({ ...base, metadata: { a: '1', b: '2' } });
    const b = requestFingerprint({ ...base, metadata: { b: '2', a: '1' } });
    const c = requestFingerprint({ ...base, body: 'y', metadata: { a: '1', b: '2' } });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe('topics and keys', () => {
  it('names topics per channel', () => {
    assert.equal(topics.main('email'), 'relay.email');
    assert.equal(topics.retry('sms', 2), 'relay.sms.retry.2');
    assert.equal(topics.dlq('push'), 'relay.push.dlq');
  });

  it('keys by channel and recipient', () => {
    assert.equal(partitionKey({ channel: 'sms', to: '+5571999999999' }), 'sms:+5571999999999');
  });
});
