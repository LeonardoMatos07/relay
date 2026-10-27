import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DeliveryError } from '../../core/delivery-error';
import { MessageEnvelope } from '../../core/message';
import { ProviderConfig } from '../../core/provider-router';
import { createHttpAdapter, Fetch } from './http.adapter';

const provider: ProviderConfig = {
  name: 'mock',
  channel: 'sms',
  url: 'http://mock:8080',
  priority: 1,
  ratePerSecond: 1,
};
const envelope: MessageEnvelope = {
  id: 'm1',
  channel: 'sms',
  to: '+5571999999999',
  body: 'x',
  acceptedAt: 0,
  attempt: 0,
};

const respond =
  (status: number, body: unknown): Fetch =>
  async () =>
    new Response(JSON.stringify(body), { status });

describe('http adapter', () => {
  it('sends the message id as Idempotency-Key and returns the provider id', async () => {
    let headers: Record<string, string> = {};
    const f: Fetch = async (_url, init) => {
      headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ id: 'p-1' }), { status: 202 });
    };
    assert.deepEqual(await createHttpAdapter(f)(provider, envelope), { provider: 'mock', providerMessageId: 'p-1' });
    assert.equal(headers['idempotency-key'], 'm1');
  });

  it('classifies HTTP failures', async () => {
    await assert.rejects(
      () => createHttpAdapter(respond(503, {}))(provider, envelope),
      (e: DeliveryError) => e.retryable,
    );
    await assert.rejects(
      () => createHttpAdapter(respond(400, {}))(provider, envelope),
      (e: DeliveryError) => !e.retryable,
    );
  });

  it('turns network failures into retryable errors', async () => {
    const f: Fetch = async () => {
      throw new TypeError('fetch failed');
    };
    await assert.rejects(
      () => createHttpAdapter(f)(provider, envelope),
      (e: DeliveryError) => e.retryable && /network/.test(e.message),
    );
  });
});
