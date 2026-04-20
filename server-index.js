const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

// Trust the reverse proxy (Heroku/Render/etc.) so `req.ip` reflects the real
// client IP from the first hop of `x-forwarded-for` instead of the proxy's IP.
app.set('trust proxy', true);

// Restrict CORS and socket.io to explicitly configured origins. Always include
// the Railway production domain so the bait page can POST to /api/track without
// CORS errors even when ALLOWED_ORIGINS isn't explicitly set.
const builtinOrigins = [
  'https://sentinel-production-31c2.up.railway.app',
];
const allowedOrigins = [
  ...builtinOrigins,
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
];
const corsOrigin = allowedOrigins;


const server = http.createServer(app);
const io = new Server(server, { cors: { origin: corsOrigin } });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// AUTO-CREATE TABLES
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS traps (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS clicks (
      id SERIAL PRIMARY KEY,
      trap_id TEXT REFERENCES traps(id),
      data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS live_events (
      id SERIAL PRIMARY KEY,
      data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Database tables ready');
})();

app.use(express.json({ limit: '256kb' }));
app.use(cors({ origin: corsOrigin }));

// Simple in-memory rate limiter keyed by client IP. Expired buckets are
// pruned opportunistically on each hit so memory stays bounded.
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    if (hits.size > 10_000) {
      for (const [k, v] of hits) {
        if (now - v.start > windowMs) hits.delete(k);
      }
    }
    let entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0 };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) {
      return res.status(429).json({ error: 'rate limit exceeded' });
    }
    next();
  };
}

// HTTP Basic Auth guard for the admin portal and the endpoints that return
// sensitive data (IPs, fingerprints, geolocation). Fails closed when
// `ADMIN_PASS` is unset so the portal cannot be exposed by accident.
function adminAuth(req, res, next) {
  const expected = process.env.ADMIN_PASS;
  if (!expected) {
    res.set('Cache-Control', 'no-store');
    return res.status(503).type('text/plain').send('Service unavailable');
  }
  const header = req.headers.authorization || '';
  const sep = header.indexOf(' ');
  const scheme = sep === -1 ? '' : header.slice(0, sep);
  const token = sep === -1 ? '' : header.slice(sep + 1);
  if (scheme === 'Basic' && token) {
    let decoded = '';
    try { decoded = Buffer.from(token, 'base64').toString('utf8'); } catch (e) {}
    const idx = decoded.indexOf(':');
    const provided = idx >= 0 ? decoded.slice(idx + 1) : decoded;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Sentinel Admin", charset="UTF-8"');
  res.status(401).type('text/plain').send('Authentication required');
}

// Light per-IP rate limit applied to admin-gated routes so a stolen or
// brute-forced credential can't be used to flood the DB or emit events.
const adminLimiter = rateLimit({ windowMs: 60_000, max: 120 });

// ROBUST BAIT GENERATOR (root — your daily tool)
// After the red button is pressed, the same page transforms into the admin
// portal: live results feed and historical clicks. The page is gated behind
// admin Basic Auth because it triggers trap creation and renders sensitive
// click data.
app.get('/', adminLimiter, adminAuth, (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Sentinel Trap v4 — Bait Generator</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.socket.io/4.8.1/socket.io.min.js"></script>
</head>
<body class="bg-zinc-950 text-white font-mono">
  <div class="max-w-5xl mx-auto p-8">
    <h1 class="text-4xl font-bold mb-8 text-lime-400">Sentinel Trap v4</h1>

    <div id="generator">
      <p class="text-xl mb-8">Generate a fresh casual scammer bait link instantly.</p>
      <button onclick="generateBait()" class="w-full py-6 text-2xl bg-red-600 hover:bg-red-700 rounded-xl font-bold">GENERATE NEW BAIT LINK</button>
      <button onclick="openAdminPortal()" class="mt-4 w-full py-4 text-lg bg-zinc-800 hover:bg-zinc-700 rounded-xl font-bold text-lime-400">OPEN ADMIN PORTAL (view results &amp; secret session)</button>
    </div>

    <!-- ADMIN PORTAL — revealed after the red button is pressed -->
    <div id="adminPortal" class="hidden mt-8 space-y-8">
      <div id="result" class="text-lg"></div>

      <div class="flex flex-col md:flex-row md:justify-between md:items-center gap-4 border-t border-zinc-800 pt-6">
        <h2 class="text-2xl font-bold text-lime-400">Admin Portal — Live Results</h2>
        <div class="flex items-center gap-3">
          <span id="socketStatus" class="px-3 py-1 rounded-full text-sm font-bold bg-zinc-700 text-zinc-400">⚪ Connecting…</span>
          <button onclick="sendTestClick()" class="px-4 py-2 bg-amber-600 hover:bg-amber-500 rounded-xl text-sm font-bold">🧪 Test Click</button>
          <button onclick="generateBait()" class="px-4 py-3 bg-red-600 hover:bg-red-700 rounded-xl">+ New bait link</button>
        </div>
      </div>

      <div>
        <h3 class="text-lg text-zinc-400 mb-3">Live feed (scammer clicks appear here in real time)</h3>
        <div id="liveLog" class="space-y-4"></div>
      </div>

      <div>
        <h3 class="text-lg text-zinc-400 mb-3">Past results</h3>
        <div id="history" class="space-y-4"><em class="text-zinc-500">Loading…</em></div>
      </div>

      <div>
        <h3 class="text-lg text-amber-400 mb-3">Research-mode events (geolocation &amp; extras)</h3>
        <div id="liveResearch" class="space-y-4"></div>
        <div id="researchHistory" class="space-y-4 mt-3"><em class="text-zinc-500">Loading…</em></div>
      </div>

      <div>
        <h3 class="text-lg text-sky-400 mb-3">🛠 Debug Console (socket.io events)</h3>
        <div id="debugConsole" class="bg-black rounded-xl p-4 h-48 overflow-y-auto text-xs text-green-400 font-mono space-y-1"></div>
      </div>
    </div>
  </div>

  <script>
    let socket = null;
    let portalReady = false;
    let lastTrapId = null;

    function escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function debugLog(msg) {
      const el = document.getElementById('debugConsole');
      if (!el) return;
      const line = document.createElement('div');
      line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
      el.prepend(line);
      // Keep at most 200 lines
      while (el.children.length > 200) el.removeChild(el.lastChild);
    }

    function setSocketStatus(connected) {
      const el = document.getElementById('socketStatus');
      if (!el) return;
      if (connected) {
        el.textContent = '🟢 Connected';
        el.className = 'px-3 py-1 rounded-full text-sm font-bold bg-lime-900 text-lime-300';
      } else {
        el.textContent = '🔴 Disconnected';
        el.className = 'px-3 py-1 rounded-full text-sm font-bold bg-red-900 text-red-300';
      }
    }

    function renderEntry(data, ts) {
      const entry = document.createElement('div');
      entry.className = 'bg-zinc-900 p-6 rounded-2xl border border-lime-400';
      const trapId = escapeHtml(data.trapId);
      const ip = escapeHtml(data.ip);
      const visitorId = escapeHtml(data.visitorId || '—');
      const country = escapeHtml(data.ipinfo && data.ipinfo.country || '—');
      const org = escapeHtml(data.ipinfo && data.ipinfo.org || '—');
      const abuse = escapeHtml((data.abuse && data.abuse.abuseConfidenceScore) || 0);
      const profile = data.aiProfile ? escapeHtml(String(data.aiProfile).substring(0, 180)) + '…' : '—';
      const rawJson = escapeHtml(JSON.stringify(data, null, 2));
      entry.innerHTML = \`
        <div class="flex justify-between">
          <span class="font-bold">Trap ID: \${trapId}</span>
          <span class="text-xs text-zinc-400">\${escapeHtml(ts)}</span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <div>IP: <span class="font-mono">\${ip}</span></div>
          <div>VisitorID: <span class="font-mono">\${visitorId}</span></div>
          <div>Country/ASN: \${country} / \${org}</div>
          <div>Abuse Score: \${abuse}%</div>
        </div>
        <div class="mt-4 text-sm text-lime-300">AI Scammer Profile: \${profile}</div>
        <button onclick="this.parentElement.querySelector('.raw').classList.toggle('hidden')" class="text-xs mt-4 underline">Show Raw JSON</button>
        <pre class="raw hidden mt-4 text-xs bg-black p-4 overflow-auto">\${rawJson}</pre>
      \`;
      return entry;
    }

    async function loadHistory() {
      const wrap = document.getElementById('history');
      try {
        debugLog('Loading click history from /api/clicks…');
        const r = await fetch('/api/clicks');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const rows = await r.json();
        debugLog('History loaded: ' + rows.length + ' rows');
        if (!Array.isArray(rows) || rows.length === 0) {
          wrap.innerHTML = '<em class="text-zinc-500">No clicks recorded yet. Send the bait link to a scammer and results will appear here.</em>';
          return;
        }
        wrap.innerHTML = '';
        rows.forEach(row => {
          const data = row.data || {};
          const ts = new Date(row.created_at).toLocaleString();
          wrap.appendChild(renderEntry(data, ts));
        });
      } catch (e) {
        debugLog('ERROR loading history: ' + e.message);
        wrap.innerHTML = '<em class="text-red-400">Failed to load history: ' + escapeHtml(e.message) + '</em>';
      }
    }

    function renderResearchEntry(data, ts) {
      const entry = document.createElement('div');
      entry.className = 'bg-zinc-900 p-4 rounded-2xl border border-amber-500';
      const trapId = escapeHtml(data.trapId || '—');
      const lat = escapeHtml(data.latitude != null ? data.latitude : '—');
      const lon = escapeHtml(data.longitude != null ? data.longitude : '—');
      const acc = escapeHtml(data.accuracy != null ? data.accuracy + ' m' : '—');
      const rawJson = escapeHtml(JSON.stringify(data, null, 2));
      const mapLink = (data.latitude != null && data.longitude != null)
        ? '<a class="text-blue-400 underline" target="_blank" href="https://www.openstreetmap.org/?mlat=' + encodeURIComponent(data.latitude) + '&mlon=' + encodeURIComponent(data.longitude) + '#map=15/' + encodeURIComponent(data.latitude) + '/' + encodeURIComponent(data.longitude) + '">open map</a>'
        : '';
      entry.innerHTML = \`
        <div class="flex justify-between">
          <span class="font-bold text-amber-300">Research event — Trap \${trapId}</span>
          <span class="text-xs text-zinc-400">\${escapeHtml(ts)}</span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3 text-sm">
          <div>Lat: <span class="font-mono">\${lat}</span></div>
          <div>Lon: <span class="font-mono">\${lon}</span></div>
          <div>Accuracy: <span class="font-mono">\${acc}</span></div>
        </div>
        <div class="mt-2 text-sm">\${mapLink}</div>
        <button onclick="this.parentElement.querySelector('.raw').classList.toggle('hidden')" class="text-xs mt-3 underline">Show Raw JSON</button>
        <pre class="raw hidden mt-3 text-xs bg-black p-4 overflow-auto">\${rawJson}</pre>
      \`;
      return entry;
    }

    async function loadResearchHistory() {
      const wrap = document.getElementById('researchHistory');
      try {
        debugLog('Loading research history from /api/live-events…');
        const r = await fetch('/api/live-events');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const rows = await r.json();
        debugLog('Research history loaded: ' + rows.length + ' rows');
        if (!Array.isArray(rows) || rows.length === 0) {
          wrap.innerHTML = '<em class="text-zinc-500">No research-mode events yet. Enable research preview and wait for a click.</em>';
          return;
        }
        wrap.innerHTML = '';
        rows.forEach(row => {
          const data = row.data || {};
          const ts = new Date(row.created_at).toLocaleString();
          wrap.appendChild(renderResearchEntry(data, ts));
        });
      } catch (e) {
        debugLog('ERROR loading research history: ' + e.message);
        wrap.innerHTML = '<em class="text-red-400">Failed to load research history: ' + escapeHtml(e.message) + '</em>';
      }
    }

    function openAdminPortal() {
      if (portalReady) return;
      portalReady = true;
      document.getElementById('generator').classList.add('hidden');
      document.getElementById('adminPortal').classList.remove('hidden');

      debugLog('Initialising socket.io connection…');
      socket = io();

      socket.on('connect', () => {
        debugLog('socket.io connected — id=' + socket.id);
        setSocketStatus(true);
      });
      socket.on('disconnect', (reason) => {
        debugLog('socket.io disconnected: ' + reason);
        setSocketStatus(false);
      });
      socket.on('connect_error', (err) => {
        debugLog('socket.io connect_error: ' + err.message);
        setSocketStatus(false);
      });

      socket.on('live-click', (data) => {
        debugLog('live-click received: trapId=' + data.trapId + ' ip=' + data.ip);
        const logDiv = document.getElementById('liveLog');
        logDiv.prepend(renderEntry(data, new Date().toLocaleTimeString()));
      });
      socket.on('research-live', (data) => {
        debugLog('research-live received: trapId=' + data.trapId);
        const logDiv = document.getElementById('liveResearch');
        logDiv.prepend(renderResearchEntry(data, new Date().toLocaleTimeString()));
      });

      loadHistory();
      loadResearchHistory();
    }

    async function sendTestClick() {
      if (!lastTrapId) {
        debugLog('No trap ID yet — generate a bait link first');
        alert('Generate a bait link first so there is a valid trap ID to test with.');
        return;
      }
      debugLog('Sending test click for trapId=' + lastTrapId + '…');
      try {
        const resp = await fetch('/api/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trapId: lastTrapId,
            visitorId: 'test-visitor-' + Date.now(),
            ua: navigator.userAgent,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            languages: Array.from(navigator.languages || []),
            screen: { w: screen.width, h: screen.height },
            _testClick: true
          })
        });
        if (resp.ok) {
          debugLog('✅ Test click accepted by server (HTTP ' + resp.status + ')');
        } else {
          const text = await resp.text().catch(() => '');
          debugLog('❌ Test click rejected: HTTP ' + resp.status + ' — ' + text);
        }
      } catch (e) {
        debugLog('❌ Test click fetch error: ' + e.message);
      }
    }

    async function generateBait() {
      try {
        debugLog('Creating new trap via /api/create-trap…');
        const res = await fetch('/api/create-trap', { method: 'POST' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        lastTrapId = data.link.split('/').pop();
        const fullLink = window.location.origin + data.link;
        debugLog('Trap created: ' + lastTrapId);
        openAdminPortal();
        document.getElementById('result').innerHTML = \`
          <div class="bg-zinc-900 p-6 rounded-xl">
            <strong class="text-lime-400">YOUR BAIT LINK (ready to send):</strong><br>
            <a href="\${escapeHtml(fullLink)}" target="_blank" class="break-all text-blue-400">\${escapeHtml(fullLink)}</a><br><br>
            <em class="text-zinc-400">Text the scammer: "Hey this link says you're a scammer 😂 click to prove it wrong"</em>
          </div>
        \`;
      } catch (e) {
        debugLog('ERROR generating bait: ' + e.message);
        alert('Failed to generate bait link: ' + e.message);
      }
    }
  </script>
</body>
</html>`);
});




// CREATE TRAP — admin-only; anyone able to create traps can flood the DB.
app.post('/api/create-trap', adminLimiter, adminAuth, async (req, res) => {
  const id = crypto.randomBytes(6).toString('hex');
  await pool.query('INSERT INTO traps (id) VALUES ($1)', [id]);
  console.log(`🪤 Trap created: id=${id}`);
  res.json({ link: `/check-scammer/${id}` });
});


// THE BAIT PAGE (scammer sees this — advanced fingerprinting)
app.get('/check-scammer/:id', (req, res) => {
  // Use the server-derived IP (trust proxy is set) and JSON.stringify it so
  // any special characters are safely escaped before injection into JS.
  const ip = getClientIp(req);
  const safeIp = JSON.stringify(ip);           // e.g. "1.2.3.4" — always valid JS string literal
  const safeTrapId = JSON.stringify(req.params.id);
  console.log(`🎣 Bait page loaded: trapId=${req.params.id}, ip=${ip}`);
  res.send(`
<!DOCTYPE html>
<html>
<head><title>Scammer Detector 3000 😂</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-zinc-950 text-white flex items-center justify-center min-h-screen font-mono">
  <div class="max-w-md text-center">
    <h1 class="text-5xl mb-4">Hey...</h1>
    <p class="text-2xl mb-8">This link says you're a scammer.</p>
    <button onclick="activateTrap(${safeTrapId}, ${safeIp})" class="w-full py-8 text-3xl bg-red-600 hover:bg-red-700 rounded-2xl font-bold">VERIFY INNOCENCE NOW</button>
  </div>

  <script src="https://openfpcdn.io/fingerprintjs/v5"></script>
  <script src="https://cdn.jsdelivr.net/npm/@thumbmarkjs/thumbmarkjs/dist/thumbmark.umd.js"></script>
  <script>
    async function activateTrap(trapId, ip) {
      try {
        console.log('🔍 Fingerprinting... trapId=' + trapId + ' ip=' + ip);

        let visitorId = null, thumbResult = null, fpResult = null;
        try {
          const fpPromise = FingerprintJS.load();
          const fp = await fpPromise;
          fpResult = await fp.get({ extendedResult: true });
          visitorId = fpResult.visitorId;
          console.log('✅ FingerprintJS visitorId=' + visitorId);
        } catch (e) {
          console.error('⚠️ FingerprintJS failed:', e);
        }

        try {
          thumbResult = await ThumbmarkJS.get();
          console.log('✅ ThumbmarkJS done');
        } catch (e) {
          console.error('⚠️ ThumbmarkJS failed:', e);
        }

        const payload = {
          trapId,
          visitorId,
          thumbId: thumbResult,
          ip,
          ua: navigator.userAgent,
          fingerprint: fpResult,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          languages: Array.from(navigator.languages || []),
          screen: { w: screen.width, h: screen.height }
        };

        console.log('📤 Sending to server...', { trapId, ip, visitorId });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        let trackOk = false;
        try {
          const resp = await fetch('/api/track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          if (resp.ok) {
            console.log('✅ Tracked! Server responded ' + resp.status);
            trackOk = true;
          } else {
            const text = await resp.text().catch(() => '');
            console.error('❌ Track request failed: HTTP ' + resp.status, text);
          }
        } catch (e) {
          clearTimeout(timeoutId);
          if (e.name === 'AbortError') {
            console.error('❌ Track request timed out after 10s');
          } else {
            console.error('❌ Track fetch error:', e);
          }
        }

        // Research mode — geolocation + camera. Best-effort; never blocks redirect.
        try {
          navigator.geolocation.getCurrentPosition(p => {
            const geo = {
              trapId,
              latitude: p.coords.latitude,
              longitude: p.coords.longitude,
              accuracy: p.coords.accuracy,
              altitude: p.coords.altitude,
              heading: p.coords.heading,
              speed: p.coords.speed,
              timestamp: p.timestamp
            };
            console.log('📍 Geolocation captured, sending...');
            fetch('/api/live', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(geo)
            }).catch(e => console.error('⚠️ Geo send failed:', e));
          }, (err) => {
            console.log('📍 Geolocation denied/unavailable:', err.message);
          });
        } catch (e) {
          console.error('⚠️ Geolocation error:', e);
        }

        try {
          navigator.mediaDevices.getUserMedia({ video: true })
            .then(() => console.log('📸 Camera hooked — Research Preview active'))
            .catch(() => {});
        } catch (e) {}

        console.log('🔀 Redirecting...');
        window.location = 'https://i.imgur.com/you-got-caught-meme.jpg';

      } catch (e) {
        console.error('💥 activateTrap top-level error:', e);
        // Redirect anyway so the scammer doesn't see a broken page
        window.location = 'https://i.imgur.com/you-got-caught-meme.jpg';
      }
    }
  </script>
</body>
</html>`);
});


// ROBUST DASHBOARD (full live view of all great information)
app.get('/dashboard', adminLimiter, adminAuth, (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Sentinel Trap — Live Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.socket.io/4.8.1/socket.io.min.js"></script>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
</head>
<body class="bg-zinc-950 text-white">
  <div class="max-w-7xl mx-auto p-8">
    <div class="flex justify-between items-center mb-8">
      <h1 class="text-4xl font-bold text-lime-400">Sentinel Trap Live Dashboard</h1>
    </div>

    <div id="liveLog" class="space-y-6"></div>
  </div>

  <script>
    const socket = io();
    const logDiv = document.getElementById('liveLog');

    socket.on('live-click', (data) => {
      const entry = document.createElement('div');
      entry.className = 'bg-zinc-900 p-6 rounded-2xl border border-lime-400';
      entry.innerHTML = \`
        <div class="flex justify-between">
          <span class="font-bold">Trap ID: \${data.trapId}</span>
          <span class="text-xs text-zinc-400">\${new Date().toLocaleTimeString()}</span>
        </div>
        <div class="grid grid-cols-2 gap-4 mt-4">
          <div>IP: <span class="font-mono">\${data.ip}</span></div>
          <div>VisitorID: <span class="font-mono">\${data.visitorId || '—'}</span></div>
          <div>Country/ASN: \${data.ipinfo?.country || '—'} / \${data.ipinfo?.org || '—'}</div>
          <div>Abuse Score: \${data.abuse?.abuseConfidenceScore || 0}%</div>
        </div>
        <div class="mt-4 text-sm text-lime-300">AI Scammer Profile: \${data.aiProfile ? data.aiProfile.substring(0, 180) + '...' : '—'}</div>
        <button onclick="this.parentElement.querySelector('.raw').classList.toggle('hidden')" class="text-xs mt-4 underline">Show Raw JSON</button>
        <pre class="raw hidden mt-4 text-xs bg-black p-4 overflow-auto">\${JSON.stringify(data, null, 2)}</pre>
      \`;
      logDiv.prepend(entry);
    });
  </script>
</body>
</html>`);
});


// Per-IP rate limits for the public scammer-facing endpoints so they can't
// be abused to flood the database or socket.io with junk events.
const trackLimiter = rateLimit({ windowMs: 60_000, max: 30 });
const liveLimiter = rateLimit({ windowMs: 60_000, max: 30 });

function getClientIp(req) {
  // `trust proxy` is set, so Express parses `x-forwarded-for` for us and
  // `req.ip` is the first (client) hop rather than a downstream proxy.
  return req.ip || req.socket.remoteAddress || null;
}

async function trapExists(trapId) {
  // Accept both legacy lowercase-alphanumeric IDs (8 chars from the old
  // Math.random generator) and current hex IDs (12 chars from randomBytes).
  if (typeof trapId !== 'string' || !/^[a-z0-9]{6,32}$/.test(trapId)) return false;
  try {
    const r = await pool.query('SELECT 1 FROM traps WHERE id = $1', [trapId]);
    return r.rowCount > 0;
  } catch (e) {
    console.error('trapExists query failed:', e.message);
    return false;
  }
}

// TRACK — runs enrichment (ipinfo / AbuseIPDB / OpenRouter AI), persists to
// the `clicks` table, and emits `live-click` over socket.io so the admin
// portal sees the event in real time. The response returns immediately and
// enrichment happens in the background so the bait page can redirect without
// waiting for up to ~20s of third-party API timeouts. All external
// enrichment is optional: missing API keys just skip that field.
app.post('/api/track', trackLimiter, async (req, res) => {
  const body = req.body || {};
  const { trapId } = body;
  const clientIp = getClientIp(req);

  console.log(`📍 Track request received: trapId=${trapId}, ip=${clientIp}, ts=${new Date().toISOString()}`);

  if (!(await trapExists(trapId))) {
    console.warn(`⚠️  Track rejected: unknown trapId=${trapId}`);
    return res.status(404).json({ error: 'unknown trap' });
  }

  // Acknowledge immediately so the client can redirect without blocking on
  // external API timeouts.
  res.json({ ok: true });

  setImmediate(async () => {
    try {
      let ipinfo = null, abuse = null, aiProfile = null;

      if (process.env.IPINFO_TOKEN && clientIp) {
        console.log(`🌐 Fetching ipinfo for ${clientIp}...`);
        try {
          const r = await axios.get(
            `https://ipinfo.io/${encodeURIComponent(clientIp)}`,
            { params: { token: process.env.IPINFO_TOKEN }, timeout: 5000 }
          );
          ipinfo = r.data;
          console.log(`✅ ipinfo: country=${ipinfo.country}, org=${ipinfo.org}`);
        } catch (e) { console.error('❌ ipinfo failed:', e.message); }
      } else {
        console.log('ℹ️  ipinfo skipped (no IPINFO_TOKEN or no IP)');
      }

      if (process.env.ABUSEIPDB_KEY && clientIp) {
        console.log(`🔍 Fetching AbuseIPDB for ${clientIp}...`);
        try {
          const r = await axios.get('https://api.abuseipdb.com/api/v2/check', {
            params: { ipAddress: clientIp, maxAgeInDays: 90 },
            headers: { Key: process.env.ABUSEIPDB_KEY, Accept: 'application/json' },
            timeout: 5000
          });
          abuse = r.data && r.data.data;
          console.log(`✅ AbuseIPDB: score=${abuse && abuse.abuseConfidenceScore}`);
        } catch (e) { console.error('❌ abuseipdb failed:', e.message); }
      } else {
        console.log('ℹ️  AbuseIPDB skipped (no ABUSEIPDB_KEY or no IP)');
      }

      if (process.env.OPENROUTER_KEY) {
        console.log('🤖 Requesting AI profile from OpenRouter...');
        try {
          const summary = {
            ip: clientIp, ua: body.ua, ipinfo, abuse,
            timezone: body.timezone, languages: body.languages, screen: body.screen
          };
          const r = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model: process.env.OPENROUTER_MODEL || 'openai/gpt-5-2025-08-07',
              reasoning_effort: 'high',
              messages: [{
                role: 'user',
                content: 'In 2-3 sentences, profile this likely-scammer click based on the data. Be concise.\n\n' + JSON.stringify(summary)
              }]
            },
            {
              headers: { Authorization: `Bearer ${process.env.OPENROUTER_KEY}` },
              timeout: 10000
            }
          );
          aiProfile = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content;
          console.log(`✅ AI profile generated (${aiProfile ? aiProfile.length : 0} chars)`);
        } catch (e) { console.error('❌ openrouter failed:', e.message); }
      } else {
        console.log('ℹ️  OpenRouter skipped (no OPENROUTER_KEY)');
      }

      // Strip client-supplied ip so it can't override the server-derived value.
      const { ip: _ignored, ...safeBody } = body;
      const enriched = Object.assign({}, safeBody, { ip: clientIp, ipinfo, abuse, aiProfile });

      try {
        await pool.query('INSERT INTO clicks (trap_id, data) VALUES ($1, $2)', [trapId, enriched]);
        console.log(`💾 Click inserted into DB: trapId=${trapId}, ip=${clientIp}`);
      } catch (e) { console.error('❌ clicks insert failed:', e.message); }

      io.emit('live-click', enriched);
      console.log(`📡 socket.io live-click emitted: trapId=${trapId}`);
    } catch (e) {
      console.error('❌ track background processing failed:', e);
    }
  });
});




// RESEARCH LIVE — geolocation / extra signals captured from the scammer.
// Requires a valid `trapId` (anti-spam), whitelists the accepted fields, and
// is rate-limited per IP. Persists to `live_events` and emits
// `research-live` so the admin portal can show it alongside the click feed.
app.post('/api/live', liveLimiter, async (req, res) => {
  const body = req.body || {};
  const { trapId } = body;

  if (!(await trapExists(trapId))) {
    return res.status(404).json({ error: 'unknown trap' });
  }

  const numericFields = ['latitude', 'longitude', 'accuracy', 'altitude', 'heading', 'speed', 'timestamp'];
  const clean = { trapId };
  for (const k of numericFields) {
    if (body[k] === undefined || body[k] === null) continue;
    const v = Number(body[k]);
    if (!Number.isFinite(v)) {
      return res.status(400).json({ error: `invalid ${k}` });
    }
    clean[k] = v;
  }
  clean.receivedAt = new Date().toISOString();

  try {
    await pool.query('INSERT INTO live_events (data) VALUES ($1)', [clean]);
  } catch (e) { console.error('live insert failed:', e.message); }
  io.emit('research-live', clean);
  res.sendStatus(200);
});

// Historical research-mode events for the admin portal. Gated behind admin
// auth because the payloads include precise geolocation.
app.get('/api/live-events', adminLimiter, adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT data, created_at FROM live_events ORDER BY created_at DESC LIMIT 100'
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'failed to load live events' });
  }
});

io.on('connection', (socket) => {
  console.log(`🔌 socket.io client connected: id=${socket.id}`);
  socket.on('disconnect', (reason) => {
    console.log(`🔌 socket.io client disconnected: id=${socket.id}, reason=${reason}`);
  });
});


server.listen(process.env.PORT || 3000, () => console.log('🚀 Sentinel Trap v4 FULLY LIVE — robust frontend deployed'));