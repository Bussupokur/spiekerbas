// middleware.js
// The full gate system: opening hours, a real queue, a heartbeat-based
// "one visitor at a time" slot, a 30-minute visit cap, and an owner
// bypass. Runs before every request.
//
// How presence works: an "active visitor" record in the shared store
// carries a short TTL (25s). The browser pings /api/heartbeat every
// 10 seconds to refresh it. Stop pinging for any reason — closed tab,
// clicked an external link, connection dropped — and the record just
// expires on its own. Nobody has to detect "leaving" explicitly.

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export const config = {
  matcher: '/((?!favicon.ico|api/).*)',
};

// ── CONFIG ──
const SCHEDULE = {
  // day index: [ [startHour, endHour], ... ] — 24h, Europe/Amsterdam
  0: [[14, 18]], // Sunday
  3: [[12, 18]], // Wednesday
  5: [[19, 23]], // Friday
  6: [[19, 23]], // Saturday
};

const VISIT_DURATION_SECONDS = 30 * 60; // 30-minute cap per visit
const HEARTBEAT_TTL_SECONDS = 25;       // silence longer than this = slot freed

// CHANGE THIS to your own private passphrase before deploying.
// Visiting /?owner=<this value> gives you unlimited, ungated access.
const OWNER_SECRET = 'change-me-to-your-own-secret';

// ── TIME / SCHEDULE ──
function getAmsterdamNow() {
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

function isOpenNow() {
  const { day, hour } = getAmsterdamNow();
  const windows = SCHEDULE[day] || [];
  return windows.some(([start, end]) => hour >= start && hour < end);
}

// ── COOKIES ──
function getCookie(request, name) {
  const cookie = request.headers.get('cookie') || '';
  const found = cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return found ? decodeURIComponent(found.split('=').slice(1).join('=')) : null;
}

function setCookieHeader(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax; Secure`;
}

function clearCookieHeader(name) {
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
}

function newSessionId() {
  return crypto.randomUUID();
}

function safeParseRecord(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  return raw; // already an object
}

// ── STYLES (shared by every gate screen) ──
const PAGE_STYLES = `
  :root{
    --cream:#ebdcc3;
    --cream-dim: rgba(235,220,195,0.75);
    --cream-faint: rgba(235,220,195,0.5);
    --dark:#0c0c0d;
  }
  *{ box-sizing:border-box; }
  html,body{
    margin:0; height:100%;
    background: var(--dark);
    font-family:'Cormorant Garamond', serif;
    color: var(--cream);
    display:flex; align-items:center; justify-content:center;
  }
  #stage{ max-width: 560px; text-align:center; padding: 3rem 2rem; }
  .status-pill{
    display:inline-block;
    font-size:11px;
    letter-spacing:0.25em;
    text-transform:lowercase;
    padding: 0.4rem 1rem;
    border-radius: 3px;
    margin-bottom: 1.6rem;
    font-family: Arial, sans-serif;
  }
  .status-pill.open{ background:#a8e05f; color:#1a2e10; }
  .status-pill.closed{ background:#5a5a55; color:#e8e0d0; }
  .status-pill.queue{ background:#ffd23f; color:#3a2c05; }
  h1{
    font-size: clamp(28px,5vw,44px);
    font-weight:300; font-style:italic;
    letter-spacing:0.02em;
    margin: 0 0 1rem;
    text-transform: lowercase;
  }
  p{
    font-size: clamp(15px,2vw,18px);
    font-weight:300; line-height:1.7;
    color: var(--cream-dim);
    margin: 0 0 1.8rem;
  }
  .hours-table{
    display:block;
    width:fit-content;
    margin-left:auto;
    margin-right:auto;
    text-align:left;
    font-size:14px; color: var(--cream-faint);
    letter-spacing:0.04em;
    margin-bottom: 2rem;
  }
  .hours-table div{ padding: 3px 0; }
  .hours-table span{ display:inline-block; width: 110px; color: var(--cream-dim); }
  .enter-btn{
    display:inline-block;
    font-family: 'Cormorant Garamond', serif;
    font-weight: 300;
    font-size: clamp(15px,1.6vw,18px);
    letter-spacing: 0.3em;
    text-transform: lowercase;
    color: var(--cream-dim);
    text-decoration: none;
    border: 1px solid rgba(235,220,195,0.35);
    padding: 0.7rem 1.8rem;
    margin-top: 0.4rem;
    transition: color 0.3s ease, border-color 0.3s ease;
  }
  .enter-btn:hover{ color: var(--cream); border-color: rgba(235,220,195,0.7); }
  .timer-note{
    font-size: 12px;
    letter-spacing: 0.08em;
    color: rgba(235,220,195,0.45);
    font-style: italic;
    margin-top: 0.9rem;
  }
  .live-clock{
    font-size:12px;
    letter-spacing:0.18em;
    color: var(--cream-faint);
    text-transform:lowercase;
    margin-top: 1.6rem;
    font-family: Arial, sans-serif;
  }
  .debug-note{
    font-size:10px;
    letter-spacing:0.05em;
    color: rgba(160,220,130,0.55);
    font-family: Arial, sans-serif;
    margin-top: 0.6rem;
  }
  .queue-position{
    font-size: clamp(40px,8vw,64px);
    font-weight:300; font-style:italic;
    color: #ffd23f;
    margin: 0.4rem 0 1.2rem;
  }
`;

const CLOCK_SCRIPT = `
  <script>
    function tickClock(){
      var el = document.getElementById('liveClock');
      if(!el) return;
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Amsterdam',
        weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }).formatToParts(new Date());
      var map = {};
      parts.forEach(function(p){ map[p.type] = p.value; });
      el.textContent = map.weekday + ' ' + map.hour + ':' + map.minute + ':' + map.second + ' \\u2014 Amsterdam time';
    }
    tickClock();
    setInterval(tickClock, 1000);
  </script>
`;

// ── SCREENS ──
function closedHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Closed for now — spiekerbas</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&display=swap" rel="stylesheet">
<style>${PAGE_STYLES}</style>
</head>
<body>
  <div id="stage">
    <div class="status-pill closed">closed</div>
    <h1>closed for now</h1>
    <p>back during opening hours — see the schedule below.</p>
    <div class="hours-table">
      <div><span>fri &ndash; sat</span>19:00 &ndash; 23:00</div>
      <div><span>sun</span>14:00 &ndash; 18:00</div>
      <div><span>wed</span>12:00 &ndash; 18:00</div>
      <div><span>mon, tue, thu</span>closed</div>
    </div>
    <div class="live-clock" id="liveClock"></div>
  </div>
  ${CLOCK_SCRIPT}
</body>
</html>`;
}

function welcomeHTML(storageStatus) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>spiekerbas</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&display=swap" rel="stylesheet">
<style>${PAGE_STYLES}</style>
</head>
<body>
  <div id="stage">
    <div class="status-pill open">open now</div>
    <h1>we're open</h1>
    <p>one visitor at a time. nothing starts until you actually step through — no timer, no queue slot claimed, until you click.</p>
    <a class="enter-btn" href="/?enter=1">come on in</a>
    <div class="timer-note">your 30 minutes starts once you enter.</div>
    <div class="hours-table">
      <div><span>fri &ndash; sat</span>19:00 &ndash; 23:00</div>
      <div><span>sun</span>14:00 &ndash; 18:00</div>
      <div><span>wed</span>12:00 &ndash; 18:00</div>
    </div>
    <div class="live-clock" id="liveClock"></div>
    ${storageStatus ? `<div class="debug-note">${storageStatus}</div>` : ''}
  </div>
  ${CLOCK_SCRIPT}
</body>
</html>`;
}

function queueHTML(position) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>You're in line — spiekerbas</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&display=swap" rel="stylesheet">
<style>${PAGE_STYLES}</style>
</head>
<body>
  <div id="stage">
    <div class="status-pill queue">one at a time</div>
    <h1>you're in line</h1>
    <div class="queue-position">${position}</div>
    <p>someone else is here right now. this page checks again automatically — no need to refresh yourself.</p>
    <div class="live-clock" id="liveClock"></div>
  </div>
  ${CLOCK_SCRIPT}
  <script>
    setTimeout(function(){ window.location.reload(); }, 8000);
  </script>
</body>
</html>`;
}

function ownerStatusHTML(info) {
  const fmtRecord = (r) => r ? JSON.stringify(r, null, 2) : '(empty — nobody active)';
  const actionsLine = info.didClearQueue || info.didClearActive
    ? `<p style="color:#a8e05f;">Action taken: ${info.didClearQueue ? 'queue cleared. ' : ''}${info.didClearActive ? 'active session cleared.' : ''}</p>
       <p style="font-size:12px;">Queue length before: ${info.queueLenBefore} → after: ${info.queueLenAfter}</p>
       <p style="font-size:12px;">Active before:</p><pre>${fmtRecord(info.activeBefore)}</pre>
       <p style="font-size:12px;">Active after:</p><pre>${fmtRecord(info.activeAfter)}</pre>`
    : `<p style="font-size:12px;">Current queue length: ${info.queueLenAfter}</p>
       <p style="font-size:12px;">Current active session:</p><pre>${fmtRecord(info.activeAfter)}</pre>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Owner status — spiekerbas</title>
<style>
  body{ background:#0c0c0d; color:#ebdcc3; font-family: Arial, sans-serif; padding: 2rem; max-width: 640px; margin: 0 auto; line-height: 1.6; }
  h1{ font-size: 18px; }
  pre{ background:#1a1a1b; padding: 12px; border-radius: 4px; font-size: 12px; overflow-x:auto; white-space: pre-wrap; }
  a{ color:#a8e05f; }
  .actions{ margin-top: 2rem; display:flex; gap: 1rem; flex-wrap: wrap; }
  .actions a{ border:1px solid rgba(235,220,195,0.3); padding: 8px 14px; border-radius: 4px; text-decoration:none; font-size: 13px; }
</style>
</head>
<body>
  <h1>owner status — you are recognized as owner</h1>
  ${actionsLine}
  <div class="actions">
    <a href="/owner-status">refresh status</a>
  </div>
  <p style="font-size:11px; color:rgba(235,220,195,0.4); margin-top:2rem;">
    To clear the queue: add &clearqueue=1 to your ?owner=... link.<br>
    To clear the active session: add &clearactive=1.<br>
    You can combine both in one visit.
  </p>
</body>
</html>`;
}

// ── MAIN ──
export default async function middleware(request) {
  const url = new URL(request.url);

  // ── OWNER BYPASS + VISIBLE DEBUG TOOLS ──
  const ownerParam = (url.searchParams.get('owner') || '').trim();
  const secretMatches = ownerParam.length > 0 && ownerParam === OWNER_SECRET.trim();

  if (secretMatches) {
    const didClearQueue = url.searchParams.get('clearqueue') === '1';
    const didClearActive = url.searchParams.get('clearactive') === '1';

    let queueLenBefore = await redis.llen('visitor:queue');
    let activeBefore = safeParseRecord(await redis.get('visitor:active'));

    if (didClearQueue) await redis.del('visitor:queue');
    if (didClearActive) await redis.del('visitor:active');

    const queueLenAfter = await redis.llen('visitor:queue');
    const activeAfter = safeParseRecord(await redis.get('visitor:active'));

    const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
    headers.append('Set-Cookie', setCookieHeader('owner', '1', 31536000));

    return new Response(ownerStatusHTML({
      didClearQueue, didClearActive,
      queueLenBefore, activeBefore,
      queueLenAfter, activeAfter,
    }), { status: 200, headers });
  }

  const isOwner = getCookie(request, 'owner') === '1';
  if (isOwner) {
    if (url.pathname === '/owner-status') {
      const queueLen = await redis.llen('visitor:queue');
      const active = safeParseRecord(await redis.get('visitor:active'));
      return new Response(ownerStatusHTML({ queueLenAfter: queueLen, activeAfter: active }), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return; // unlimited, ungated access — no schedule, no queue, no timer
  }

  const open = isOpenNow();
  const sessionId = getCookie(request, 'sessionId');
  const entered = getCookie(request, 'entered') === '1';

  // ── ALREADY ACTIVE: validate against the real record on every request ──
  if (entered && sessionId) {
    const record = safeParseRecord(await redis.get('visitor:active'));
    const stillValid = record && record.sessionId === sessionId
      && (Date.now() - record.enteredAt) / 1000 < VISIT_DURATION_SECONDS;

    if (stillValid) {
      return; // genuinely still valid — let them through to the real site
    }

    // invalid for any reason (never active, expired, 30-min cap hit,
    // or belongs to someone else entirely) — actively clear the stale
    // cookies and force a clean redirect, rather than silently carrying
    // broken state into the rest of this request.
    if (record && record.sessionId === sessionId) {
      await redis.del('visitor:active'); // it was genuinely theirs, just timed out
    }
    const headers = new Headers({ Location: url.pathname + url.search });
    headers.append('Set-Cookie', clearCookieHeader('entered'));
    headers.append('Set-Cookie', clearCookieHeader('sessionId'));
    return new Response(null, { status: 302, headers });
  }

  // ── VISITOR JUST CLICKED "COME ON IN" ──
  if (url.searchParams.get('enter') === '1') {
    if (!open) {
      return new Response(closedHTML(), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    const id = newSessionId();
    const active = safeParseRecord(await redis.get('visitor:active'));
    const queueLength = await redis.llen('visitor:queue');

    if (!active && queueLength === 0) {
      // slot is free AND nobody's already waiting — claim it directly
      await redis.set('visitor:active', JSON.stringify({ sessionId: id, enteredAt: Date.now() }), { ex: HEARTBEAT_TTL_SECONDS });
      url.searchParams.delete('enter');
      const headers = new Headers({ Location: url.pathname + url.search });
      headers.append('Set-Cookie', setCookieHeader('entered', '1', 86400));
      headers.append('Set-Cookie', setCookieHeader('sessionId', id, 86400));
      return new Response(null, { status: 302, headers });
    }

    // slot taken, OR people are already waiting — join the back of the queue.
    // (Even a momentarily-free slot doesn't let a new visitor skip ahead
    // of anyone who got here first.)
    await redis.rpush('visitor:queue', id);
    url.searchParams.delete('enter');
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.pathname + url.search,
        'Set-Cookie': setCookieHeader('sessionId', id, 86400),
      },
    });
  }

  // ── HAS A SESSION, NOT YET ENTERED: are they queued? ──
  if (sessionId && !entered) {
    if (open) {
      const active = safeParseRecord(await redis.get('visitor:active'));
      const position = await redis.lpos('visitor:queue', sessionId);

      if (!active && position === 0) {
        // slot is free and they're first in line — promote them
        await redis.lpop('visitor:queue');
        await redis.set('visitor:active', JSON.stringify({ sessionId, enteredAt: Date.now() }), { ex: HEARTBEAT_TTL_SECONDS });
        return new Response(null, {
          status: 302,
          headers: {
            Location: url.pathname + url.search,
            'Set-Cookie': setCookieHeader('entered', '1', 86400),
          },
        });
      }

      if (position !== null && position >= 0) {
        return new Response(queueHTML(position + 1), {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
    }
    // not in the queue (never joined, or hours closed) — treat as fresh
  }

  // ── CLOSED: always a closed screen, no exceptions ──
  if (!open) {
    return new Response(closedHTML(), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  // ── FRESH VISITOR, OPEN HOURS: prove storage works, show the welcome screen ──
  let storageStatus;
  try {
    const now = Date.now();
    await redis.set('debug:lastPing', now);
    const readBack = await redis.get('debug:lastPing');
    storageStatus = readBack === now ? null : 'storage check: read-back mismatch';
  } catch (err) {
    storageStatus = 'storage check: failed — ' + (err && err.message ? err.message : 'unknown error');
  }

  return new Response(welcomeHTML(storageStatus), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
