import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DeliveryError } from '../../core/delivery-error';
import { MessageEnvelope } from '../../core/message';
import { ProviderConfig } from '../../core/provider-router';
import { createSesAdapter, SesSender } from './ses.adapter';

const provider: ProviderConfig = {
  name: 'ses-br',
  channel: 'email',
  type: 'ses',
  priority: 1,
  ratePerSecond: 14,
  ses: { region: 'sa-east-1', from: 'Relay <no-reply@example.com>', configurationSet: 'relay' },
};

const envelope: MessageEnvelope = {
  id: '0192f0a1-0000-7000-8000-000000000002',
  channel: 'email',
  to: 'ana@example.com',
  subject: 'Your code',
  body: '123456',
  acceptedAt: 0,
  attempt: 0,
};

describe('ses adapter', () => {
  it('builds a SendEmail request for the provider region and returns the MessageId', async () => {
    const seen: Array<{ region: string; input: unknown }> = [];
    const clientFor = (region: string): SesSender => ({
      send: async (command) => {
        seen.push({ region, input: command.input });
        return { MessageId: 'ses-1' };
      },
    });
    const result = await createSesAdapter(clientFor)(provider, envelope);
    assert.deepEqual(result, { provider: 'ses-br', providerMessageId: 'ses-1' });
    assert.equal(seen[0]!.region, 'sa-east-1');
    assert.deepEqual(seen[0]!.input, {
      FromEmailAddress: 'Relay <no-reply@example.com>',
      Destination: { ToAddresses: ['ana@example.com'] },
      Content: {
        Simple: {
          Subject: { Data: 'Your code', Charset: 'UTF-8' },
          Body: { Text: { Data: '123456', Charset: 'UTF-8' } },
        },
      },
      ConfigurationSetName: 'relay',
      EmailTags: [{ Name: 'relay_message_id', Value: envelope.id }],
    });
  });

  it('maps SDK errors through classifySesError', async () => {
    const clientFor = (): SesSender => ({
      send: async () => {
        throw Object.assign(new Error('Email address is not verified'), {
          name: 'MessageRejected',
          $metadata: { httpStatusCode: 400 },
        });
      },
    });
    await assert.rejects(
      () => createSesAdapter(clientFor)(provider, envelope),
      (e: DeliveryError) => !e.retryable && /MessageRejected/.test(e.message),
    );
  });
});
