// api/sweep.js
// Pinged by an external scheduler (cron-job.org) once a minute — entirely
// independent of any visitor's browser. This is what makes the queue
// self-healing even if every tab gets closed and nobody's left to notice
// the slot went stale.
//
// It does NOT admit anyone directly — it can't, there's no browser here
// to hand a cookie to. It just advances the counter past a confirmed-
// abandoned slot, so that whenever the next real visitor's own browser
// polls /api/status, the existing promotion logic finds them correctly
// first-in-line instead of stuck behind a dead ticket.

import { redis, isOpenNow, HEARTBEAT_TIMEOUT_SECONDS, SWEEP_SECRET } from '../lib/gate.js';

export default async function handler(req, res) {
  const provided = req.query.secret;
  if (!provided || provided !== SWEEP_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }

  if (!isOpenNow()) {
    return res.status(200).json({ advanced: false, reason: 'closed' });
  }

  const nowServing = parseInt((await redis.get('queue:nowServing')) || '0', 10);
  const nowServingUntil = parseInt((await redis.get('queue:nowServingUntil')) || '0', 10);
  const lastHeartbeat = parseInt((await redis.get('queue:lastHeartbeat')) || '0', 10);
  const nextTicket = parseInt((await redis.get('queue:nextTicket')) || '0', 10);
  const now = Date.now();

  const hardCapExpired = now >= nowServingUntil;
  const heartbeatStale = nowServing > 0 && (now - lastHeartbeat) > HEARTBEAT_TIMEOUT_SECONDS * 1000;
  const slotAbandoned = hardCapExpired || heartbeatStale;

  if (!slotAbandoned) {
    return res.status(200).json({ advanced: false, reason: 'still active' });
  }

  if (nowServing >= nextTicket) {
    return res.status(200).json({ advanced: false, reason: 'nobody waiting' });
  }

  // one step forward, nothing more — the real admission (and the signed
  // cookie) still only ever happens via the visitor's own poll.
  await redis.set('queue:nowServing', nowServing + 1);

  return res.status(200).json({ advanced: true, nowServing: nowServing + 1 });
}
