import { CHANNELS, type Channel } from './message';

/**
 * A delivery receipt: what a provider later says about a message Relay handed to it. Providers
 * speak in their own formats (SES events, Twilio status callbacks); something in front of Relay
 * turns each into this one shape, so Relay never learns a provider's vocabulary.
 */
export const RECEIPT_TYPES = ['sent', 'delivered', 'delayed', 'bounced', 'complained', 'rejected'] as const;
export type ReceiptType = (typeof RECEIPT_TYPES)[number];

export interface Receipt {
  schema: 1;
  /** Stable id of the provider event. The same event delivered twice has the same id. */
  id: string;
  provider: string;
  /** The id the provider gave the message when Relay handed it over. */
  providerMessageId?: string;
  /** Relay's own id, when the provider echoes it back (SES tag `relay_message_id`). */
  relayMessageId?: string;
  channel: Channel;
  recipient: string;
  type: ReceiptType;
  /** For `bounced`: true for a hard bounce, which suppresses the recipient. */
  permanent?: boolean;
  reason?: string;
  occurredAt: string;
}

/** Where a message stands according to its receipts. */
export type DeliveryStatus = 'pending' | ReceiptType;

/**
 * Receipts can arrive late and out of order, so a message only moves forward: the status with the
 * highest rank wins. A bounce after a "delivered" is a real outcome and overrides it; a late
 * "sent" or "delayed" never overrides "delivered".
 */
const RANK: Record<DeliveryStatus, number> = {
  pending: 0,
  sent: 1,
  delayed: 2,
  delivered: 3,
  bounced: 4,
  rejected: 4,
  complained: 5,
};

export function advance(current: DeliveryStatus, incoming: ReceiptType): DeliveryStatus {
  return RANK[incoming] > RANK[current] ? incoming : current;
}

/** Outcomes that mean "stop sending to this address". */
export function suppresses(receipt: Pick<Receipt, 'type' | 'permanent'>): boolean {
  return receipt.type === 'complained' || (receipt.type === 'bounced' && receipt.permanent === true);
}

export type ReceiptValidation = { ok: true; value: Receipt } | { ok: false; errors: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 512;

function text(value: unknown, name: string, errors: string[], required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) errors.push(`${name} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT) {
    errors.push(`${name} must be a non-empty string of at most ${MAX_TEXT} characters`);
    return undefined;
  }
  return value.trim();
}

export function validateReceipt(input: unknown): ReceiptValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['body must be a JSON object'] };
  }
  const raw = input as Record<string, unknown>;
  const errors: string[] = [];

  if (raw.schema !== 1) errors.push('schema must be 1');
  const id = text(raw.id, 'id', errors, true);
  const provider = text(raw.provider, 'provider', errors, true);
  const providerMessageId = text(raw.providerMessageId, 'providerMessageId', errors, false);
  const relayMessageId = text(raw.relayMessageId, 'relayMessageId', errors, false);
  const recipient = text(raw.recipient, 'recipient', errors, true);
  const reason = text(raw.reason, 'reason', errors, false);

  if (relayMessageId !== undefined && !UUID.test(relayMessageId)) errors.push('relayMessageId must be a UUID');
  if (relayMessageId === undefined && providerMessageId === undefined) {
    errors.push('relayMessageId or providerMessageId is required');
  }
  if (typeof raw.channel !== 'string' || !(CHANNELS as readonly string[]).includes(raw.channel)) {
    errors.push(`channel must be one of: ${CHANNELS.join(', ')}`);
  }
  if (typeof raw.type !== 'string' || !(RECEIPT_TYPES as readonly string[]).includes(raw.type)) {
    errors.push(`type must be one of: ${RECEIPT_TYPES.join(', ')}`);
  }
  if (raw.permanent !== undefined && typeof raw.permanent !== 'boolean') errors.push('permanent must be a boolean');
  const occurredAt = typeof raw.occurredAt === 'string' ? new Date(raw.occurredAt) : undefined;
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) errors.push('occurredAt must be an ISO 8601 date');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schema: 1,
      id: id!,
      provider: provider!,
      ...(providerMessageId !== undefined ? { providerMessageId } : {}),
      ...(relayMessageId !== undefined ? { relayMessageId } : {}),
      channel: raw.channel as Channel,
      recipient: recipient!,
      type: raw.type as ReceiptType,
      ...(raw.permanent !== undefined ? { permanent: raw.permanent as boolean } : {}),
      ...(reason !== undefined ? { reason } : {}),
      occurredAt: occurredAt!.toISOString(),
    },
  };
}
