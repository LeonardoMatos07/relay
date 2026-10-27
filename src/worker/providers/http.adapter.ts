import { classifyHttpStatus, classifyNetworkError, DeliveryError } from '../../core/delivery-error';
import { MessageEnvelope } from '../../core/message';
import { ProviderConfig, SendResult } from '../../core/provider-router';

export type Fetch = typeof fetch;

/**
 * Generic JSON contract (`POST {url}/v1/send` → `{ id }`), spoken by the simulated providers
 * and easy to put in front of any in-house gateway.
 *
 * The message id goes in `Idempotency-Key`. Kafka delivery is at-least-once, and a worker can
 * die after the provider accepted a message but before recording it; providers that honour the
 * key turn that redelivery into a no-op instead of a second SMS.
 */
export function createHttpAdapter(fetchImpl: Fetch = fetch) {
  return async (provider: ProviderConfig, envelope: MessageEnvelope): Promise<SendResult> => {
    let response: Response;
    try {
      response = await fetchImpl(`${provider.url}/v1/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': envelope.id },
        body: JSON.stringify({
          channel: envelope.channel,
          to: envelope.to,
          subject: envelope.subject,
          body: envelope.body,
        }),
        signal: AbortSignal.timeout(provider.timeoutMs ?? 3_000),
      });
    } catch (err) {
      throw classifyNetworkError(err);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw classifyHttpStatus(response.status, detail);
    }
    const body = (await response.json().catch(() => ({}))) as { id?: unknown };
    if (typeof body.id !== 'string') {
      throw new DeliveryError('provider accepted but returned no message id', true, true, response.status);
    }
    return { provider: provider.name, providerMessageId: body.id };
  };
}
