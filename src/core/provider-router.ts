import { BreakerOptions, BreakerState, CircuitBreaker, DEFAULT_BREAKER } from './circuit-breaker';
import { DeliveryError, InfrastructureError, NoProviderAvailableError } from './delivery-error';
import { Channel, MessageEnvelope } from './message';

export const PROVIDER_TYPES = ['http', 'ses', 'twilio'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export interface ProviderConfig {
  name: string;
  channel: Channel;
  /**
   * Which adapter talks to this provider. `http` is the generic JSON contract spoken by the
   * simulated providers; `ses` and `twilio` call the real services. Defaults to `http`.
   */
  type?: ProviderType;
  /** Base URL, required for `http`. */
  url?: string;
  /** Lower is preferred. Providers with the same priority share traffic by weight. */
  priority: number;
  /** Relative share among providers of the same priority. Defaults to 1. */
  weight?: number;
  /** Sustained requests per second the contract allows (enforced by the rate limiter). */
  ratePerSecond: number;
  /** Burst size of the token bucket. Defaults to ratePerSecond. */
  burst?: number;
  timeoutMs?: number;
  /** Amazon SES settings, required for `ses`. Credentials come from the AWS default chain. */
  ses?: {
    region: string;
    /** Verified sender, e.g. "Relay <no-reply@example.com>". */
    from: string;
    configurationSet?: string;
  };
  /** Twilio settings, required for `twilio`. */
  twilio?: {
    /** Sender number in E.164, or "whatsapp:+1..." for WhatsApp. Either this or messagingServiceSid. */
    from?: string;
    messagingServiceSid?: string;
    /**
     * Prefix of the environment variables holding the credentials, so several Twilio accounts
     * can coexist: <PREFIX>_ACCOUNT_SID plus <PREFIX>_API_KEY_SID/<PREFIX>_API_KEY_SECRET
     * (preferred) or <PREFIX>_AUTH_TOKEN. Defaults to TWILIO.
     */
    credentialsPrefix?: string;
  };
}

export interface SendResult {
  provider: string;
  providerMessageId: string;
}

export type ProviderCall = (provider: ProviderConfig, envelope: MessageEnvelope) => Promise<SendResult>;

export interface AttemptLog {
  provider: string;
  outcome: 'success' | 'failure' | 'skipped-open';
  error?: string;
}

export interface RouteResult {
  result?: SendResult;
  error?: DeliveryError;
  attempts: AttemptLog[];
}

/**
 * Picks providers for a channel and fails over between them within a single delivery attempt.
 *
 * Order: priority groups ascending; inside a group, a weighted random pick first, then the
 * rest. A provider whose circuit is open is skipped. A retryable failure moves on to the next
 * provider; a non-retryable one (bad recipient, bad payload) stops immediately, since another
 * provider would reject it too.
 */
export class ProviderRouter {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly byChannel = new Map<Channel, ProviderConfig[]>();

  constructor(
    providers: readonly ProviderConfig[],
    breakerOptions: BreakerOptions = DEFAULT_BREAKER,
    now: () => number = Date.now,
    private readonly random: () => number = Math.random,
    onBreakerChange?: (name: string, state: BreakerState) => void,
  ) {
    const names = new Set<string>();
    for (const p of providers) {
      if (names.has(p.name)) throw new Error(`duplicate provider name: ${p.name}`);
      names.add(p.name);
      this.breakers.set(p.name, new CircuitBreaker(p.name, breakerOptions, now, onBreakerChange));
      const list = this.byChannel.get(p.channel) ?? [];
      list.push(p);
      this.byChannel.set(p.channel, list);
    }
  }

  providersFor(channel: Channel): readonly ProviderConfig[] {
    return this.byChannel.get(channel) ?? [];
  }

  breakerState(name: string): BreakerState | undefined {
    return this.breakers.get(name)?.getState();
  }

  /** Candidate order for one attempt (exposed for tests and for observability). */
  order(channel: Channel): ProviderConfig[] {
    const groups = new Map<number, ProviderConfig[]>();
    for (const p of this.providersFor(channel)) {
      const g = groups.get(p.priority) ?? [];
      g.push(p);
      groups.set(p.priority, g);
    }
    const ordered: ProviderConfig[] = [];
    for (const priority of [...groups.keys()].sort((a, b) => a - b)) {
      ordered.push(...this.weightedShuffle(groups.get(priority)!));
    }
    return ordered;
  }

  async send(envelope: MessageEnvelope, call: ProviderCall): Promise<RouteResult> {
    const attempts: AttemptLog[] = [];
    const candidates = this.order(envelope.channel);
    if (candidates.length === 0) {
      return { attempts, error: new DeliveryError(`no provider configured for ${envelope.channel}`, false, false) };
    }
    let lastError: DeliveryError | undefined;

    for (const provider of candidates) {
      const breaker = this.breakers.get(provider.name)!;
      if (!breaker.tryAcquire()) {
        attempts.push({ provider: provider.name, outcome: 'skipped-open' });
        continue;
      }
      try {
        const result = await call(provider, envelope);
        breaker.recordSuccess();
        attempts.push({ provider: provider.name, outcome: 'success' });
        return { result, attempts };
      } catch (err) {
        if (err instanceof InfrastructureError) {
          breaker.release();
          throw err;
        }
        const error = err instanceof DeliveryError ? err : new DeliveryError(String(err), true, true);
        if (error.countsAgainstProvider) breaker.recordFailure();
        else breaker.recordSuccess();
        attempts.push({ provider: provider.name, outcome: 'failure', error: error.message });
        lastError = error;
        if (!error.retryable) return { error, attempts };
      }
    }
    return { error: lastError ?? new NoProviderAvailableError(envelope.channel), attempts };
  }

  private weightedShuffle(group: ProviderConfig[]): ProviderConfig[] {
    const pool = [...group];
    const out: ProviderConfig[] = [];
    while (pool.length > 0) {
      const total = pool.reduce((sum, p) => sum + (p.weight ?? 1), 0);
      let pick = this.random() * total;
      let index = 0;
      for (; index < pool.length - 1; index++) {
        pick -= pool[index]!.weight ?? 1;
        if (pick < 0) break;
      }
      out.push(pool.splice(index, 1)[0]!);
    }
    return out;
  }
}

/** Validates the providers file loaded at startup. Fails fast with every problem listed. */
export function parseProviders(raw: unknown): ProviderConfig[] {
  if (!Array.isArray(raw)) throw new Error('providers config must be a JSON array');
  const errors: string[] = [];
  raw.forEach((p, i) => {
    const where = `providers[${i}]`;
    if (typeof p !== 'object' || p === null) return errors.push(`${where} must be an object`);
    const c = p as Record<string, unknown>;
    const type = (c.type ?? 'http') as string;
    if (typeof c.name !== 'string' || !c.name) errors.push(`${where}.name is required`);
    if (!['email', 'sms', 'whatsapp', 'push'].includes(c.channel as string)) errors.push(`${where}.channel is invalid`);
    if (!(PROVIDER_TYPES as readonly string[]).includes(type))
      errors.push(`${where}.type must be one of ${PROVIDER_TYPES.join(', ')}`);
    if (!Number.isInteger(c.priority)) errors.push(`${where}.priority must be an integer`);
    if (typeof c.ratePerSecond !== 'number' || c.ratePerSecond <= 0) errors.push(`${where}.ratePerSecond must be > 0`);

    if (type === 'http' && (typeof c.url !== 'string' || !/^https?:\/\//.test(c.url))) {
      errors.push(`${where}.url must be http(s)`);
    }
    if (type === 'ses') {
      const ses = c.ses as Record<string, unknown> | undefined;
      if (c.channel !== 'email') errors.push(`${where}: ses only sends email`);
      if (typeof ses?.region !== 'string' || !ses.region) errors.push(`${where}.ses.region is required`);
      if (typeof ses?.from !== 'string' || !ses.from.includes('@'))
        errors.push(`${where}.ses.from must be an e-mail address`);
    }
    if (type === 'twilio') {
      const tw = c.twilio as Record<string, unknown> | undefined;
      if (c.channel !== 'sms' && c.channel !== 'whatsapp') errors.push(`${where}: twilio sends sms or whatsapp`);
      if (typeof tw?.from !== 'string' && typeof tw?.messagingServiceSid !== 'string') {
        errors.push(`${where}.twilio needs from or messagingServiceSid`);
      }
    }
    return undefined;
  });
  if (errors.length > 0) throw new Error(`invalid providers config:\n- ${errors.join('\n- ')}`);
  return raw as ProviderConfig[];
}
