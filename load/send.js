// k6 load test: constant arrival rate against POST /v1/messages.
//
//   make load RATE=2000 DURATION=5m
//
// Arrival rate (not virtual users) is fixed on purpose: it models clients that keep sending
// whether or not the API slows down, which is what exposes queueing and backpressure.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const RATE = Number(__ENV.RATE || 1000);
const DURATION = __ENV.DURATION || '5m';
const RECIPIENTS = Number(__ENV.RECIPIENTS || 200000);

const accepted = new Counter('relay_accepted');

export const options = {
  discardResponseBodies: false,
  scenarios: {
    send: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(50, Math.ceil(RATE / 10)),
      maxVUs: Math.max(200, RATE),
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{expected_response:true}': ['p(95)<150', 'p(99)<300'],
  },
};

// Realistic mix for a notification platform: mostly SMS (OTPs) and e-mail.
const MIX = [
  ['sms', 0.55],
  ['email', 0.25],
  ['push', 0.12],
  ['whatsapp', 0.08],
];

function pickChannel() {
  let r = Math.random();
  for (const [channel, share] of MIX) {
    if ((r -= share) < 0) return channel;
  }
  return 'sms';
}

function recipient(channel) {
  const n = Math.floor(Math.random() * RECIPIENTS);
  switch (channel) {
    case 'email':
      return `user${n}@example.com`;
    case 'push':
      return `device-token-${String(n).padStart(12, '0')}`;
    default:
      return `+55719${String(n).padStart(8, '0')}`;
  }
}

export default function () {
  const channel = pickChannel();
  const payload = {
    channel,
    to: recipient(channel),
    body: `Your code is ${Math.floor(100000 + Math.random() * 900000)}`,
    ...(channel === 'email' ? { subject: 'Your verification code' } : {}),
    metadata: { campaign: 'loadtest' },
  };
  const res = http.post(`${BASE_URL}/v1/messages`, JSON.stringify(payload), {
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `load-${__VU}-${__ITER}-${Date.now()}`,
    },
    tags: { channel },
  });
  if (check(res, { 'accepted (202)': (r) => r.status === 202 })) accepted.add(1);
}
