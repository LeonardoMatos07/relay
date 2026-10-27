import { createHash } from 'node:crypto';

export const CHANNELS = ['email', 'sms', 'whatsapp', 'push'] as const;
export type Channel = (typeof CHANNELS)[number];

export type MessageStatus = 'accepted' | 'delivered' | 'failed';

export interface SendRequest {
  channel: Channel;
  to: string;
  subject?: string;
  body: string;
  metadata?: Record<string, string>;
}

/** What travels on Kafka. Small and self-contained: workers never read the request table. */
export interface MessageEnvelope extends SendRequest {
  id: string;
  /** Epoch milliseconds when the API accepted the message. */
  acceptedAt: number;
  /** Delivery attempts already made (0 on the first try). */
  attempt: number;
}

export type ValidationResult = { ok: true; value: SendRequest } | { ok: false; errors: string[] };

const MAX_BODY = 4_000;
const MAX_SUBJECT = 200;
const MAX_METADATA_KEYS = 20;

const RECIPIENT_RULES: Record<Channel, { pattern: RegExp; description: string }> = {
  email: { pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, description: 'a valid e-mail address' },
  sms: { pattern: /^\+[1-9]\d{7,14}$/, description: 'an E.164 phone number (e.g. +5571999999999)' },
  whatsapp: { pattern: /^\+[1-9]\d{7,14}$/, description: 'an E.164 phone number (e.g. +5571999999999)' },
  push: { pattern: /^[A-Za-z0-9:_\-.]{16,512}$/, description: 'a device token (16-512 chars)' },
};

function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

/** Validates an untrusted request body. Collects every error instead of stopping at the first. */
export function validateSendRequest(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['body must be a JSON object'] };
  }
  const raw = input as Record<string, unknown>;
  const errors: string[] = [];

  if (!isChannel(raw.channel)) {
    errors.push(`channel must be one of: ${CHANNELS.join(', ')}`);
  }
  if (typeof raw.to !== 'string' || raw.to.trim() === '') {
    errors.push('to is required');
  } else if (isChannel(raw.channel)) {
    const rule = RECIPIENT_RULES[raw.channel];
    if (!rule.pattern.test(raw.to.trim())) errors.push(`to must be ${rule.description}`);
  }
  if (typeof raw.body !== 'string' || raw.body.length === 0) {
    errors.push('body is required');
  } else if (raw.body.length > MAX_BODY) {
    errors.push(`body must have at most ${MAX_BODY} characters`);
  }
  if (raw.subject !== undefined) {
    if (typeof raw.subject !== 'string' || raw.subject.length > MAX_SUBJECT) {
      errors.push(`subject must be a string with at most ${MAX_SUBJECT} characters`);
    }
  } else if (raw.channel === 'email') {
    errors.push('subject is required for email');
  }
  if (raw.metadata !== undefined) {
    const m = raw.metadata;
    const valid =
      typeof m === 'object' &&
      m !== null &&
      !Array.isArray(m) &&
      Object.keys(m).length <= MAX_METADATA_KEYS &&
      Object.values(m).every((v) => typeof v === 'string');
    if (!valid) {
      errors.push(`metadata must be an object with up to ${MAX_METADATA_KEYS} string values`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      channel: raw.channel as Channel,
      to: (raw.to as string).trim(),
      body: raw.body as string,
      ...(raw.subject !== undefined ? { subject: raw.subject as string } : {}),
      ...(raw.metadata !== undefined ? { metadata: raw.metadata as Record<string, string> } : {}),
    },
  };
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_\-:.]{8,128}$/;

export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && IDEMPOTENCY_KEY.test(key);
}

/**
 * Stable fingerprint of a request. Reusing an idempotency key with a different payload is a
 * client bug and must be rejected (409), not silently answered with the first message.
 */
export function requestFingerprint(request: SendRequest): string {
  const canonical = JSON.stringify({
    channel: request.channel,
    to: request.to,
    subject: request.subject ?? null,
    body: request.body,
    metadata: request.metadata
      ? Object.fromEntries(Object.entries(request.metadata).sort(([a], [b]) => a.localeCompare(b)))
      : null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Kafka topic names per channel. One main topic, tiered retry topics and a dead-letter topic. */
export const topics = {
  main: (channel: Channel) => `relay.${channel}`,
  retry: (channel: Channel, tier: number) => `relay.${channel}.retry.${tier}`,
  dlq: (channel: Channel) => `relay.${channel}.dlq`,
};

/**
 * Partition key. Keying by recipient keeps every message for one person on one partition, so a
 * single consumer handles them in order (e.g. an OTP is not overtaken by an older one).
 */
export function partitionKey(envelope: Pick<MessageEnvelope, 'channel' | 'to'>): string {
  return `${envelope.channel}:${envelope.to}`;
}
