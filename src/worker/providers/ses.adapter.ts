import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { DeliveryError } from '../../core/delivery-error';
import { MessageEnvelope } from '../../core/message';
import { ProviderConfig, SendResult } from '../../core/provider-router';
import { classifySesError } from './ses-errors';

/** The subset of the SES client used here, so tests can pass a fake. */
export interface SesSender {
  send(command: SendEmailCommand, options?: { abortSignal?: AbortSignal }): Promise<{ MessageId?: string }>;
}

/**
 * Amazon SES (API v2) SendEmail.
 *
 * Credentials come from the AWS default chain: environment variables locally, an IAM role for
 * service accounts on EKS. The SDK's own retries are turned off (`maxAttempts: 1`): retries and
 * failover belong to the router and the retry tiers, and stacking both would multiply attempts.
 *
 * The message id goes into an SES tag, so bounces and complaints from SES events can be traced
 * back to the message. SES has no idempotency key for SendEmail (see ADR 3).
 */
export function createSesAdapter(clientFor: (region: string) => SesSender = defaultClientFactory()) {
  return async (provider: ProviderConfig, envelope: MessageEnvelope): Promise<SendResult> => {
    const settings = provider.ses;
    if (!settings) throw new DeliveryError(`${provider.name}: ses settings missing`, false, false);

    const command = new SendEmailCommand({
      FromEmailAddress: settings.from,
      Destination: { ToAddresses: [envelope.to] },
      Content: {
        Simple: {
          Subject: { Data: envelope.subject ?? '', Charset: 'UTF-8' },
          Body: { Text: { Data: envelope.body, Charset: 'UTF-8' } },
        },
      },
      ConfigurationSetName: settings.configurationSet,
      EmailTags: [{ Name: 'relay_message_id', Value: envelope.id }],
    });

    try {
      const out = await clientFor(settings.region).send(command, {
        abortSignal: AbortSignal.timeout(provider.timeoutMs ?? 5_000),
      });
      if (!out.MessageId) throw new DeliveryError('ses accepted but returned no MessageId', true, true);
      return { provider: provider.name, providerMessageId: out.MessageId };
    } catch (err) {
      if (err instanceof DeliveryError) throw err;
      throw classifySesError(err);
    }
  };
}

function defaultClientFactory(): (region: string) => SesSender {
  const clients = new Map<string, SESv2Client>();
  return (region) => {
    let client = clients.get(region);
    if (!client) {
      client = new SESv2Client({ region, maxAttempts: 1 });
      clients.set(region, client);
    }
    return client;
  };
}
