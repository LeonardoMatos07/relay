/**
 * Fake messaging provider (SMS/e-mail/WhatsApp/push gateway) for local runs, e2e tests and
 * load tests. No dependencies: plain node:http.
 *
 *   POST /v1/send          accepts a message; honours Idempotency-Key
 *   GET  /admin/stats      counters (received, unique, duplicates, rejected)
 *   POST /admin/config     change behaviour at runtime: {latencyMs, jitterMs, failureRate,
 *                          throttleRate, outage: boolean, outageStatus}
 *   POST /admin/reset      zero the counters and restore the start-up behaviour
 *   GET  /health
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

interface Behaviour {
  latencyMs: number;
  jitterMs: number;
  failureRate: number;
  throttleRate: number;
  outage: boolean;
  outageStatus: number;
}

const initial: Behaviour = {
  latencyMs: Number(process.env.LATENCY_MS ?? 40),
  jitterMs: Number(process.env.JITTER_MS ?? 20),
  failureRate: Number(process.env.FAILURE_RATE ?? 0),
  throttleRate: Number(process.env.THROTTLE_RATE ?? 0),
  outage: false,
  outageStatus: 503,
};

const name = process.env.PROVIDER_NAME ?? 'mock';
let behaviour: Behaviour = { ...initial };
const stats = { received: 0, accepted: 0, duplicates: 0, failed: 0, throttled: 0, rejected: 0 };

/** Idempotency-Key -> provider id. Bounded so a long load test cannot exhaust memory. */
const seen = new Map<string, string>();
const SEEN_LIMIT = 2_000_000;

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function send(req: IncomingMessage, res: ServerResponse): Promise<void> {
  stats.received += 1;
  const body = (await readBody(req)) as { to?: unknown; body?: unknown };
  await sleep(Math.max(0, behaviour.latencyMs + (Math.random() * 2 - 1) * behaviour.jitterMs));

  if (behaviour.outage) {
    stats.failed += 1;
    return json(res, behaviour.outageStatus, { error: 'provider outage' });
  }
  if (typeof body.to !== 'string' || typeof body.body !== 'string') {
    stats.rejected += 1;
    return json(res, 400, { error: 'to and body are required' });
  }
  if (body.to.includes('invalid')) {
    stats.rejected += 1;
    return json(res, 400, { error: 'recipient rejected' });
  }
  if (Math.random() < behaviour.throttleRate) {
    stats.throttled += 1;
    return json(res, 429, { error: 'throttled' });
  }
  if (Math.random() < behaviour.failureRate) {
    stats.failed += 1;
    return json(res, 503, { error: 'transient failure' });
  }

  const key = req.headers['idempotency-key'];
  if (typeof key === 'string') {
    const existing = seen.get(key);
    if (existing) {
      stats.duplicates += 1;
      return json(res, 200, { id: existing, duplicate: true });
    }
    const id = `${name}-${randomUUID()}`;
    if (seen.size >= SEEN_LIMIT) seen.delete(seen.keys().next().value as string);
    seen.set(key, id);
    stats.accepted += 1;
    return json(res, 202, { id });
  }
  stats.accepted += 1;
  return json(res, 202, { id: `${name}-${randomUUID()}` });
}

const server = createServer((req, res) => {
  const route = `${req.method} ${req.url?.split('?')[0]}`;
  const handle = async () => {
    switch (route) {
      case 'POST /v1/send':
        return send(req, res);
      case 'GET /admin/stats':
        return json(res, 200, { provider: name, ...stats, behaviour });
      case 'POST /admin/config': {
        const patch = (await readBody(req)) as Partial<Behaviour>;
        behaviour = { ...behaviour, ...patch };
        return json(res, 200, behaviour);
      }
      case 'POST /admin/reset':
        behaviour = { ...initial };
        for (const k of Object.keys(stats) as Array<keyof typeof stats>) stats[k] = 0;
        seen.clear();
        return json(res, 200, { reset: true });
      case 'GET /health':
        return json(res, 200, { status: 'ok' });
      default:
        return json(res, 404, { error: 'not found' });
    }
  };
  handle().catch((err: Error) => json(res, 500, { error: err.message }));
});

server.keepAliveTimeout = 65_000;
const port = Number(process.env.PORT ?? 8080);
server.listen(port, '0.0.0.0', () => console.log(`mock provider ${name} on :${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
