// api/heartbeat.js
// Pinged every 10 seconds by the browser while a visitor is actively on
// the site. Refreshes their presence in the shared store and reports
// back how much time they have left. If they've timed out, hit their
// 30-minute cap, or lost their slot for any reason, this tells the
// browser to send them back through the gate.

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const VISIT_DURATION_SECONDS = 30 * 60;
const HEARTBEAT_TTL_SECONDS = 25;

function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  const found = cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return found ? decodeURIComponent(found.split('=').slice(1).join('=')) : null;
}

export default async function handler(req, res) {
  const sessionId = getCookie(req, 'sessionId');

  if (!sessionId) {
    return res.status(200).json({ active: false });
  }

  const record = await redis.get('visitor:active');
  if (!record || record.sessionId !== sessionId) {
    return res.status(200).json({ active: false });
  }

  const elapsedSeconds = (Date.now() - record.enteredAt) / 1000;
  const remainingSeconds = Math.max(0, VISIT_DURATION_SECONDS - elapsedSeconds);

  if (remainingSeconds <= 0) {
    await redis.del('visitor:active');
    return res.status(200).json({ active: false });
  }

  // refresh the heartbeat TTL — this is what proves they're still here
  await redis.set('visitor:active', record, { ex: HEARTBEAT_TTL_SECONDS });

  return res.status(200).json({
    active: true,
    remainingSeconds: Math.round(remainingSeconds),
  });
}
