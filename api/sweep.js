// api/sweep.js
// Pinged by an external scheduler (cron-job.org) once a minute.
//
// Turns out this doesn't need to modify anything at all — the
// abandonment logic in /api/status.js is entirely time-based, worked
// out fresh from real elapsed time whenever a real visitor polls. It
// doesn't depend on anything being pre-set in advance. An earlier
// version of this file tried to nudge the queue counter forward ahead
// of time, which actually broke things: it could advance `nowServing`
// to equal a waiting visitor's own ticket number, and their own check
// (`is my ticket exactly one more than nowServing?`) would then never
// resolve. This version is a safe, read-only check — useful to confirm
// the scheduler is reaching the site, without touching any state.

import { redis, isOpenNow, HEARTBEAT_TIMEOUT_SECONDS, SWEEP_SECRET } from '../lib/gate.js';

export default async function handler(req, res) {
  const provided = req.query.secret;
  if (!provided || provided !== SWEEP_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }

  if (!isOpenNow()) {
    return res.status(200).json({ checked: true, reason: 'closed' });
  }

  const nowServing = parseInt((await redis.get('queue:nowServing')) || '0', 10);
  const nowServingUntil = parseInt((await redis.get('queue:nowServingUntil')) || '0', 10);
  const lastHeartbeat = parseInt((await redis.get('queue:lastHeartbeat')) || '0', 10);
  const nextTicket = parseInt((await redis.get('queue:nextTicket')) || '0', 10);
  const now = Date.now();

  const hardCapExpired = now >= nowServingUntil;
  const heartbeatStale = nowServing > 0 && (now - lastHeartbeat) > HEARTBEAT_TIMEOUT_SECONDS * 1000;

  return res.status(200).json({
    checked: true,
    nowServing,
    slotAbandoned: hardCapExpired || heartbeatStale,
    queueLength: Math.max(0, nextTicket - nowServing),
  });
}
