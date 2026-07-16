// api/status.js
// Polled by anyone waiting in line. This is also where the queue
// actually advances.
//
// Two separate rules work together:
// 1. The rightful next ticket (nowServing + 1) can claim their turn the
//    moment the previous slot is free — either the 5-minute cap ran out,
//    or the previous visitor's heartbeat went quiet for 30+ seconds.
// 2. If THAT ticket also never claims it — within a further grace
//    window — anyone else still polling may skip straight past them.
//    This is what stops a single abandoned ticket from permanently
//    jamming the whole queue. It stays fair in practice: the only way a
//    later ticket ever reaches this branch is if everyone ahead of them
//    has genuinely stopped polling for the entire grace window — if any
//    of them were still around, they'd have claimed their own turn first.

import {
  redis, isOpenNow, getCookie, setCookieHeader,
  signAdmission, SESSION_DURATION_SECONDS, HEARTBEAT_TIMEOUT_SECONDS,
  NEXT_IN_LINE_GRACE_SECONDS, getAmsterdamDateKey,
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
  const now = Date.now();

  const hardCapExpired = now >= nowServingUntil;
  const heartbeatStale = nowServing > 0 && (now - lastHeartbeat) > HEARTBEAT_TIMEOUT_SECONDS * 1000;
  const slotAbandoned = hardCapExpired || heartbeatStale;

  // when did the slot actually become free? (whichever rule triggered it)
  const slotFreedAt = heartbeatStale
    ? lastHeartbeat + HEARTBEAT_TIMEOUT_SECONDS * 1000
    : nowServingUntil;

  const isRightfulNext = ticket === nowServing + 1;
  const rightfulNextHasHadFairChance = slotAbandoned && (now - slotFreedAt) > NEXT_IN_LINE_GRACE_SECONDS * 1000;

  const canClaim = slotAbandoned && (
    isRightfulNext ||
    (ticket > nowServing + 1 && rightfulNextHasHadFairChance)
  );

  if (canClaim) {
    const expiresAt = now + SESSION_DURATION_SECONDS * 1000;
    await redis.set('queue:nowServing', ticket);
    await redis.set('queue:nowServingUntil', expiresAt);
    await redis.set('queue:lastHeartbeat', now);
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
