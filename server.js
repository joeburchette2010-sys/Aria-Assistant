'use strict';
const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ── Health ── */
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

/* ── Rate limiting (simple in-memory) ── */
const counts = {};
function rateLimit(ip) {
  const now  = Date.now();
  const key  = ip + ':' + Math.floor(now / 60000); // per-minute window
  counts[key] = (counts[key] || 0) + 1;
  return counts[key] > 30; // max 30 req/min per IP
}

/* ── Signup logging ── */
app.post('/api/signup', async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Missing fields' });
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  console.log(`🆕 NEW SIGNUP — Name: ${name} | Email: ${email} | Time: ${ts}`);
  res.json({ ok: true });
});

/* ── Claude proxy ── */
app.post('/api/chat', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (rateLimit(ip)) return res.status(429).json({ error: 'Too many requests. Please slow down.' });

  const { messages, system } = req.body;
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'messages array is required.' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set.' });

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-5',
        max_tokens: 1024,
        system:     system || '',
        messages
      })
    });

    const data = await upstream.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data);

  } catch (err) {
    console.error('[proxy error]', err.message);
    res.status(502).json({ error: 'Could not reach AI service. Try again shortly.' });
  }
});

/* ── SPA fallback ── */
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () => console.log(`✅  ARIA running → http://localhost:${PORT}`));
