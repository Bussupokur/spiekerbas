// middleware.js
// Thin gate: opening hours, and (when QUEUE_ENABLED) checking the signed
// admission cookie. All the actual queue logic lives in /api/enter.js and
// /api/status.js — this file just decides which screen to show.
//
// QUEUE_ENABLED currently false (see lib/gate.js) — the gate only checks
// hours. No tickets, no waiting, no session limit. Flip it back to true
// later to re-enable everything below without rebuilding it.

import {
  redis, isOpenNow, getCookie, verifyAdmission, OWNER_SECRET, setCookieHeader,
  clearCookieHeader, getAmsterdamDateKey, QUEUE_ENABLED,
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
  .hours-label{
    font-size: 11px;
    letter-spacing: 0.2em;
    text-transform: lowercase;
    color: rgba(235,220,195,0.45);
    font-family: Arial, sans-serif;
    margin-bottom: 0.6rem;
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
  .live-clock{
    font-size:12px;
    letter-spacing:0.18em;
    color: var(--cream-faint);
    text-transform:lowercase;
    margin-top: 1.6rem;
    font-family: Arial, sans-serif;
  }
  .contact-note{
    font-size:11px;
    letter-spacing:0.06em;
    color: rgba(235,220,195,0.4);
    font-family: Arial, sans-serif;
    margin-top: 0.7rem;
  }
  .contact-note a{
    color: rgba(235,220,195,0.6);
    text-decoration: none;
    border-bottom: 1px solid rgba(235,220,195,0.25);
  }
  .contact-note a:hover{ color: var(--cream); }
`;

const CLOCK_SCRIPT = `
  <script>
    function tickClock(){
      var el = document.getElementById('liveClock');
      if(!el) return;
      var parts = new Intl.DateTimeFormat('nl-NL', {
        timeZone: 'Europe/Amsterdam',
        weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }).formatToParts(new Date());
      var map = {};
      parts.forEach(function(p){ map[p.type] = p.value; });
      el.textContent = map.hour + ':' + map.minute + ':' + map.second + ' \u2014 Amsterdam';
    }
    tickClock();
    setInterval(tickClock, 1000);
  </script>
`;

function closedHTML() {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gesloten — spiekerbas</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&display=swap" rel="stylesheet">
<style>${PAGE_STYLES}</style>
</head>
<body>
  <div id="stage">
    <div class="status-pill closed">gesloten</div>
    <h1>nu gesloten</h1>
    <p>terug tijdens openingstijden — zie hieronder.</p>
    <div class="hours-label">opening times</div>
    <div class="hours-table">
      <div><span>vrijdag</span>all day</div>
      <div><span>zaterdag</span>all day</div>
      <div><span>zondag</span>all day</div>
      <div><span>ma, di, wo, do</span>closed</div>
    </div>
    <div class="live-clock" id="liveClock"></div>
    <div class="contact-note">vragen? <a href="mailto:inquiries@spiekerbas.xyz">inquiries@spiekerbas.xyz</a></div>
  </div>
  ${CLOCK_SCRIPT}
</body>
</html>`;
}

function welcomeHTML() {
  return `<!DOCTYPE html>
<html lang="nl">
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
    <div class="status-pill open">open</div>
    <h1>open</h1>
    <p>enter at eigen risico.</p>
    <a class="enter-btn" href="/?enter=1">enter</a>
    <div class="hours-label">opening times</div>
    <div class="hours-table">
      <div><span>vrijdag</span>all day</div>
      <div><span>zaterdag</span>all day</div>
      <div><span>zondag</span>all day</div>
    </div>
    <div class="live-clock" id="liveClock"></div>
    <div class="contact-note">vragen? <a href="mailto:inquiries@spiekerbas.xyz">inquiries@spiekerbas.xyz</a></div>
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
<style>${PAGE_STYLES}
  .status-pill.queue{ background:#ffd23f; color:#3a2c05; }
  .queue-position{
    font-size: clamp(40px,8vw,64px);
    font-weight:300; font-style:italic;
    color: #ffd23f;
    margin: 0.4rem 0 1.2rem;
  }
</style>
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
    document.addEventListener('visibilitychange', function(){
      if(!document.hidden){ poll(); }
    });
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
      const totalVisits = parseInt((await redis.get('stats:visits:total')) || '0', 10);
      const todayKey = getAmsterdamDateKey();
      const todayVisits = parseInt((await redis.get(`stats:visits:${todayKey}`)) || '0', 10);
      const now = Date.now();

      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Owner status</title>
<style>
  body{ background:#0c0c0d; color:#ebdcc3; font-family: Arial, sans-serif; padding: 2rem; max-width: 640px; margin: 0 auto; line-height: 1.8; }
  pre{ background:#1a1a1b; padding: 14px; border-radius: 4px; font-size: 13px; }
  a{ color:#a8e05f; }
</style>
</head><body>
  <h1>owner status ${QUEUE_ENABLED ? '' : '— queue system OFF'}</h1>
  <pre>nextTicket:        ${nextTicket}
nowServing:        ${nowServing}
nowServingUntil:   ${nowServingUntil}  (${nowServingUntil ? Math.round((nowServingUntil - now)/1000) + 's remaining' : 'never set'})
lastHeartbeat:     ${lastHeartbeat}  (${lastHeartbeat ? Math.round((now - lastHeartbeat)/1000) + 's ago' : 'never set'})
queue length (approx): ${Math.max(0, nextTicket - nowServing)}

visits today (${todayKey}): ${todayVisits}
visits total:      ${totalVisits}</pre>
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

  // ── QUEUE SYSTEM OFF: hours are the only check, plus a simple ──
  // "already stepped through" cookie so clicking enter actually works
  // and the rest of the site stays reachable, not stuck re-showing this
  // screen on every single click.
  if (!QUEUE_ENABLED) {
    if (url.searchParams.get('enter') === '1') {
      url.searchParams.delete('enter');
      return new Response(null, {
        status: 302,
        headers: {
          Location: url.pathname + url.search,
          'Set-Cookie': setCookieHeader('seen', '1', 21600),
        },
      });
    }
    if (getCookie(request, 'seen') === '1') {
      return; // already stepped through today — let the real site load
    }
    return new Response(welcomeHTML(), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  // ── everything below only runs if QUEUE_ENABLED is ever set back to true ──

  // ── ADMITTED? Check the signed cookie, then confirm it's still current ──
  const admitCookie = getCookie(request, 'admit');
  const admission = await verifyAdmission(admitCookie);
  if (admission) {
    const nowServing = parseInt((await redis.get('queue:nowServing')) || '0', 10);
    if (admission.ticket === nowServing) {
      return; // still genuinely the current visitor
    }
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
