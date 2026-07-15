// middleware.js
// Runs before every request reaches the site. There is ALWAYS a threshold
// screen first — a welcome screen when open, a closed screen when not.
// Nobody lands directly on the real site without deliberately stepping
// through "come on in" first. Once they do, a cookie remembers that for
// the rest of their visit, so it doesn't repeat on every page load.

export const config = {
  matcher: '/((?!favicon.ico).*)',
};

const SCHEDULE = {
  // day index: [ [startHour, endHour], ... ] — 24h, Europe/Amsterdam
  0: [[14, 18]], // Sunday
  3: [[12, 18]], // Wednesday
  5: [[19, 23]], // Friday
  6: [[19, 23]], // Saturday
};

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

  return {
    day: dayMap[map.weekday],
    hour: parseInt(map.hour, 10),
  };
}

function isOpenNow() {
  const { day, hour } = getAmsterdamNow();
  const windows = SCHEDULE[day] || [];
  return windows.some(([start, end]) => hour >= start && hour < end);
}

function hasEnteredCookie(request) {
  const cookie = request.headers.get('cookie') || '';
  return cookie.split(';').some((c) => c.trim().startsWith('entered=1'));
}

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
  .live-clock{
    font-size:12px;
    letter-spacing:0.18em;
    color: var(--cream-faint);
    text-transform:lowercase;
    margin-top: 1.6rem;
    font-family: Arial, sans-serif;
  }
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
      <div><span>mon &ndash; thu</span>closed</div>
    </div>
    <div class="live-clock" id="liveClock"></div>
  </div>
  <script>
    function tickClock(){
      const el = document.getElementById('liveClock');
      if(!el) return;
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Amsterdam',
        weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }).formatToParts(new Date());
      const map = {};
      parts.forEach(p => map[p.type] = p.value);
      el.textContent = `${map.weekday} ${map.hour}:${map.minute}:${map.second} — Amsterdam time`;
    }
    tickClock();
    setInterval(tickClock, 1000);
  </script>
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
    <p>nothing starts until you actually step through — no timer, no queue slot claimed, until you click.</p>
    <a class="enter-btn" href="/?enter=1">come on in</a>
    <div class="timer-note">your 30 minutes starts once you enter.</div>
    <div class="hours-table">
      <div><span>fri &ndash; sat</span>19:00 &ndash; 23:00</div>
      <div><span>sun</span>14:00 &ndash; 18:00</div>
      <div><span>wed</span>12:00 &ndash; 18:00</div>
    </div>
    <div class="live-clock" id="liveClock"></div>
  </div>
  <script>
    function tickClock(){
      const el = document.getElementById('liveClock');
      if(!el) return;
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Amsterdam',
        weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }).formatToParts(new Date());
      const map = {};
      parts.forEach(p => map[p.type] = p.value);
      el.textContent = `${map.weekday} ${map.hour}:${map.minute}:${map.second} — Amsterdam time`;
    }
    tickClock();
    setInterval(tickClock, 1000);
  </script>
</body>
</html>`;
}

export default function middleware(request) {
  const url = new URL(request.url);

  // already entered this session — let everything through, no repeat screen
  if (hasEnteredCookie(request)) {
    return;
  }

  const open = isOpenNow();

  // visitor just clicked "come on in" from the welcome screen
  if (url.searchParams.get('enter') === '1') {
    if (!open) {
      // schedule flipped to closed between page load and click — send them
      // back to the (now closed) threshold instead of letting them through
      return new Response(closedHTML(), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    url.searchParams.delete('enter');
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.pathname + url.search,
        'Set-Cookie': 'entered=1; Path=/; Max-Age=86400; SameSite=Lax',
      },
    });
  }

  // first visit this session — always a threshold screen, never a silent pass-through
  return new Response(open ? welcomeHTML() : closedHTML(), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
