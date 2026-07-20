// lib/gate.js
// Shared logic for the whole gate system — opening hours, the signed
// admission cookie, and the Redis client. Imported by middleware.js and
// both /api routes, so there's exactly one copy of each rule, not three.

import { Redis } from '@upstash/redis';

export const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// ── CONFIG ──
export const SCHEDULE = {
  // day index: [ [startHour, endHour], ... ] — 24h, Europe/Amsterdam
  5: [[0, 24]], // Friday — all day
  6: [[0, 24]], // Saturday — all day
  0: [[0, 24]], // Sunday — all day
};

const DAY_NAMES_NL = ['zondag','maandag','dinsdag','woensdag','donderdag','vrijdag','zaterdag'];
const DAY_ABBR_NL = ['zo','ma','di','wo','do','vr','za'];

function formatHourRange([start, end]) {
  if (start === 0 && end === 24) return 'all day';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(start)}:00 \u2013 ${pad(end)}:00`;
}

// Builds the visible hours-table HTML directly from SCHEDULE, so the
// displayed text can never drift out of sync with the actual gate logic —
// change SCHEDULE above, and both the real behavior and what visitors
// see update together, automatically.
export function getHoursTableRows() {
  const openDays = [];
  const closedDayIndices = [];
  for (let d = 0; d < 7; d++) {
    if (SCHEDULE[d] && SCHEDULE[d].length) {
      openDays.push(`<div><span>${DAY_NAMES_NL[d]}</span>${formatHourRange(SCHEDULE[d][0])}</div>`);
    } else {
      closedDayIndices.push(d);
    }
  }
  let rows = openDays.join('\n');
  if (closedDayIndices.length) {
    const abbrList = closedDayIndices.map((d) => DAY_ABBR_NL[d]).join(', ');
    rows += `\n<div><span>${abbrList}</span>closed</div>`;
  }
  return rows;
}

// Turn the whole queue/session system on or off without removing any of
// the code behind it. When false, the gate only checks opening hours —
// no tickets, no admission cookies, no waiting. Flip back to true later
// to re-enable everything exactly as it was.
export const QUEUE_ENABLED = false;

export const SESSION_DURATION_SECONDS = 5 * 60; // fixed session length, for now
export const HEARTBEAT_TIMEOUT_SECONDS = 30; // no ping within this window = abandoned
export const NEXT_IN_LINE_GRACE_SECONDS = 45; // extra time given to the rightful next ticket before anyone else may skip ahead of them

// CHANGE THIS to your own private passphrase before deploying.
export const OWNER_SECRET = 'myOwnerPass99';

// CHANGE THIS too — a third, separate secret. Only cron-job.org (or
// whatever external scheduler you use) should know this one. It protects
// /api/sweep so nobody else can trigger it.
export const SWEEP_SECRET = 'change-me-to-a-third-secret';

// CHANGE THIS too — a separate secret used to sign admission cookies so
// they can't be forged. Any long random string is fine.
const ADMIT_SECRET = 'xk29fjQpLm';

// ── TIME / SCHEDULE ──
export function getAmsterdamNow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const map = {};
  parts.forEach((p) => (map[p.type] = p.value));
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: dayMap[map.weekday], hour: parseInt(map.hour, 10) };
}

export function getAmsterdamDateKey() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const map = {};
  parts.forEach((p) => (map[p.type] = p.value));
  return `${map.year}-${map.month}-${map.day}`;
}

export function isOpenNow() {
  const { day, hour } = getAmsterdamNow();
  const windows = SCHEDULE[day] || [];
  return windows.some(([start, end]) => hour >= start && hour < end);
}

// ── COOKIES ──
export function getCookie(request, name) {
  const cookieHeader = typeof request.headers.get === 'function'
    ? request.headers.get('cookie')
    : request.headers.cookie;
  const cookie = cookieHeader || '';
  const found = cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return found ? decodeURIComponent(found.split('=').slice(1).join('=')) : null;
}

export function setCookieHeader(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax; Secure`;
}

export function clearCookieHeader(name) {
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
}

export function newTicketHolderId() {
  return crypto.randomUUID();
}

// ── SIGNED ADMISSION COOKIE ──
// Once someone's admitted, this cookie alone proves it — no Redis lookup
// needed on every subsequent request. It's just a ticket number and an
// expiry, signed with HMAC so it can't be forged or edited.

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSign(data, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return bufferToHex(sigBuffer);
}

export async function signAdmission(ticket, expiresAt) {
  const data = `${ticket}.${expiresAt}`;
  const sig = await hmacSign(data, ADMIT_SECRET);
  return `${data}.${sig}`;
}

export async function verifyAdmission(cookieValue) {
  if (!cookieValue) return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 3) return null;
  const [ticket, expiresAt, sig] = parts;
  const expectedSig = await hmacSign(`${ticket}.${expiresAt}`, ADMIT_SECRET);
  if (sig !== expectedSig) return null;
  if (Date.now() > parseInt(expiresAt, 10)) return null;
  return { ticket: parseInt(ticket, 10), expiresAt: parseInt(expiresAt, 10) };
}
