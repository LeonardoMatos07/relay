import { MessageEnvelope } from '../../core/message';
import { ProviderCall, ProviderConfig } from '../../core/provider-router';
import { DeliveryError } from '../../core/delivery-error';
import { providerCallDuration } from '../../infra/metrics';
import { createHttpAdapter } from './http.adapter';
import { createSesAdapter } from './ses.adapter';
import { createTwilioAdapter, TwilioCredentials, twilioCredentials } from './twilio.adapter';

/**
 * Builds the function the router calls for every attempt: picks the adapter for the provider's
 * type and measures the call. Credentials are resolved here, at startup, so a misconfigured
 * provider stops the worker with a clear error instead of failing every message.
 */
export function createProviderDispatcher(providers: readonly ProviderConfig[]): ProviderCall {
  const twilioCreds = new Map<string, TwilioCredentials>();
  for (const p of providers) {
    if (p.type === 'twilio') twilioCreds.set(p.name, twilioCredentials(p));
  }

  const adapters = {
    http: createHttpAdapter(),
    twilio: createTwilioAdapter(twilioCreds),
    ses: providers.some((p) => p.type === 'ses') ? createSesAdapter() : undefined,
  };

  return async (provider: ProviderConfig, envelope: MessageEnvelope) => {
    const adapter = adapters[provider.type ?? 'http'];
    if (!adapter) throw new DeliveryError(`${provider.name}: no adapter for ${provider.type}`, false, false);
    const started = process.hrtime.bigint();
    const seconds = () => Number(process.hrtime.bigint() - started) / 1e9;
    try {
      const result = await adapter(provider, envelope);
      providerCallDuration.observe({ provider: provider.name, outcome: 'success' }, seconds());
      return result;
    } catch (err) {
      const outcome = err instanceof DeliveryError && err.statusCode !== undefined ? `http_${err.statusCode}` : 'error';
      providerCallDuration.observe({ provider: provider.name, outcome }, seconds());
      throw err;
    }
  };
}
