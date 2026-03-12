'use strict';
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

const hits = {};
function rateLimit(ip) {
  const key = ip + ':' + Math.floor(Date.now() / 60000);
  hits[key] = (hits[key] || 0) + 1;
  if (hits[key] > 30) return true;
  if (Math.random() < 0.01) {
    const now = Math.floor(Date.now() / 60000);
    Object.keys(hits).forEach(k => { if (parseInt(k.split(':')[1]) < now - 2) delete hits[k]; });
  }
  return false;
}

app.post('/api/chat', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (rateLimit(ip)) return res.status(429).json({ error: 'Too many requests. Please slow down.' });

  const { messages, system } = req.body;
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'messages array is required.' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    return res.status(500).json({ error: 'Add ANTHROPIC_API_KEY in Render environment variables.' });

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system:     system || '',
        messages
      })
    });
    const data = await upstream.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data);
  } catch (err) {
    console.error('[proxy]', err.message);
    res.status(502).json({ error: 'Could not reach AI. Please try again.' });
  }
});

app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () =>
  console.log(`✅ ARIA on port ${PORT} [${PROD ? 'production' : 'dev'}]`)
);
