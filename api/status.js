// api/status.js
// Polled by anyone waiting in line. This is also where the queue
// actually advances — either the 5-minute hard cap has genuinely run
// out, OR the current visitor's heartbeat has gone quiet for 30+
// seconds (left, closed the tab, lost connection — doesn't matter
// which). Either way, whoever polls next notices and moves the queue
// forward. This is the "pull" model: it only advances when someone's
// there to notice, not via anything the current visitor has to do.

import {
  redis, isOpenNow, getCookie, setCookieHeader,
  signAdmission, SESSION_DURATION_SECONDS, HEARTBEAT_TIMEOUT_SECONDS, getAmsterdamDateKey,
} from '../lib/gate.js';

export default async function handler(req, res) {
  if (!isOpenNow()) {
    return res.status(200).json({ admitted: false, closed: true });
  }

  const ticketCookie = getCookie(req, 'ticket');
  const ticket = ticketCookie ? parseInt(ticketCookie, 10) : null;
  if (!ticket) {
    return res.status(200).json({ admitted: false, position: null });
  }

  const nowServing = parseInt((await redis.get('queue:nowServing')) || '0', 10);
  const nowServingUntil = parseInt((await redis.get('queue:nowServingUntil')) || '0', 10);
  const lastHeartbeat = parseInt((await redis.get('queue:lastHeartbeat')) || '0', 10);

  const hardCapExpired = Date.now() >= nowServingUntil;
  const heartbeatStale = nowServing > 0 && (Date.now() - lastHeartbeat) > HEARTBEAT_TIMEOUT_SECONDS * 1000;
  const slotAbandoned = hardCapExpired || heartbeatStale;

  if (slotAbandoned && ticket === nowServing + 1) {
    // it's genuinely our turn next, and the previous turn is over —
    // either it ran its course, or they went quiet. Advance and admit.
    const expiresAt = Date.now() + SESSION_DURATION_SECONDS * 1000;
    await redis.set('queue:nowServing', ticket);
    await redis.set('queue:nowServingUntil', expiresAt);
    await redis.set('queue:lastHeartbeat', Date.now());
    await redis.incr('stats:visits:total');
    await redis.incr(`stats:visits:${getAmsterdamDateKey()}`);
    const admitCookie = await signAdmission(ticket, expiresAt);

    res.setHeader('Set-Cookie', [
      setCookieHeader('admit', admitCookie, SESSION_DURATION_SECONDS + 10),
    ]);
    return res.status(200).json({ admitted: true });
  }

  const position = ticket - nowServing;
  return res.status(200).json({ admitted: false, position: Math.max(1, position) });
}
