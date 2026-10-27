// End-to-end tests against a running stack (`docker compose up -d`).
//
//   pnpm test:e2e
//
// They drive the simulated providers through their admin API to create outages, so they test
// failover and retries for real instead of mocking them.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const API = process.env.API_URL ?? 'http://localhost:3000';
const MOCKS = {
  'sms-alpha': process.env.MOCK_SMS_ALPHA ?? 'http://localhost:8091',
  'sms-beta': process.env.MOCK_SMS_BETA ?? 'http://localhost:8092',
  'email-alpha': process.env.MOCK_EMAIL_ALPHA ?? 'http://localhost:8093',
  'email-beta': process.env.MOCK_EMAIL_BETA ?? 'http://localhost:8094',
};

const phone = () => `+55719${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

async function send(body, key = `e2e-${randomUUID()}`) {
  const res = await fetch(`${API}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

async function get(id) {
  const res = await fetch(`${API}/v1/messages/${id}`);
  return res.json();
}

async function waitFor(id, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await get(id);
    if (predicate(last)) return last;
    await sleep(250);
  }
  assert.fail(`message ${id} did not reach the expected state; last: ${JSON.stringify(last)}`);
}

async function mock(name, path, body) {
  const res = await fetch(`${MOCKS[name]}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  assert.equal(res.ok, true, `mock ${name} ${path}`);
}

const resetMocks = () => Promise.all(Object.keys(MOCKS).map((n) => mock(n, '/admin/reset')));

describe('relay end to end', () => {
  before(async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const ok = await fetch(`${API}/health/ready`).then(
        (r) => r.ok,
        () => false,
      );
      if (ok) break;
      await sleep(1000);
    }
    await resetMocks();
    // Quiet providers so deterministic tests do not hit random failures.
    await Promise.all(Object.keys(MOCKS).map((n) => mock(n, '/admin/config', { failureRate: 0, throttleRate: 0 })));
  });

  after(resetMocks);

  it('accepts a message and delivers it', async () => {
    const r = await send({ channel: 'sms', to: phone(), body: 'Your code is 123456' });
    assert.equal(r.status, 202);
    const m = await waitFor(r.body.id, (x) => x.status === 'delivered');
    assert.equal(m.attempts, 1);
    assert.match(m.provider, /^sms-/);
  });

  it('replays the same request for the same idempotency key', async () => {
    const key = `e2e-${randomUUID()}`;
    const body = { channel: 'email', to: 'ana@example.com', subject: 'Hi', body: 'Hello' };
    const first = await send(body, key);
    const second = await send(body, key);
    assert.equal(first.status, 202);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('idempotent-replayed'), 'true');
    assert.equal(second.body.id, first.body.id);
  });

  it('rejects a reused idempotency key with a different payload', async () => {
    const key = `e2e-${randomUUID()}`;
    await send({ channel: 'sms', to: phone(), body: 'one' }, key);
    const second = await send({ channel: 'sms', to: phone(), body: 'two' }, key);
    assert.equal(second.status, 409);
  });

  it('validates input and lists every error', async () => {
    const r = await send({ channel: 'email', to: 'not-an-email' });
    assert.equal(r.status, 400);
    assert.ok(r.body.errors.length >= 3);
  });

  it('fails fast and dead-letters a recipient the provider rejects', async () => {
    const r = await send({ channel: 'email', to: 'invalid@example.com', subject: 's', body: 'b' });
    const m = await waitFor(r.body.id, (x) => x.status === 'failed');
    assert.equal(m.attempts, 1, 'a 400 must not be retried');
    assert.match(m.lastError, /non-retryable/);
  });

  it('fails over to the secondary provider during an outage', async () => {
    await mock('sms-alpha', '/admin/config', { outage: true });
    try {
      const sent = await Promise.all(
        Array.from({ length: 30 }, () => send({ channel: 'sms', to: phone(), body: 'failover' })),
      );
      const delivered = await Promise.all(sent.map((s) => waitFor(s.body.id, (x) => x.status === 'delivered')));
      assert.ok(
        delivered.every((m) => m.provider === 'sms-beta'),
        'every message should go through sms-beta',
      );
      assert.ok(
        delivered.every((m) => m.attempts === 1),
        'failover happens inside one attempt',
      );
    } finally {
      await mock('sms-alpha', '/admin/config', { outage: false });
    }
  });

  it('retries later when every provider is down, then delivers', async () => {
    await mock('email-alpha', '/admin/config', { outage: true });
    await mock('email-beta', '/admin/config', { outage: true });
    const r = await send({ channel: 'email', to: 'retry@example.com', subject: 's', body: 'b' });
    try {
      const pending = await waitFor(r.body.id, (x) => x.attempts >= 1 && x.status === 'accepted');
      assert.match(pending.lastError, /503|no provider available/);
    } finally {
      await mock('email-alpha', '/admin/config', { outage: false });
      await mock('email-beta', '/admin/config', { outage: false });
    }
    // Tier 1 waits 5 s; the circuit may need its 15 s cool-down, so allow tier 2 (30 s) too.
    const m = await waitFor(r.body.id, (x) => x.status === 'delivered', 60_000);
    assert.ok(m.attempts >= 2);
  });
});
