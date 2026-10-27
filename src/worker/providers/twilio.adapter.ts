import { classifyHttpStatus, classifyNetworkError, DeliveryError } from '../../core/delivery-error';
import { MessageEnvelope } from '../../core/message';
import { ProviderConfig, SendResult } from '../../core/provider-router';
import type { Fetch } from './http.adapter';

const API = 'https://api.twilio.com/2010-04-01';

export interface TwilioCredentials {
  accountSid: string;
  /** API Key SID (preferred) or the Account SID when using the Auth Token. */
  username: string;
  password: string;
}

/**
 * Reads credentials for a provider from `<PREFIX>_*` variables. Called at startup for every
 * Twilio provider, so a missing secret stops the worker instead of failing every message.
 */
export function twilioCredentials(provider: ProviderConfig, env: NodeJS.ProcessEnv = process.env): TwilioCredentials {
  const prefix = provider.twilio?.credentialsPrefix ?? 'TWILIO';
  const accountSid = env[`${prefix}_ACCOUNT_SID`];
  const keySid = env[`${prefix}_API_KEY_SID`];
  const keySecret = env[`${prefix}_API_KEY_SECRET`];
  const authToken = env[`${prefix}_AUTH_TOKEN`];
  if (!accountSid) throw new Error(`${provider.name}: ${prefix}_ACCOUNT_SID is not set`);
  if (keySid && keySecret) return { accountSid, username: keySid, password: keySecret };
  if (authToken) return { accountSid, username: accountSid, password: authToken };
  throw new Error(`${provider.name}: set ${prefix}_API_KEY_SID and ${prefix}_API_KEY_SECRET (or ${prefix}_AUTH_TOKEN)`);
}

/**
 * Twilio error codes that mean "this message can never be delivered", regardless of retries or
 * provider: the recipient is invalid, unsubscribed, unreachable or not allowed.
 * https://www.twilio.com/docs/api/errors
 */
const PERMANENT_CODES = new Set([
  21211, // invalid 'To' number
  21214, // 'To' number cannot be reached
  21408, // permission to send to this region not enabled
  21610, // recipient replied STOP
  21612, // 'To' not reachable via this carrier/route
  21614, // 'To' is not a mobile number
  21608, // trial account: number not verified
  63003, // WhatsApp: invalid channel address
]);

/** Codes that mean our sender or account setup at Twilio is broken: fail over to another provider. */
const ACCOUNT_CODES = new Set([
  20003, // authentication failed
  21606, // 'From' is not a valid SMS-capable number on this account
  21659, // 'From' is not a Twilio number
  21705, // messaging service invalid
  63007, // WhatsApp sender not found
]);

export function classifyTwilioError(status: number, code: number | undefined, message: string): DeliveryError {
  const detail = `twilio ${code ?? '?'}: ${message}`.slice(0, 200);
  if (code !== undefined && PERMANENT_CODES.has(code)) return new DeliveryError(detail, false, false, status);
  if (code !== undefined && ACCOUNT_CODES.has(code)) return new DeliveryError(detail, true, true, status);
  return classifyHttpStatus(status, detail);
}

/**
 * Twilio Programmable Messaging over its REST API (no SDK: one form-encoded POST).
 *
 * WhatsApp uses the same endpoint with `whatsapp:` addresses.
 * Twilio's Messages API has no idempotency key, so the duplicate window described in ADR 3
 * applies to this provider; the router still never calls it twice for one attempt.
 */
export function createTwilioAdapter(credentials: Map<string, TwilioCredentials>, fetchImpl: Fetch = fetch) {
  return async (provider: ProviderConfig, envelope: MessageEnvelope): Promise<SendResult> => {
    const creds = credentials.get(provider.name);
    if (!creds) throw new DeliveryError(`${provider.name}: credentials not loaded`, true, true);
    const settings = provider.twilio ?? {};
    const whatsapp = envelope.channel === 'whatsapp';
    const address = (n: string) => (whatsapp && !n.startsWith('whatsapp:') ? `whatsapp:${n}` : n);

    const form = new URLSearchParams({ To: address(envelope.to), Body: envelope.body });
    if (settings.messagingServiceSid) form.set('MessagingServiceSid', settings.messagingServiceSid);
    else if (settings.from) form.set('From', address(settings.from));

    let response: Response;
    try {
      response = await fetchImpl(`${API}/Accounts/${creds.accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(provider.timeoutMs ?? 5_000),
      });
    } catch (err) {
      throw classifyNetworkError(err);
    }

    const body = (await response.json().catch(() => ({}))) as { sid?: unknown; code?: unknown; message?: unknown };
    if (!response.ok) {
      const code = typeof body.code === 'number' ? body.code : undefined;
      throw classifyTwilioError(response.status, code, typeof body.message === 'string' ? body.message : '');
    }
    if (typeof body.sid !== 'string') {
      throw new DeliveryError('twilio accepted but returned no sid', true, true, response.status);
    }
    return { provider: provider.name, providerMessageId: body.sid };
  };
}
