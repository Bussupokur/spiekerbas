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
  0: [[14, 18]], // Sunday
  3: [[12, 18]], // Wednesday
  5: [[19, 23]], // Friday
  6: [[19, 23]], // Saturday
};

export const SESSION_DURATION_SECONDS = 5 * 60; // fixed session length, for now
export const HEARTBEAT_TIMEOUT_SECONDS = 30; // no ping within this window = abandoned

// CHANGE THIS to your own private passphrase before deploying.
export const OWNER_SECRET = 'change-me-to-your-own-secret';

// CHANGE THIS too — a separate secret used to sign admission cookies so
// they can't be forged. Any long random string is fine.
const ADMIT_SECRET = 'change-me-to-a-different-random-secret';

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
