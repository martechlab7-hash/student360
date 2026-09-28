// k6 load test: many students loading "Today" and submitting tasks concurrently.
//   k6 run -e BASE=http://localhost:4000 -e TENANT=demo-college -e PASSWORD=... infra/load/today-and-submit.js
// Seed enough student accounts first (the demo seed creates student1..3; use the import API for more).
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    morning_peak: { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '1m', target: 200 }, { duration: '3m', target: 200 }, { duration: '30s', target: 0 }] },
  },
  thresholds: { http_req_failed: ['rate<0.01'], 'http_req_duration{name:today}': ['p(95)<400'], 'http_req_duration{name:submit}': ['p(95)<600'] },
};

const BASE = `${__ENV.BASE}/api/v1`;
export function setup() {
  const tokens = [];
  for (let i = 1; i <= Number(__ENV.STUDENTS || 3); i++) {
    const r = http.post(`${BASE}/auth/login`, JSON.stringify({ tenant: __ENV.TENANT, email: `student${i}@demo.edu`, password: __ENV.PASSWORD }),
      { headers: { 'content-type': 'application/json' } });
    tokens.push(r.json('accessToken'));
  }
  return { tokens };
}

export default function (data) {
  const token = data.tokens[__VU % data.tokens.length];
  const h = { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } };
  const today = http.get(`${BASE}/tasks/today`, { ...h, tags: { name: 'today' } });
  check(today, { 'today 200': (r) => r.status === 200 });
  http.get(`${BASE}/dashboard/student`, { ...h, tags: { name: 'dashboard' } });
  const open = (today.json('items') || []).find((t) => t.status === 'assigned' && t.type === 'text_response');
  if (open) {
    const r = http.post(`${BASE}/tasks/assignments/${open.id}/submissions`, JSON.stringify({ text: 'Load test response with enough words to evaluate.' }),
      { headers: { ...h.headers, 'idempotency-key': `${__VU}-${__ITER}-${open.id}` }, tags: { name: 'submit' } });
    check(r, { 'submit accepted or already used': (x) => [201, 409].includes(x.status) });
  }
  sleep(1);
}
