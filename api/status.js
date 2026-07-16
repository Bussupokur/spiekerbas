// api/status.js
// Polled by anyone waiting in line. This is also where the queue
// actually advances — if the currently-admitted person's time is up,
// whoever polls next notices that and moves nowServing forward. This is
// the "pull" model: the queue only advances when someone's there to
// notice, rather than needing the admitted visitor to signal anything.

import {
  redis, isOpenNow, getCookie, setCookieHeader,
  signAdmission, SESSION_DURATION_SECONDS,
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

  if (Date.now() >= nowServingUntil && ticket === nowServing + 1) {
    // the previous turn has expired, and it's genuinely our turn next —
    // advance the queue and admit ourselves.
    const expiresAt = Date.now() + SESSION_DURATION_SECONDS * 1000;
    await redis.set('queue:nowServing', ticket);
    await redis.set('queue:nowServingUntil', expiresAt);
    const admitCookie = await signAdmission(ticket, expiresAt);

    res.setHeader('Set-Cookie', [
      setCookieHeader('admit', admitCookie, SESSION_DURATION_SECONDS + 10),
    ]);
    return res.status(200).json({ admitted: true });
  }

  const position = ticket - nowServing;
  return res.status(200).json({ admitted: false, position: Math.max(1, position) });
}
