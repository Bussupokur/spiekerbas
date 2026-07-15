// middleware.js
// Runs before every request reaches the site. Decides whether the shop
// is "open" based on a fixed schedule (Europe/Amsterdam time). If closed,
// visitors see this page instead of the real site — nothing else loads.
//
// Placeholder schedule for now — swap in real hours whenever you decide them.

export const config = {
  matcher: '/((?!favicon.ico).*)',
};

const SCHEDULE = {
  // day index: [ [startHour, endHour], ... ] — 24h, Europe/Amsterdam
  0: [[14, 18]], // Sunday
  3: [[0, 24]],  // Wednesday — temporary, added for testing today. Remove once confirmed working.
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

const CLOSED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Closed for now — spiekerbas</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&display=swap" rel="stylesheet">
<style>
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
    background:#5a5a55; color:#e8e0d0;
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
    display:inline-block; text-align:left;
    font-size:14px; color: var(--cream-faint);
    letter-spacing:0.04em;
  }
  .hours-table div{ padding: 3px 0; }
  .hours-table span{ display:inline-block; width: 110px; color: var(--cream-dim); }
</style>
</head>
<body>
  <div id="stage">
    <div class="status-pill">closed</div>
    <h1>closed for now</h1>
    <p>back during opening hours — see the schedule below.</p>
    <div class="hours-table">
      <div><span>fri &ndash; sat</span>19:00 &ndash; 23:00</div>
      <div><span>sun</span>14:00 &ndash; 18:00</div>
      <div><span>mon &ndash; thu</span>closed</div>
    </div>
  </div>
</body>
</html>`;

export default function middleware(request) {
  if (isOpenNow()) {
    return; // open — let the real site through untouched
  }

  return new Response(CLOSED_HTML, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
