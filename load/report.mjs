// Reads the numbers of a load test from Prometheus and prints a Markdown table for the README.
//
//   node load/report.mjs --minutes 5            (window ending now)
//   PROMETHEUS_URL=http://localhost:9090 node load/report.mjs --minutes 10
//
// Every figure comes from the services' own metrics, not from k6, so it measures delivery to
// providers, not just how fast the API said "accepted".

const PROM = process.env.PROMETHEUS_URL ?? 'http://localhost:9090';
const minutesArg = process.argv.indexOf('--minutes');
const minutes = minutesArg > 0 ? Number(process.argv[minutesArg + 1]) : 5;
const w = `${minutes}m`;

async function scalar(expr) {
  const url = `${PROM}/api/v1/query?query=${encodeURIComponent(expr)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Prometheus ${res.status} for ${expr}`);
  const body = await res.json();
  const v = body.data?.result?.[0]?.value?.[1];
  return v === undefined ? NaN : Number(v);
}

const q = (quantile, metric) => `histogram_quantile(${quantile}, sum by (le) (rate(${metric}_bucket[${w}])))`;

const rows = [
  ['Accepted by the API', await scalar(`sum(rate(relay_messages_accepted_total[${w}]))`), 'msg/s'],
  ['Delivered to providers', await scalar(`sum(rate(relay_deliveries_total{outcome="success"}[${w}]))`), 'msg/s'],
  [
    'Peak delivered (1m window)',
    await scalar(`max_over_time(sum(rate(relay_deliveries_total{outcome="success"}[1m]))[${w}:15s])`),
    'msg/s',
  ],
  ['End-to-end p50', await scalar(q(0.5, 'relay_end_to_end_seconds')), 's'],
  ['End-to-end p95', await scalar(q(0.95, 'relay_end_to_end_seconds')), 's'],
  ['End-to-end p99', await scalar(q(0.99, 'relay_end_to_end_seconds')), 's'],
  ['Max outbox age', await scalar(`max_over_time(max(relay_outbox_oldest_age_seconds)[${w}:5s])`), 's'],
  ['Retries scheduled', await scalar(`sum(increase(relay_retries_scheduled_total[${w}]))`), 'msgs'],
  ['Dead-lettered', await scalar(`sum(increase(relay_dead_lettered_total[${w}]))`), 'msgs'],
  ['Kafka redeliveries skipped', await scalar(`sum(increase(relay_duplicates_skipped_total[${w}]))`), 'msgs'],
];

const fmt = (v, unit) => {
  if (!Number.isFinite(v)) return 'n/a';
  if (unit === 's') return v < 1 ? `${(v * 1000).toFixed(0)} ms` : `${v.toFixed(2)} s`;
  if (unit === 'msg/s') return `${Math.round(v).toLocaleString('en-US')} msg/s`;
  return Math.round(v).toLocaleString('en-US');
};

console.log(`Window: last ${minutes} min · ${new Date().toISOString()}\n`);
console.log('| Metric | Value |');
console.log('|---|---|');
for (const [name, value, unit] of rows) console.log(`| ${name} | ${fmt(value, unit)} |`);
