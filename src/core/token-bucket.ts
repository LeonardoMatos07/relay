/**
 * Token bucket rate limiter, shared by every worker through Redis.
 *
 * The provider contract limits requests per second for the whole fleet, not per pod, so the
 * bucket must live outside the process. The check-and-take runs as one Lua script, which Redis
 * executes atomically: no two workers can spend the same token.
 *
 * The bucket stores `tokens` and the timestamp of the last refill. It is refilled lazily on
 * each call, so idle buckets cost nothing.
 */

export interface BucketState {
  tokens: number;
  updatedAt: number;
}

export interface TakeResult {
  allowed: boolean;
  /** Milliseconds to wait before enough tokens exist (0 when allowed). */
  retryAfterMs: number;
  state: BucketState;
}

/**
 * Reference implementation of the Lua script below, used by unit tests and by the in-memory
 * limiter. Keep the two in sync.
 */
export function takeTokens(
  state: BucketState | undefined,
  now: number,
  ratePerSecond: number,
  burst: number,
  cost = 1,
): TakeResult {
  const current = state ?? { tokens: burst, updatedAt: now };
  const elapsed = Math.max(0, now - current.updatedAt);
  const tokens = Math.min(burst, current.tokens + (elapsed * ratePerSecond) / 1000);
  if (tokens >= cost) {
    return { allowed: true, retryAfterMs: 0, state: { tokens: tokens - cost, updatedAt: now } };
  }
  const missing = cost - tokens;
  return {
    allowed: false,
    retryAfterMs: Math.ceil((missing * 1000) / ratePerSecond),
    state: { tokens, updatedAt: now },
  };
}

/**
 * KEYS[1] bucket hash; ARGV: now (ms), rate per second, burst, cost, ttl (ms).
 * Returns { allowed (0/1), retryAfterMs }.
 * Uses the caller's clock so tests are deterministic; workers run NTP-synced hosts, and a skew
 * of a few milliseconds only shifts a refill slightly.
 */
export const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local data = redis.call('HMGET', key, 'tokens', 'updated_at')
local tokens = tonumber(data[1])
local updated = tonumber(data[2])
if tokens == nil then
  tokens = burst
  updated = now
end

local elapsed = math.max(0, now - updated)
tokens = math.min(burst, tokens + (elapsed * rate) / 1000)

local allowed = 0
local retry_after = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_after = math.ceil(((cost - tokens) * 1000) / rate)
end

redis.call('HSET', key, 'tokens', tokens, 'updated_at', now)
redis.call('PEXPIRE', key, ttl)
return { allowed, retry_after }
`;
