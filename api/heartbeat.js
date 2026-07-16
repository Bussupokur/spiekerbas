// api/heartbeat.js
// Pinged every ~10 seconds by whoever's currently admitted. Its only job:
// update the last-heartbeat timestamp. It does NOT extend the 5-minute
// session — that stays fixed, no matter what. This is purely so /api/status
// (polled by waiting visitors) can notice quickly if the current visitor
// has gone quiet, and free the slot early instead of waiting the full
// 5 minutes for someone who's already left.

import { redis, getCookie, verifyAdmission } from '../lib/gate.js';

export default async function handler(req, res) {
  const admitCookie = getCookie(req, 'admit');
  const admission = await verifyAdmission(admitCookie);
  if (!admission) {
    return res.status(200).json({ ok: false });
  }

  const nowServing = parseInt((await redis.get('queue:nowServing')) || '0', 10);
  if (admission.ticket !== nowServing) {
    // already bumped — someone else has been promoted in the meantime
    return res.status(200).json({ ok: false });
  }

  await redis.set('queue:lastHeartbeat', Date.now());
  return res.status(200).json({ ok: true });
}
