import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562): 48-bit Unix milliseconds, then random bits.
 *
 * Message ids are primary keys written at a high rate. Random v4 ids land all over the B-tree
 * and keep splitting pages; time-ordered v7 ids append near the right edge, like a sequence,
 * while staying globally unique without coordination.
 */
export function uuidv7(now: number = Date.now(), random: Buffer = randomBytes(10)): string {
  if (random.length < 10) throw new RangeError('uuidv7 needs 10 random bytes');
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(now, 0, 6);
  random.copy(bytes, 6, 0, 10);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidv7Timestamp(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}
