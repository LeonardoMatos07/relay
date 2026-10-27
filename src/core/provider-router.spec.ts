import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classifyHttpStatus, InfrastructureError } from './delivery-error';
import { MessageEnvelope } from './message';
import { parseProviders, ProviderCall, ProviderConfig, ProviderRouter } from './provider-router';

const providers: ProviderConfig[] = [
  { name: 'sms-a', channel: 'sms', url: 'http://a', priority: 1, weight: 3, ratePerSecond: 100 },
  { name: 'sms-b', channel: 'sms', url: 'http://b', priority: 1, weight: 1, ratePerSecond: 100 },
  { name: 'sms-c', channel: 'sms', url: 'http://c', priority: 2, ratePerSecond: 100 },
  { name: 'mail-a', channel: 'email', url: 'http://m', priority: 1, ratePerSecond: 100 },
];

const envelope: MessageEnvelope = {
  id: 'm1',
  channel: 'sms',
  to: '+5571999999999',
  body: 'x',
  acceptedAt: 0,
  attempt: 0,
};

const breaker = { windowSize: 4, minimumCalls: 2, failureRateThreshold: 0.5, openMs: 1000, halfOpenProbes: 1 };

function callWith(behaviour: Record<string, 'ok' | number>): ProviderCall & { calls: string[] } {
  const calls: string[] = [];
  const fn: ProviderCall = async (p) => {
    calls.push(p.name);
    const b = behaviour[p.name] ?? 'ok';
    if (b === 'ok') return { provider: p.name, providerMessageId: `${p.name}-1` };
    throw classifyHttpStatus(b);
  };
  return Object.assign(fn, { calls });
}

describe('ProviderRouter.order', () => {
  it('keeps priority groups in order and only shuffles inside a group', () => {
    const router = new ProviderRouter(
      providers,
      breaker,
      () => 0,
      () => 0.99,
    );
    assert.deepEqual(
      router.order('sms').map((p) => p.name),
      ['sms-b', 'sms-a', 'sms-c'],
    );
    const router2 = new ProviderRouter(
      providers,
      breaker,
      () => 0,
      () => 0,
    );
    assert.deepEqual(
      router2.order('sms').map((p) => p.name),
      ['sms-a', 'sms-b', 'sms-c'],
    );
  });

  it('respects weights statistically', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const router = new ProviderRouter(providers, breaker, () => 0, rand);
    let a = 0;
    for (let i = 0; i < 4000; i++) if (router.order('sms')[0]!.name === 'sms-a') a++;
    assert.ok(a > 2800 && a < 3200, `expected ~75% for sms-a, got ${a / 40}%`);
  });
});

describe('ProviderRouter.send', () => {
  it('fails over to the next provider on a retryable error', async () => {
    const router = new ProviderRouter(
      providers,
      breaker,
      () => 0,
      () => 0,
    );
    const call = callWith({ 'sms-a': 503 });
    const r = await router.send(envelope, call);
    assert.equal(r.result?.provider, 'sms-b');
    assert.deepEqual(call.calls, ['sms-a', 'sms-b']);
  });

  it('stops on a non-retryable error without touching other providers', async () => {
    const router = new ProviderRouter(
      providers,
      breaker,
      () => 0,
      () => 0,
    );
    const call = callWith({ 'sms-a': 400 });
    const r = await router.send(envelope, call);
    assert.equal(r.error?.retryable, false);
    assert.deepEqual(call.calls, ['sms-a']);
  });

  it('skips a provider once its circuit opens', async () => {
    const router = new ProviderRouter(
      providers,
      breaker,
      () => 0,
      () => 0,
    );
    const call = callWith({ 'sms-a': 503 });
    await router.send(envelope, call);
    await router.send(envelope, call);
    assert.equal(router.breakerState('sms-a'), 'open');
    call.calls.length = 0;
    const r = await router.send(envelope, call);
    assert.deepEqual(call.calls, ['sms-b']);
    assert.equal(r.attempts[0]!.outcome, 'skipped-open');
  });

  it('client errors do not open the circuit', async () => {
    const router = new ProviderRouter(
      providers,
      breaker,
      () => 0,
      () => 0,
    );
    const call = callWith({ 'sms-a': 400 });
    for (let i = 0; i < 5; i++) await router.send(envelope, call);
    assert.equal(router.breakerState('sms-a'), 'closed');
  });

  it('returns the last retryable error when every provider fails', async () => {
    const router = new ProviderRouter(
      providers,
      breaker,
      () => 0,
      () => 0,
    );
    const r = await router.send(envelope, callWith({ 'sms-a': 503, 'sms-b': 500, 'sms-c': 429 }));
    assert.equal(r.error?.statusCode, 429);
    assert.equal(r.error?.retryable, true);
    assert.equal(r.attempts.length, 3);
  });

  it('propagates infrastructure errors without touching circuits or failing over', async () => {
    const router = new ProviderRouter(
      providers,
      breaker,
      () => 0,
      () => 0,
    );
    const calls: string[] = [];
    const call: ProviderCall = async (p) => {
      calls.push(p.name);
      throw new InfrastructureError('redis down');
    };
    for (let i = 0; i < 3; i++) await assert.rejects(() => router.send(envelope, call), InfrastructureError);
    assert.deepEqual(calls, ['sms-a', 'sms-a', 'sms-a']);
    assert.equal(router.breakerState('sms-a'), 'closed');
  });

  it('reports a configuration error for a channel without providers', async () => {
    const router = new ProviderRouter(providers, breaker);
    const r = await router.send({ ...envelope, channel: 'push' }, callWith({}));
    assert.equal(r.error?.retryable, false);
  });
});

describe('parseProviders', () => {
  it('accepts a valid file and lists every problem otherwise', () => {
    assert.equal(parseProviders(providers).length, 4);
    assert.throws(
      () => parseProviders([{ name: '', channel: 'fax', url: 'ftp://x', priority: 1.5, ratePerSecond: 0 }]),
      (e: Error) => e.message.split('\n- ').length === 6,
    );
  });

  it('validates settings per provider type', () => {
    const base = { name: 'x', priority: 1, ratePerSecond: 1 };
    assert.throws(() => parseProviders([{ ...base, channel: 'email', type: 'ses' }]), /ses\.region.*\n.*ses\.from/s);
    assert.throws(() => parseProviders([{ ...base, channel: 'push', type: 'twilio', twilio: {} }]), /twilio sends sms/);
    assert.throws(() => parseProviders([{ ...base, channel: 'sms', type: 'twilio', twilio: {} }]), /needs from/);
    assert.equal(
      parseProviders([{ ...base, channel: 'email', type: 'ses', ses: { region: 'sa-east-1', from: 'a@b.co' } }]).length,
      1,
    );
    assert.equal(parseProviders([{ ...base, channel: 'sms', type: 'twilio', twilio: { from: '+1' } }]).length, 1);
  });

  it('rejects duplicate names', () => {
    assert.throws(() => new ProviderRouter([providers[0]!, providers[0]!]), /duplicate/);
  });
});
