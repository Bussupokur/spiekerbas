// middleware.js
// Thin gate: opening hours, and checking the signed admission cookie.
// That's it. All the actual queue logic (claiming a slot, advancing the
// line) lives in /api/enter.js and /api/status.js — this file just
// decides which screen to show.

import {
  redis, isOpenNow, getCookie, verifyAdmission, OWNER_SECRET, setCookieHeader, clearCookieHeader,
} from './lib/gate.js';

export const config = {
  matcher: '/((?!favicon.ico|api/).*)',
};

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
    cursor: pointer;
    background: none;
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

function welcomeHTML() {
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
    <p>one visitor at a time. nothing starts until you actually step through.</p>
    <button class="enter-btn" id="enterBtn">come on in</button>
    <div class="timer-note">your 5 minutes starts once you enter — no matter what.</div>
    <div class="hours-table">
      <div><span>fri &ndash; sat</span>19:00 &ndash; 23:00</div>
      <div><span>sun</span>14:00 &ndash; 18:00</div>
      <div><span>wed</span>12:00 &ndash; 18:00</div>
    </div>
    <div class="live-clock" id="liveClock"></div>
  </div>
  ${CLOCK_SCRIPT}
  <script>
    document.getElementById('enterBtn').addEventListener('click', function(){
      fetch('/api/enter', { method: 'POST', credentials: 'same-origin' })
        .then(function(r){ return r.json(); })
        .then(function(data){
          window.location.href = '/';
        })
        .catch(function(){ window.location.href = '/'; });
    });
  </script>
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
    <div class="queue-position" id="queuePosition">${position}</div>
    <p>this updates on its own — no need to refresh yourself.</p>
    <div class="live-clock" id="liveClock"></div>
  </div>
  ${CLOCK_SCRIPT}
  <script>
    function poll(){
      fetch('/api/status', { credentials: 'same-origin' })
        .then(function(r){ return r.json(); })
        .then(function(data){
          if(data.closed){ window.location.href = '/'; return; }
          if(data.admitted){ window.location.href = '/'; return; }
          if(data.position){
            document.getElementById('queuePosition').textContent = data.position;
          }
        })
        .catch(function(){ /* try again next tick */ });
    }
    poll();
    setInterval(poll, 4000);
  </script>
</body>
</html>`;
}

export default async function middleware(request) {
  const url = new URL(request.url);

  // ── OWNER BYPASS ──
  const ownerParam = (url.searchParams.get('owner') || '').trim();
  if (ownerParam && ownerParam === OWNER_SECRET.trim()) {
    url.searchParams.delete('owner');
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.pathname + url.search,
        'Set-Cookie': setCookieHeader('owner', '1', 31536000),
      },
    });
  }
  if (getCookie(request, 'owner') === '1') {
    if (url.pathname === '/owner-status') {
      const nextTicket = parseInt((await redis.get('queue:nextTicket')) || '0', 10);
      const nowServing = parseInt((await redis.get('queue:nowServing')) || '0', 10);
      const nowServingUntil = parseInt((await redis.get('queue:nowServingUntil')) || '0', 10);
      const lastHeartbeat = parseInt((await redis.get('queue:lastHeartbeat')) || '0', 10);
      const now = Date.now();

      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Owner status</title>
<style>
  body{ background:#0c0c0d; color:#ebdcc3; font-family: Arial, sans-serif; padding: 2rem; max-width: 640px; margin: 0 auto; line-height: 1.8; }
  pre{ background:#1a1a1b; padding: 14px; border-radius: 4px; font-size: 13px; }
  a{ color:#a8e05f; }
</style>
</head><body>
  <h1>owner status — raw queue state</h1>
  <pre>nextTicket:        ${nextTicket}
nowServing:        ${nowServing}
nowServingUntil:   ${nowServingUntil}  (${nowServingUntil ? Math.round((nowServingUntil - now)/1000) + 's remaining' : 'never set'})
lastHeartbeat:     ${lastHeartbeat}  (${lastHeartbeat ? Math.round((now - lastHeartbeat)/1000) + 's ago' : 'never set'})
queue length (approx): ${Math.max(0, nextTicket - nowServing)}</pre>
  <p><a href="/owner-status">refresh</a></p>
  <p style="font-size:12px;color:rgba(235,220,195,0.5);">
    To reset everything: add &reset=1 to your ?owner=... link once, then remove it.
  </p>
</body></html>`;

      if (url.searchParams.get('reset') === '1') {
        await redis.del('queue:nextTicket', 'queue:nowServing', 'queue:nowServingUntil', 'queue:lastHeartbeat');
      }

      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return; // unlimited, ungated access
  }

  const open = isOpenNow();
  if (!open) {
    return new Response(closedHTML(), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  // ── ADMITTED? Check the signed cookie, then confirm it's still current ──
  const admitCookie = getCookie(request, 'admit');
  const admission = await verifyAdmission(admitCookie);
  if (admission) {
    const nowServing = parseInt((await redis.get('queue:nowServing')) || '0', 10);
    if (admission.ticket === nowServing) {
      return; // still genuinely the current visitor
    }
    // ticket no longer matches — someone else was promoted because this
    // visitor's heartbeat went quiet. Clear the stale cookies and send
    // them back through the gate fresh.
    const headers = new Headers({ Location: url.pathname + url.search });
    headers.append('Set-Cookie', clearCookieHeader('admit'));
    headers.append('Set-Cookie', clearCookieHeader('ticket'));
    return new Response(null, { status: 302, headers });
  }

  // ── HAVE A TICKET, WAITING? ──
  const ticket = getCookie(request, 'ticket');
  if (ticket) {
    return new Response(queueHTML('…'), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  // ── FRESH VISITOR ──
  return new Response(welcomeHTML(), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
