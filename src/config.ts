import { readFileSync } from 'node:fs';
import { CHANNELS, Channel } from './core/message';
import { parseProviders, ProviderConfig } from './core/provider-router';

export const ROLES = ['api', 'publisher', 'worker', 'migrate'] as const;
export type Role = (typeof ROLES)[number];

export interface Config {
  role: Role;
  port: number;
  databaseUrl: string;
  databasePoolSize: number;
  kafkaBrokers: string[];
  kafkaClientId: string;
  /** Partitions for main topics. Upper bound for consumer parallelism across pods. */
  topicPartitions: number;
  topicReplication: number;
  redisUrl: string;
  /** Channels this worker consumes. */
  workerChannels: Channel[];
  /** Recipients processed concurrently per partition batch (order kept per recipient). */
  workerKeyConcurrency: number;
  /** Max time to wait for a provider rate-limit token before failing over. */
  rateLimitMaxWaitMs: number;
  publisherBatchSize: number;
  publisherIdleMs: number;
  providers: ProviderConfig[];
  /** Static API keys. Empty means the API is open (local development only). */
  apiKeys: string[];
  logJson: boolean;
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`missing environment variable ${name}`);
  return value;
}

function intEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`);
  return value;
}

function list(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  const role = env('APP_ROLE', 'api') as Role;
  if (!ROLES.includes(role)) throw new Error(`APP_ROLE must be one of ${ROLES.join(', ')}`);

  const channels = list(process.env.WORKER_CHANNELS ?? CHANNELS.join(','));
  const invalid = channels.filter((c) => !(CHANNELS as readonly string[]).includes(c));
  if (invalid.length > 0) throw new Error(`WORKER_CHANNELS has unknown channels: ${invalid.join(', ')}`);

  const providers = role === 'worker' ? parseProviders(JSON.parse(readFileSync(env('PROVIDERS_FILE'), 'utf8'))) : [];

  return {
    role,
    port: intEnv('PORT', 3000),
    databaseUrl: env('DATABASE_URL'),
    databasePoolSize: intEnv('DATABASE_POOL_SIZE', 20),
    kafkaBrokers: list(env('KAFKA_BROKERS', 'localhost:19092')),
    kafkaClientId: env('KAFKA_CLIENT_ID', `relay-${role}`),
    topicPartitions: intEnv('TOPIC_PARTITIONS', 24),
    topicReplication: intEnv('TOPIC_REPLICATION', 1),
    redisUrl: env('REDIS_URL', 'redis://localhost:6379'),
    workerChannels: channels as Channel[],
    workerKeyConcurrency: intEnv('WORKER_KEY_CONCURRENCY', 64),
    rateLimitMaxWaitMs: intEnv('RATE_LIMIT_MAX_WAIT_MS', 250, 0),
    publisherBatchSize: intEnv('PUBLISHER_BATCH_SIZE', 1000),
    publisherIdleMs: intEnv('PUBLISHER_IDLE_MS', 20),
    providers,
    apiKeys: list(process.env.API_KEYS),
    logJson: process.env.LOG_FORMAT === 'json',
  };
}

export const CONFIG = Symbol('CONFIG');
