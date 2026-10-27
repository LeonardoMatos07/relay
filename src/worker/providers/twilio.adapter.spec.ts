import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DeliveryError } from '../../core/delivery-error';
import { MessageEnvelope } from '../../core/message';
import { ProviderConfig } from '../../core/provider-router';
import type { Fetch } from './http.adapter';
import { classifyTwilioError, createTwilioAdapter, twilioCredentials } from './twilio.adapter';

const sms: ProviderConfig = {
  name: 'twilio-sms',
  channel: 'sms',
  type: 'twilio',
  priority: 1,
  ratePerSecond: 10,
  twilio: { from: '+15005550006' },
};

const envelope: MessageEnvelope = {
  id: '0192f0a1-0000-7000-8000-000000000001',
  channel: 'sms',
  to: '+5571999999999',
  body: 'Your code is 123456',
  acceptedAt: 0,
  attempt: 0,
};

const creds = new Map([['twilio-sms', { accountSid: 'AC123', username: 'SK456', password: 'secret' }]]);

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn: Fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return Object.assign(fn, { calls });
}

describe('twilio adapter', () => {
  it('posts a form to the Messages endpoint with basic auth and returns the sid', async () => {
    const f = fakeFetch(201, { sid: 'SM789', status: 'queued' });
    const result = await createTwilioAdapter(creds, f)(sms, envelope);
    assert.deepEqual(result, { provider: 'twilio-sms', providerMessageId: 'SM789' });

    const call = f.calls[0]!;
    assert.equal(call.url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Basic ${Buffer.from('SK456:secret').toString('base64')}`);
    const form = new URLSearchParams(String(call.init.body));
    assert.equal(form.get('To'), '+5571999999999');
    assert.equal(form.get('From'), '+15005550006');
    assert.equal(form.get('Body'), 'Your code is 123456');
  });

  it('prefixes whatsapp addresses and prefers a messaging service', async () => {
    const f = fakeFetch(201, { sid: 'SM1' });
    const wa: ProviderConfig = { ...sms, channel: 'whatsapp', twilio: { messagingServiceSid: 'MG1', from: '+1415' } };
    await createTwilioAdapter(new Map([[wa.name, creds.get('twilio-sms')!]]), f)(wa, {
      ...envelope,
      channel: 'whatsapp',
    });
    const form = new URLSearchParams(String(f.calls[0]!.init.body));
    assert.equal(form.get('To'), 'whatsapp:+5571999999999');
    assert.equal(form.get('MessagingServiceSid'), 'MG1');
    assert.equal(form.get('From'), null);
  });

  it('maps an invalid recipient to a permanent error', async () => {
    const f = fakeFetch(400, { code: 21211, message: "The 'To' number is not valid" });
    await assert.rejects(
      () => createTwilioAdapter(creds, f)(sms, envelope),
      (e: DeliveryError) => !e.retryable && !e.countsAgainstProvider && /21211/.test(e.message),
    );
  });

  it('maps a broken sender to failover (retryable, counts against the provider)', async () => {
    const f = fakeFetch(400, { code: 21606, message: 'From is not a valid number' });
    await assert.rejects(
      () => createTwilioAdapter(creds, f)(sms, envelope),
      (e: DeliveryError) => e.retryable && e.countsAgainstProvider,
    );
  });

  it('classifies unknown codes by HTTP status', () => {
    assert.equal(classifyTwilioError(503, undefined, 'down').retryable, true);
    assert.equal(classifyTwilioError(429, 20429, 'too many').retryable, true);
    assert.equal(classifyTwilioError(401, 20003, 'auth').countsAgainstProvider, true);
    assert.equal(classifyTwilioError(400, 99999, 'odd').retryable, false);
  });
});

describe('twilioCredentials', () => {
  it('prefers an API key and supports custom prefixes', () => {
    const p = { ...sms, twilio: { from: '+1', credentialsPrefix: 'TWILIO_BR' } };
    const env = { TWILIO_BR_ACCOUNT_SID: 'AC1', TWILIO_BR_API_KEY_SID: 'SK1', TWILIO_BR_API_KEY_SECRET: 's' };
    assert.deepEqual(twilioCredentials(p, env), { accountSid: 'AC1', username: 'SK1', password: 's' });
  });

  it('falls back to the auth token', () => {
    const env = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' };
    assert.deepEqual(twilioCredentials(sms, env), { accountSid: 'AC1', username: 'AC1', password: 't' });
  });

  it('fails fast with a clear message when secrets are missing', () => {
    assert.throws(() => twilioCredentials(sms, {}), /TWILIO_ACCOUNT_SID/);
    assert.throws(() => twilioCredentials(sms, { TWILIO_ACCOUNT_SID: 'AC1' }), /API_KEY_SID/);
  });
});
