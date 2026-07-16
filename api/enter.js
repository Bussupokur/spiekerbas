// api/enter.js
// Called when someone clicks "come on in". Either claims the slot
// immediately (nobody ahead, nothing currently active) or hands them a
// ticket number and sends them to wait. Uses a simple two-counter model
// instead of a list: nextTicket only ever goes up, nowServing tracks
// who's currently admitted. Your position is just nextTicket - nowServing.

import {
  redis, isOpenNow, getCookie, setCookieHeader,
  newTicketHolderId, signAdmission, SESSION_DURATION_SECONDS,
} from '../lib/gate.js';

export default async function handler(req, res) {
  if (!isOpenNow()) {
    res.setHeader('content-type', 'text/plain');
    return res.status(200).send('closed');
  }

  const nowServing = parseInt((await redis.get('queue:nowServing')) || '0', 10);
  const nowServingUntil = parseInt((await redis.get('queue:nowServingUntil')) || '0', 10);
  const currentlyOccupied = Date.now() < nowServingUntil;

  const nextTicket = await redis.incr('queue:nextTicket');

  if (!currentlyOccupied && nextTicket === nowServing + 1) {
    // nobody's turn is active right now, and nobody was ahead of us —
    // claim it immediately.
    const expiresAt = Date.now() + SESSION_DURATION_SECONDS * 1000;
    await redis.set('queue:nowServing', nextTicket);
    await redis.set('queue:nowServingUntil', expiresAt);
    const admitCookie = await signAdmission(nextTicket, expiresAt);

    res.setHeader('Set-Cookie', [
      setCookieHeader('admit', admitCookie, SESSION_DURATION_SECONDS + 10),
    ]);
    return res.status(200).json({ admitted: true });
  }

  // otherwise: take a ticket and wait
  res.setHeader('Set-Cookie', [
    setCookieHeader('ticket', String(nextTicket), 3600),
  ]);
  return res.status(200).json({ admitted: false, ticket: nextTicket });
}
