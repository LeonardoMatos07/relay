import { classifyHttpStatus, classifyNetworkError, DeliveryError } from '../core/delivery-error';
import { MessageEnvelope } from '../core/message';
import { ProviderConfig, SendResult } from '../core/provider-router';
import { providerCallDuration } from '../infra/metrics';

/**
 * Calls a provider's HTTP API.
 *
 * The message id goes in `Idempotency-Key`. Kafka delivery is at-least-once, and a worker can
 * die after the provider accepted a message but before recording it; providers that honour the
 * key turn that redelivery into a no-op instead of a second SMS.
 */
export async function callProvider(provider: ProviderConfig, envelope: MessageEnvelope): Promise<SendResult> {
  const started = process.hrtime.bigint();
  const observe = (outcome: string) =>
    providerCallDuration.observe({ provider: provider.name, outcome }, Number(process.hrtime.bigint() - started) / 1e9);

  let response: Response;
  try {
    response = await fetch(`${provider.url}/v1/send`, {
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
    observe('network_error');
    throw classifyNetworkError(err);
  }

  if (!response.ok) {
    observe(`http_${response.status}`);
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    throw classifyHttpStatus(response.status, detail);
  }

  observe('success');
  const body = (await response.json().catch(() => ({}))) as { id?: unknown };
  if (typeof body.id !== 'string') {
    throw new DeliveryError('provider accepted but returned no message id', true, true, response.status);
  }
  return { provider: provider.name, providerMessageId: body.id };
}
