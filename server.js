'use strict';
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ── In-memory stores ── */
const signups   = [];
const errorLog  = [];
const agentLog  = [];
const visitors  = [];
let   lastBriefing = null;

const _origErr = console.error;
console.error = (...args) => {
  errorLog.push({ ts: new Date().toISOString(), msg: args.join(' ') });
  if (errorLog.length > 100) errorLog.shift();
  _origErr(...args);
};

/* ── Pro email list ── */
const PRO_EMAILS = new Set(['joeburchette2010@gmail.com']);
function grantPro(email) { PRO_EMAILS.add(email.toLowerCase()); }
function getModel(email, isPro) {
  if (PRO_EMAILS.has((email||'').toLowerCase()) || isPro) return 'claude-sonnet-4-20250514';
  return 'claude-haiku-4-5-20251001';
}

/* ── Health ── */
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

/* ── Rate limiter ── */
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

/* ── Admin auth ── */
function adminAuth(req, res, next) {
  const token = (req.headers['x-admin-token'] || req.query.token || '').trim();
  const adminPassword = (process.env.ADMIN_PASSWORD || 'aria-admin-2025').trim();
  if (token !== adminPassword) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/* ── Deploy secret auth ── */
function deployAuth(secret) {
  return secret === (process.env.DEPLOY_SECRET || 'aria-deploy-2025');
}

/* ── GitHub helper ── */
async function githubPush(filename, content) {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO;
  const email = process.env.GITHUB_EMAIL || 'deploy@aria.app';
  if (!token || !repo) throw new Error('GitHub env vars not set');
  const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${filename}`, {
    headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' }
  });
  const fileData = await getRes.json();
  if (!fileData.sha) throw new Error('File not found: ' + filename);
  const ts = new Date().toISOString().replace('T',' ').substring(0,19);
  const pushRes = await fetch(`https://api.github.com/repos/${repo}/contents/${filename}`, {
    method: 'PUT',
    headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Auto-deploy: ${filename} [${ts}]`,
      content: Buffer.from(content).toString('base64'),
      sha: fileData.sha,
      committer: { name: 'ARIA Deploy Bot', email }
    })
  });
  const result = await pushRes.json();
  if (!result.content && pushRes.status !== 422) throw new Error(result.message || 'Push failed');
  return true;
}

/* ── Signup ── */
app.post('/api/signup', async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Missing fields' });
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  signups.push({ name, email, joined: new Date().toISOString(), ts });
  console.log(`NEW SIGNUP — Name: ${name} | Email: ${email} | Time: ${ts}`);
  const webhook = process.env.SHEETS_WEBHOOK;
  if (webhook) {
    try {
      await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, joined: new Date().toISOString(), ts, total: signups.length }) });
    } catch(e) { console.error('Sheets webhook failed:', e.message); }
  }
  res.json({ ok: true });
});

/* ── Admin API ── */
app.get('/api/admin/signups', adminAuth, (req, res) => {
  res.json({ total: signups.length, signups: signups.slice().reverse() });
});
app.get('/api/admin/export', adminAuth, (req, res) => {
  const csv = ['Name,Email,Joined'].concat(signups.map(s => `"${s.name}","${s.email}","${s.ts}"`)).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="aria-users.csv"');
  res.send(csv);
});

/* ── Agent log endpoint (called by Cloudflare Worker) ── */
app.post('/api/agent/log', (req, res) => {
  const { secret, action, details, status, briefing } = req.body;
  if (!deployAuth(secret)) return res.status(401).json({ error: 'Unauthorized' });
  const entry = { ts: new Date().toISOString(), action, details, status: status || 'success' };
  agentLog.unshift(entry);
  if (agentLog.length > 100) agentLog.pop();
  if (briefing) lastBriefing = { ts: new Date().toISOString(), content: briefing };
  console.log(`AGENT: ${action} — ${details}`);

  // Log to Google Sheets
  const webhook = process.env.SHEETS_WEBHOOK;
  if (webhook) {
    fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `AGENT: ${action}`, email: details, joined: new Date().toISOString(), ts: new Date().toLocaleString('en-US',{timeZone:'America/New_York'}) })
    }).catch(()=>{});
  }
  res.json({ ok: true });
});

/* ── Agent stats API ── */
app.get('/api/agent/stats', adminAuth, (req, res) => {
  const now = new Date();
  const oneDayAgo = new Date(now - 24*60*60*1000);
  res.json({
    total:    agentLog.length,
    today:    agentLog.filter(a => new Date(a.ts) > oneDayAgo).length,
    status:   agentLog.length > 0 ? agentLog[0].status : 'idle',
    log:      agentLog.slice(0, 20),
    briefing: lastBriefing
  });
});

/* ── Command Center stats ── */
app.get('/api/command/stats', adminAuth, (req, res) => {
  const now = new Date();
  const oneDayAgo  = new Date(now - 24*60*60*1000);
  const oneWeekAgo = new Date(now - 7*24*60*60*1000);
  const dailyCounts = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(now - i*24*60*60*1000);
    const dayStr = day.toDateString();
    dailyCounts.push({ label: day.toLocaleDateString('en-US',{month:'short',day:'numeric'}), count: signups.filter(s=>new Date(s.joined).toDateString()===dayStr).length });
  }
  res.json({ total: signups.length, today: signups.filter(s=>new Date(s.joined)>oneDayAgo).length, week: signups.filter(s=>new Date(s.joined)>oneWeekAgo).length, recentSignups: signups.slice(-5).reverse(), allSignups: signups.slice().reverse(), dailyCounts, errors: errorLog.slice(-10).reverse(), uptime: process.uptime() });
});

/* ── Command Center AI ── */
app.post('/api/command/ai', adminAuth, async (req, res) => {
  const { type } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  const stats = { totalUsers: signups.length, recentSignups: signups.slice(-5).map(s=>s.name), recentErrors: errorLog.slice(-3).map(e=>e.msg) };
  const prompts = {
    features:    `You are ARIA's product advisor. Based on these stats: ${JSON.stringify(stats)}, suggest the 3 most impactful features to build next for an AI admin assistant. Be specific. Format as numbered list.`,
    newsletter:  `Write a short engaging newsletter update (150 words max) for ARIA, an AI admin assistant. Stats: ${JSON.stringify(stats)}. Tone: founder building in public, genuine and direct.`,
    shareholder: `Write a professional 200-word shareholder update for ARIA. Stats: ${JSON.stringify(stats)}. Cover user growth, product progress, next milestones, revenue potential.`,
    reddit:      `Write a Reddit post for r/SideProject about ARIA, an AI admin assistant app built solo on an iPad with zero budget. Stats: ${JSON.stringify(stats)}. Compelling title, authentic founder story, what ARIA does, honest progress, ask for feedback. End with: myaria-assistant.onrender.com and wes1504562.substack.com. Format: Title on first line, then body.`,
    discord:     `Write 3 things for the ARIA Discord (discord.gg/bVTKZqpR):\n1. Welcome message for new members\n2. Pinned getting-started guide\n3. Beta announcement post\nARIA stats: ${JSON.stringify(stats)}. ARIA is an AI admin assistant at myaria-assistant.onrender.com. Tone: warm, excited founder.`
  };
  if (!prompts[type]) return res.status(400).json({ error: 'Invalid type' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 512, messages: [{ role: 'user', content: prompts[type] }] })
    });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ content: data.content[0].text });
  } catch(err) { res.status(502).json({ error: 'AI request failed' }); }
});

/* ── Visitor analytics ── */
app.post('/api/track', (req, res) => {
  const { page, ref, ts } = req.body;
  visitors.push({ page, ref, ts, ip: (req.headers['x-forwarded-for']||'unknown').split(',')[0].substring(0,15) });
  if (visitors.length > 500) visitors.shift();
  res.json({ ok: true });
});
app.get('/api/command/visitors', adminAuth, (req, res) => {
  const now = new Date();
  const oneDayAgo  = new Date(now - 24*60*60*1000);
  const oneWeekAgo = new Date(now - 7*24*60*60*1000);
  const landing = visitors.filter(v => v.page === 'landing');
  const sources = {};
  landing.forEach(v => {
    try { const src = v.ref ? new URL(v.ref).hostname : 'direct'; sources[src] = (sources[src]||0) + 1; } catch(e) { sources['direct'] = (sources['direct']||0) + 1; }
  });
  res.json({ total: landing.length, today: landing.filter(v=>new Date(v.ts)>oneDayAgo).length, week: landing.filter(v=>new Date(v.ts)>oneWeekAgo).length, recent: landing.slice(-5).reverse(), sources });
});

/* ── Discord proxy via Cloudflare Worker ── */
app.post('/api/discord/post', adminAuth, async (req, res) => {
  const { channelId, content } = req.body;
  const webhooks = {
    '1483261401664458972': 'https://discord.com/api/webhooks/1483317584584769658/PY1MTsRh2Q0pr_PYZ3I8rulS8CbPM-7tvgkq3kDlyQS0dn7m7DgfWa43ihGnDk3u9qfm',
    '1483261092062040184': 'https://discord.com/api/webhooks/1483318309716754472/pAB5yGi_P_28uyBmGp36u18bRDHUi2uTQkBRKVyAWkX-TZoB4y6JyGGJ-atT6oAccavY'
  };
  const webhookUrl = webhooks[channelId];
  if (!webhookUrl) return res.status(400).json({ error: 'No webhook for channel' });
  try {
    const r = await fetch('https://aria-agent.joeburchette2010.workers.dev/discord', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl, content })
    });
    const data = await r.json();
    if (data.ok) { console.log(`DISCORD POST: channel ${channelId}`); res.json({ ok: true }); }
    else res.status(500).json({ error: 'Discord post failed: ' + (data.error || data.status) });
  } catch(err) { res.status(502).json({ error: 'Agent proxy failed: ' + err.message }); }
});

/* ── Deploy endpoints ── */
app.post('/api/deploy', async (req, res) => {
  const { secret, filename, content } = req.body;
  if (!deployAuth(secret)) return res.status(401).json({ error: 'Invalid deploy secret' });
  try { await githubPush(filename, content); res.json({ ok: true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/deploy-latest', async (req, res) => {
  const { secret, filename } = req.body;
  if (!deployAuth(secret)) return res.status(401).json({ error: 'Invalid deploy secret' });
  try {
    const token = process.env.GITHUB_TOKEN;
    const repo  = process.env.GITHUB_REPO;
    if (!token || !repo) return res.status(500).json({ error: 'GitHub env vars not set' });
    const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${filename}`, {
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    const fileData = await getRes.json();
    if (!fileData.sha) return res.status(404).json({ error: 'File not found: ' + filename });
    const content = Buffer.from(fileData.content.replace(/\n/g,''), 'base64').toString('utf8');
    await githubPush(filename, content);
    res.json({ ok: true, message: `${filename} deployed` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/* ── Admin redirects to command ── */
app.get('/admin', (_req, res) => res.redirect('/command'));

/* ── Agent Activity Log ── */
app.post('/api/agent/log', (req, res) => {
  const secret = req.headers['x-agent-secret'] || req.query.secret;
  if (secret !== (process.env.DEPLOY_SECRET || 'aria-deploy-2025')) return res.status(401).json({ error: 'Unauthorized' });
  const { action, details, status } = req.body;
  const entry = { ts: new Date().toISOString(), action: action||'Action', details: details||'', status: status||'completed' };
  agentLog.unshift(entry);
  if (agentLog.length > 200) agentLog.pop();
  console.log(`AGENT: ${entry.action} — ${entry.status}`);
  res.json({ ok: true });
});
app.get('/api/agent/log', adminAuth, (req, res) => {
  res.json({ total: agentLog.length, log: agentLog.slice(0, 50) });
});


app.get('/home', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

/* ── Command Center ── */
app.get('/command', (_req, res) => res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ARIA Command Center</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Geist',sans-serif;background:#f9f6f1;color:#1a1612;min-height:100vh}
.login{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.lcard{background:white;border-radius:16px;padding:32px 24px;width:100%;max-width:360px;box-shadow:0 8px 32px rgba(0,0,0,.1)}
.brand{display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:28px}
.bicon{width:36px;height:36px;background:linear-gradient(135deg,#c4923a,#e8b060);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;color:#1a1612}
.bname{font-size:20px;font-weight:300;letter-spacing:3px;text-transform:uppercase}
.lbl{font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#6b5e56;margin-bottom:6px}
.field{width:100%;padding:12px 14px;border:1.5px solid #ebe2d5;border-radius:8px;font-family:inherit;font-size:14px;outline:none;margin-bottom:14px;background:#f9f6f1;-webkit-appearance:none}
.field:focus{border-color:#c4923a;background:white}
.btn{width:100%;padding:13px;background:#1a1612;color:white;border:none;border-radius:8px;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer}
.btn:active{background:#c4923a}
.err{font-size:12px;color:#dc2626;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:9px 12px;margin-bottom:12px;display:none}
.dash{display:none;padding:20px;max-width:1000px;margin:0 auto}
.topnav{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;padding:14px 0;border-bottom:1px solid #ebe2d5}
.tnleft{display:flex;align-items:center;gap:8px}
.tnicon{width:28px;height:28px;background:linear-gradient(135deg,#c4923a,#e8b060);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;color:#1a1612}
.tntitle{font-size:16px;font-weight:500}
.tnsub{font-size:12px;color:#9b8c84}
.signout{font-size:12px;color:#9b8c84;background:none;border:1px solid #ebe2d5;border-radius:6px;padding:6px 12px;cursor:pointer;font-family:inherit}
.tabs{display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap}
.tab-btn{padding:8px 14px;border-radius:100px;border:1.5px solid #ebe2d5;background:#f9f6f1;font-family:inherit;font-size:12px;font-weight:500;color:#9b8c84;cursor:pointer}
.tab-btn.active{background:#1a1612;color:white;border-color:#1a1612}
.tab-content{display:none}.tab-content.active{display:block}
.sgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:20px}
.stat{background:white;border:1px solid #ebe2d5;border-radius:12px;padding:16px;text-align:center}
.sval{font-size:26px;font-weight:600;color:#c4923a;font-family:Georgia,serif}
.slbl{font-size:11px;color:#9b8c84;text-transform:uppercase;letter-spacing:1px;margin-top:4px}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
@media(max-width:600px){.g2{grid-template-columns:1fr}}
.panel{background:white;border:1px solid #ebe2d5;border-radius:12px;padding:18px;margin-bottom:16px}
.ptitle{font-size:13px;font-weight:600;color:#1a1612;margin-bottom:4px}
.psub{font-size:11px;color:#9b8c84;margin-bottom:14px}
.abtn{padding:9px 16px;background:#1a1612;color:white;border:none;border-radius:7px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;margin-bottom:12px}
.abtn:active{background:#c4923a}.abtn:disabled{background:#9b8c84;cursor:not-allowed}
.aout{background:#f9f6f1;border:1px solid #ebe2d5;border-radius:8px;padding:12px;font-size:13px;line-height:1.7;color:#3d3530;white-space:pre-wrap;min-height:60px;display:none;max-height:200px;overflow-y:auto}
.cbtn{font-size:11px;padding:4px 10px;background:white;border:1px solid #ebe2d5;border-radius:5px;cursor:pointer;font-family:inherit;margin-top:8px;margin-right:6px;display:none}
.cbtn.ok{background:#f0fdf4;border-color:#86efac;color:#166534}
.dbtn{font-size:11px;padding:4px 10px;background:#5865F2;color:white;border:none;border-radius:5px;cursor:pointer;font-family:inherit;margin-top:8px;display:none}
.eitem{padding:8px 0;border-bottom:1px solid #f3ede4;font-size:12px;color:#dc2626;font-family:monospace;line-height:1.5}
.eitem:last-child{border:none}
.etime{font-size:10px;color:#9b8c84;display:block;margin-bottom:2px;font-family:inherit}
.sitem{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f3ede4}
.sitem:last-child{border:none}
.sname{font-size:13px;font-weight:500;color:#1a1612}
.semail{font-size:12px;color:#c4923a}
.stime{font-size:11px;color:#9b8c84}
.empty{font-size:13px;color:#9b8c84;text-align:center;padding:20px 0}
.chart{display:flex;align-items:flex-end;gap:6px;height:80px;margin-top:8px}
.bwrap{display:flex;flex-direction:column;align-items:center;flex:1;gap:4px}
.bar{background:linear-gradient(180deg,#c4923a,#e8b060);border-radius:3px 3px 0 0;width:100%;min-height:2px}
.blbl{font-size:9px;color:#9b8c84;text-align:center}
.sdot{width:8px;height:8px;border-radius:50%;background:#16a34a;display:inline-block;margin-right:4px}
.rtime{font-size:11px;color:#9b8c84;text-align:center;margin-top:8px}
.expbtn{font-size:12px;padding:7px 14px;background:#1a1612;color:white;border:none;border-radius:7px;cursor:pointer;font-family:inherit}
.badge{display:inline-block;font-size:10px;padding:2px 8px;border-radius:100px;background:#f0d9a8;color:#7a5a1a}
table{width:100%;border-collapse:collapse}
th{font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#9b8c84;padding:10px 14px;text-align:left;border-bottom:1px solid #ebe2d5;background:#f9f6f1}
td{padding:10px 14px;font-size:13px;border-bottom:1px solid #f3ede4;color:#3d3530}
tr:last-child td{border:none}
.alog-item{padding:10px 0;border-bottom:1px solid #f3ede4}
.alog-item:last-child{border:none}
.alog-action{font-size:13px;font-weight:500;color:#1a1612}
.alog-detail{font-size:12px;color:#9b8c84;margin-top:2px}
.alog-time{font-size:11px;color:#9b8c84}
.alog-status{font-size:10px;padding:2px 8px;border-radius:100px;float:right}
.alog-status.success{background:#f0fdf4;color:#166534}
.alog-status.error{background:#fef2f2;color:#dc2626}
.briefing-box{background:#0a1628;border-radius:10px;padding:16px;font-size:13px;color:#f0d9a8;line-height:1.9;white-space:pre-wrap;margin-top:8px}
.agent-online{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#16a34a;font-weight:500}
.agent-dot{width:8px;height:8px;border-radius:50%;background:#16a34a;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
</style>
</head>
<body>
<div class="login" id="cc-login">
  <div class="lcard">
    <div class="brand"><div class="bicon">A</div><div class="bname">ARIA</div></div>
    <div style="text-align:center;margin-bottom:22px">
      <div style="font-size:15px;font-weight:500;margin-bottom:4px">Command Center</div>
      <div style="font-size:12px;color:#9b8c84">Unified project dashboard</div>
    </div>
    <div class="err" id="cc-err">Incorrect password.</div>
    <div class="lbl">Password</div>
    <input class="field" type="password" id="cc-pw" placeholder="••••••••" onkeydown="if(event.key==='Enter')ccLogin()">
    <button class="btn" onclick="ccLogin()">Access Command Center</button>
  </div>
</div>
<div class="dash" id="cc-dash">
  <div class="topnav">
    <div class="tnleft">
      <div class="tnicon">A</div>
      <div>
        <div class="tntitle">ARIA Command Center</div>
        <div class="tnsub"><span class="sdot"></span>Live</div>
      </div>
    </div>
    <button class="signout" onclick="ccLogout()">Sign Out</button>
  </div>
  <div class="tabs">
    <button class="tab-btn active" onclick="ccTab('overview')">Overview</button>
    <button class="tab-btn" onclick="ccTab('agent')">Agent</button>
    <button class="tab-btn" onclick="ccTab('members')">Members</button>
    <button class="tab-btn" onclick="ccTab('visitors')">Visitors</button>
    <button class="tab-btn" onclick="ccTab('ai')">AI Tools</button>
    <button class="tab-btn" onclick="ccTab('errors')">Errors</button>
  </div>

  <!-- OVERVIEW -->
  <div class="tab-content active" id="cc-overview">
    <div class="sgrid">
      <div class="stat"><div class="sval" id="cc-total">0</div><div class="slbl">Total Users</div></div>
      <div class="stat"><div class="sval" id="cc-today">0</div><div class="slbl">Today</div></div>
      <div class="stat"><div class="sval" id="cc-week">0</div><div class="slbl">This Week</div></div>
      <div class="stat"><div class="sval" id="cc-uptime">0h</div><div class="slbl">Uptime</div></div>
    </div>
    <div class="g2">
      <div class="panel"><div class="ptitle">Growth (7 days)</div><div class="psub">Daily signups</div><div class="chart" id="cc-chart"></div></div>
      <div class="panel"><div class="ptitle">Recent Signups</div><div class="psub">Latest 5 members</div><div id="cc-recent"></div></div>
    </div>
  </div>

  <!-- AGENT -->
  <div class="tab-content" id="cc-agent">
    <div class="sgrid">
      <div class="stat"><div class="sval" id="cc-atotal">0</div><div class="slbl">Total Actions</div></div>
      <div class="stat"><div class="sval" id="cc-atoday">0</div><div class="slbl">Today</div></div>
      <div class="stat"><div class="sval" id="cc-astatus" style="font-size:14px;margin-top:4px">—</div><div class="slbl">Last Action</div></div>
    </div>
    <div class="panel">
      <div class="ptitle">Daily Briefing</div>
      <div class="psub">Latest private report from your agent</div>
      <div id="cc-briefing"><div class="empty">No briefing yet — agent runs daily at 9 AM UTC</div></div>
    </div>
    <div class="panel">
      <div class="ptitle">Agent Activity Log</div>
      <div class="psub">Every action your agent has taken — private to you</div>
      <div id="cc-alog"><div class="empty">No activity yet</div></div>
    </div>
  </div>

  <!-- MEMBERS -->
  <div class="tab-content" id="cc-agent">
    <div class="sgrid" style="margin-bottom:16px">
      <div class="stat"><div class="sval" id="cc-agent-total">0</div><div class="slbl">Total Actions</div></div>
      <div class="stat"><div class="sval" id="cc-agent-status" style="font-size:14px;color:#16a34a">Active</div><div class="slbl">Agent Status</div></div>
    </div>
    <div class="panel">
      <div class="ptitle">Agent Activity Log</div>
      <div class="psub">Every action your autonomous agent has taken</div>
      <div id="cc-agent-feed"><div class="empty">No agent activity yet — agent runs daily at 9 AM UTC</div></div>
    </div>
    <div class="panel">
      <div class="ptitle">Daily Briefing</div>
      <div class="psub">Latest report from your agent</div>
      <div id="cc-agent-briefing"><div class="empty">Briefing will appear here after the agent's next run</div></div>
    </div>
  </div>
  <div class="tab-content" id="cc-members">
    <div class="panel">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div><div class="ptitle">All Members</div><div class="psub">Complete list</div></div>
        <button class="expbtn" onclick="ccExport()">Export CSV</button>
      </div>
      <table><thead><tr><th>#</th><th>Name</th><th>Email</th><th>Joined</th></tr></thead><tbody id="cc-table"></tbody></table>
    </div>
  </div>

  <!-- VISITORS -->
  <div class="tab-content" id="cc-visitors">
    <div class="sgrid">
      <div class="stat"><div class="sval" id="cc-vtotal">0</div><div class="slbl">Total Visits</div></div>
      <div class="stat"><div class="sval" id="cc-vtoday">0</div><div class="slbl">Today</div></div>
      <div class="stat"><div class="sval" id="cc-vweek">0</div><div class="slbl">This Week</div></div>
    </div>
    <div class="panel" style="margin-top:16px">
      <div class="ptitle">Traffic Sources</div>
      <div class="psub">Where visitors are coming from</div>
      <div id="cc-sources"></div>
    </div>
    <div class="panel">
      <div class="ptitle">Recent Visits</div>
      <div class="psub">Last 5 landing page visitors</div>
      <div id="cc-vrecent"></div>
    </div>
  </div>

  <!-- AI TOOLS -->
  <div class="tab-content" id="cc-ai">
    <div class="g2">
      <div class="panel"><div class="ptitle">Feature Suggestions</div><div class="psub">AI product advice</div><button class="abtn" id="featBtn" onclick="ccAI('features','featBtn','featOut','featCopy')">Generate</button><div class="aout" id="featOut"></div><button class="cbtn" id="featCopy" onclick="ccCopy('featOut','featCopy')">Copy</button></div>
      <div class="panel"><div class="ptitle">Newsletter Draft</div><div class="psub">Ready for Substack</div><button class="abtn" id="newsBtn" onclick="ccAI('newsletter','newsBtn','newsOut','newsCopy')">Draft</button><div class="aout" id="newsOut"></div><button class="cbtn" id="newsCopy" onclick="ccCopy('newsOut','newsCopy')">Copy</button></div>
    </div>
    <div class="g2">
      <div class="panel"><div class="ptitle">Reddit Post</div><div class="psub">Ready for r/SideProject</div><button class="abtn" id="redditBtn" onclick="ccAI('reddit','redditBtn','redditOut','redditCopy')">Draft</button><div class="aout" id="redditOut"></div><button class="cbtn" id="redditCopy" onclick="ccCopy('redditOut','redditCopy')">Copy</button></div>
      <div class="panel"><div class="ptitle">Discord Content</div><div class="psub">Welcome + announcements</div><button class="abtn" id="discordBtn" onclick="ccAI('discord','discordBtn','discordOut','discordCopy')">Generate</button><div class="aout" id="discordOut"></div><button class="cbtn" id="discordCopy" onclick="ccCopy('discordOut','discordCopy')">Copy</button><button class="dbtn" id="discordPostGeneral" onclick="ccDiscord('general','discordOut','discordPostGeneral')">Post to #general</button><button class="dbtn" id="discordPostUpdates" onclick="ccDiscord('aria-updates','discordOut','discordPostUpdates')" style="margin-left:6px">Post to #aria-updates</button></div>
    </div>
    <div class="panel"><div class="ptitle">Shareholder Report</div><div class="psub">Weekly summary</div><button class="abtn" id="shareBtn" onclick="ccAI('shareholder','shareBtn','shareOut','shareCopy')">Generate</button><div class="aout" id="shareOut"></div><button class="cbtn" id="shareCopy" onclick="ccCopy('shareOut','shareCopy')">Copy</button></div>
  </div>

  <!-- ERRORS -->
  <div class="tab-content" id="cc-errors">
    <div class="panel"><div class="ptitle">Error Monitor</div><div class="psub">Last 10 server errors</div><div id="cc-errors-feed"></div></div>
  </div>

  <div class="rtime" id="cc-refresh">Loading...</div>
</div>
<script>
const DISCORD_CHANNELS={'general':'1483261401664458972','aria-updates':'1483261092062040184','getting-started':'1483262143426990282'};
let ccToken='';
function ccLogin(){
  const pw=document.getElementById('cc-pw').value;
  if(!pw)return;
  ccToken=pw;
  document.getElementById('cc-err').style.display='none';
  fetch('/api/command/stats?token='+encodeURIComponent(pw))
    .then(r=>{
      if(r.status===401){document.getElementById('cc-err').style.display='block';ccToken='';return;}
      document.getElementById('cc-login').style.display='none';
      document.getElementById('cc-dash').style.display='block';
      ccLoad();
    })
    .catch(()=>{document.getElementById('cc-err').textContent='Connection error.';document.getElementById('cc-err').style.display='block';ccToken='';});
}
function ccLogout(){ccToken='';document.getElementById('cc-login').style.display='flex';document.getElementById('cc-dash').style.display='none';document.getElementById('cc-pw').value='';}
function ccTab(name){
  document.querySelectorAll('.tab-btn').forEach((b,i)=>b.classList.toggle('active',['overview','agent','members','visitors','ai','errors'][i]===name));
  document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
  document.getElementById('cc-'+name).classList.add('active');
  if(name==='visitors') ccLoadVisitors();
  if(name==='agent') ccLoadAgent();
}
async function ccLoadAgent(){
  try{
    const res=await fetch('/api/agent/log?token='+encodeURIComponent(ccToken));
    const d=await res.json();
    document.getElementById('cc-agent-total').textContent=d.total;
    const feed=document.getElementById('cc-agent-feed');
    if(!d.log||d.log.length===0){
      feed.innerHTML='<div class="empty">No agent activity yet — agent runs daily at 9 AM UTC</div>';
    }else{
      feed.innerHTML=d.log.map(e=>'<div class="sitem"><div><div class="sname">'+e.action+'</div><div class="semail">'+e.details+'</div></div><div style="text-align:right"><div class="stime">'+new Date(e.ts).toLocaleTimeString()+'</div><div style="font-size:10px;color:'+(e.status==='completed'?'#16a34a':'#dc2626')+';margin-top:2px">'+e.status+'</div></div></div>').join('');
      const briefing=d.log.find(e=>e.action==='Daily Briefing');
      if(briefing){
        document.getElementById('cc-agent-briefing').innerHTML='<div style="font-size:13px;line-height:1.8;white-space:pre-wrap">'+briefing.details+'</div><div class="stime" style="margin-top:8px">Generated: '+new Date(briefing.ts).toLocaleString()+'</div>';
      }
    }
  }catch(e){console.error(e);}
}
async function ccLoad(){
  try{
    const res=await fetch('/api/command/stats?token='+encodeURIComponent(ccToken));
    if(res.status===401){document.getElementById('cc-err').style.display='block';ccLogout();return;}
    const d=await res.json();
    document.getElementById('cc-total').textContent=d.total;
    document.getElementById('cc-today').textContent=d.today;
    document.getElementById('cc-week').textContent=d.week;
    document.getElementById('cc-uptime').textContent=Math.floor(d.uptime/3600)+'h';
    const max=Math.max(...d.dailyCounts.map(x=>x.count),1);
    document.getElementById('cc-chart').innerHTML=d.dailyCounts.map(day=>'<div class="bwrap"><div class="bar" style="height:'+Math.max((day.count/max)*70,2)+'px"></div><div class="blbl">'+day.label.split(' ')[1]+'</div></div>').join('');
    document.getElementById('cc-recent').innerHTML=d.recentSignups.length===0?'<div class="empty">No signups yet</div>':d.recentSignups.map(s=>'<div class="sitem"><div><div class="sname">'+s.name+'</div><div class="semail">'+s.email+'</div></div><div class="stime">'+new Date(s.joined).toLocaleDateString('en-US',{month:'short',day:'numeric'})+'</div></div>').join('');
    document.getElementById('cc-table').innerHTML=d.allSignups.length===0?'<tr><td colspan="4" style="text-align:center;padding:30px;color:#9b8c84">No members yet</td></tr>':d.allSignups.map((s,i)=>'<tr><td><span class="badge">'+(d.total-i)+'</span></td><td>'+s.name+'</td><td style="color:#c4923a">'+s.email+'</td><td>'+new Date(s.joined).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})+'</td></tr>').join('');
    document.getElementById('cc-errors-feed').innerHTML=d.errors.length===0?'<div class="empty" style="color:#16a34a">No errors detected</div>':d.errors.map(e=>'<div class="eitem"><span class="etime">'+new Date(e.ts).toLocaleTimeString()+'</span>'+e.msg.substring(0,120)+'</div>').join('');
    document.getElementById('cc-refresh').textContent='Last updated: '+new Date().toLocaleTimeString();
  }catch(e){console.error(e);}
}
async function ccLoadAgent(){
  try{
    const res=await fetch('/api/agent/stats?token='+encodeURIComponent(ccToken));
    const d=await res.json();
    document.getElementById('cc-atotal').textContent=d.total;
    document.getElementById('cc-atoday').textContent=d.today;
    document.getElementById('cc-astatus').textContent=d.status;
    if(d.briefing){
      document.getElementById('cc-briefing').innerHTML='<div class="briefing-box">'+d.briefing.content+'</div><div style="font-size:11px;color:#9b8c84;margin-top:6px">Received: '+new Date(d.briefing.ts).toLocaleString()+'</div>';
    }
    document.getElementById('cc-alog').innerHTML=d.log.length===0?'<div class="empty">No activity yet — agent runs daily at 9 AM UTC</div>':d.log.map(a=>'<div class="alog-item"><div style="display:flex;justify-content:space-between;align-items:flex-start"><div><div class="alog-action">'+a.action+'</div><div class="alog-detail">'+a.details+'</div></div><div><span class="alog-status '+a.status+'">'+a.status+'</span></div></div><div class="alog-time">'+new Date(a.ts).toLocaleString()+'</div></div>').join('');
  }catch(e){console.error(e);}
}
async function ccLoadVisitors(){
  try{
    const res=await fetch('/api/command/visitors?token='+encodeURIComponent(ccToken));
    const d=await res.json();
    document.getElementById('cc-vtotal').textContent=d.total;
    document.getElementById('cc-vtoday').textContent=d.today;
    document.getElementById('cc-vweek').textContent=d.week;
    const entries=Object.entries(d.sources||{}).sort((a,b)=>b[1]-a[1]);
    document.getElementById('cc-sources').innerHTML=entries.length===0?'<div class="empty">No data yet</div>':entries.map(([src,cnt])=>'<div class="sitem"><div class="sname">'+src+'</div><div class="stime">'+cnt+' visits</div></div>').join('');
    document.getElementById('cc-vrecent').innerHTML=d.recent.length===0?'<div class="empty">No visits yet</div>':d.recent.map(v=>'<div class="sitem"><div><div class="sname">'+(v.ref?v.ref.substring(0,40):'Direct visit')+'</div></div><div class="stime">'+new Date(v.ts).toLocaleTimeString()+'</div></div>').join('');
  }catch(e){console.error(e);}
}
async function ccAI(type,btnId,outId,copyId){
  const btn=document.getElementById(btnId);
  btn.disabled=true;btn.textContent='Generating...';
  try{
    const res=await fetch('/api/command/ai?token='+encodeURIComponent(ccToken),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type})});
    const data=await res.json();
    document.getElementById(outId).textContent=data.content||data.error;
    document.getElementById(outId).style.display='block';
    document.getElementById(copyId).style.display='inline-block';
    if(type==='discord'){document.getElementById('discordPostGeneral').style.display='inline-block';document.getElementById('discordPostUpdates').style.display='inline-block';}
  }catch(e){document.getElementById(outId).textContent='Failed.';document.getElementById(outId).style.display='block';}
  btn.disabled=false;btn.textContent=type==='newsletter'?'Redraft':'Regenerate';
}
function ccCopy(outId,btnId){
  navigator.clipboard.writeText(document.getElementById(outId).textContent);
  const btn=document.getElementById(btnId);btn.textContent='Copied!';btn.classList.add('ok');
  setTimeout(()=>{btn.textContent='Copy';btn.classList.remove('ok');},2000);
}
async function ccDiscord(channel,outId,btnId){
  const btn=document.getElementById(btnId);
  const content=document.getElementById(outId).textContent;
  if(!content){alert('Generate content first');return;}
  btn.disabled=true;btn.textContent='Posting...';
  try{
    const res=await fetch('/api/discord/post?token='+encodeURIComponent(ccToken),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channelId:DISCORD_CHANNELS[channel],content})});
    const data=await res.json();
    if(data.ok){btn.textContent='Posted!';btn.style.background='#16a34a';}
    else{btn.textContent='Failed';alert(data.error||'Post failed');}
  }catch(e){btn.textContent='Error';}
  btn.disabled=false;
  setTimeout(()=>{btn.textContent=channel==='general'?'Post to #general':'Post to #aria-updates';btn.style.background='';},3000);
}
function ccExport(){window.open('/api/admin/export?token='+encodeURIComponent(ccToken),'_blank');}
async function ccLoadAgent(){}
setInterval(()=>{if(ccToken)ccLoad();},60000);
</script>
</body></html>`));

/* ── Deploy Panel ── */
app.get('/deploy-panel', (_req, res) => res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ARIA Deploy Panel</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Geist',sans-serif;background:#f9f6f1;color:#1a1612;min-height:100vh}
.login{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.lcard{background:white;border-radius:16px;padding:32px 24px;width:100%;max-width:360px;box-shadow:0 8px 32px rgba(0,0,0,.1)}
.brand{display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:28px}
.bicon{width:36px;height:36px;background:linear-gradient(135deg,#c4923a,#e8b060);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;color:#1a1612}
.bname{font-size:20px;font-weight:300;letter-spacing:3px;text-transform:uppercase}
.lbl{font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#6b5e56;margin-bottom:6px}
.field{width:100%;padding:12px 14px;border:1.5px solid #ebe2d5;border-radius:8px;font-family:inherit;font-size:14px;outline:none;margin-bottom:14px;background:#f9f6f1;-webkit-appearance:none}
.field:focus{border-color:#c4923a;background:white}
.btn{width:100%;padding:13px;background:#1a1612;color:white;border:none;border-radius:8px;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:10px}
.btn:active{background:#c4923a}
.btn-sec{width:100%;padding:11px;background:transparent;color:#6b5e56;border:1.5px solid #ebe2d5;border-radius:8px;font-family:inherit;font-size:13px;cursor:pointer}
.err{font-size:12px;color:#dc2626;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:9px 12px;margin-bottom:12px;display:none}
.dash{display:none;padding:20px;max-width:600px;margin:0 auto}
.nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;padding:14px 0;border-bottom:1px solid #ebe2d5}
.nleft{display:flex;align-items:center;gap:8px}
.nicon{width:28px;height:28px;background:linear-gradient(135deg,#c4923a,#e8b060);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;color:#1a1612}
.ntitle{font-size:16px;font-weight:500}.nsub{font-size:12px;color:#9b8c84}
.logout{font-size:12px;color:#9b8c84;background:none;border:1px solid #ebe2d5;border-radius:6px;padding:6px 12px;cursor:pointer;font-family:inherit}
.section{background:white;border:1px solid #ebe2d5;border-radius:12px;padding:20px;margin-bottom:16px}
.stitle{font-size:13px;font-weight:600;margin-bottom:4px}.ssub{font-size:12px;color:#9b8c84;margin-bottom:16px}
.frow{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f3ede4}.frow:last-child{border:none}
.fname{font-size:13px;color:#3d3530;font-family:monospace}
.fstat{font-size:11px;padding:3px 9px;border-radius:100px;background:#f0d9a8;color:#7a5a1a}
.fstat.ok{background:#f0fdf4;color:#166534}.fstat.err{background:#fef2f2;color:#dc2626}
.dbtn{width:100%;padding:14px;background:#1a1612;color:white;border:none;border-radius:10px;font-family:inherit;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:10px}
.dbtn:active{background:#c4923a}.dbtn:disabled{background:#9b8c84;cursor:not-allowed}
.sbar{padding:11px 14px;border-radius:8px;font-size:13px;display:none;margin-bottom:12px}
.sbar.ok{background:#f0fdf4;border:1px solid #86efac;color:#166534}
.sbar.err{background:#fef2f2;border:1px solid #fecaca;color:#dc2626}
.sbar.loading{background:#f0d9a8;border:1px solid #c4923a;color:#7a5a1a}
.log{background:#1a1612;border-radius:10px;padding:14px;display:none;margin-top:12px;max-height:220px;overflow-y:auto}
.log-lbl{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:#9b8c84;margin-bottom:8px}
.logline{font-size:12px;color:#f0d9a8;font-family:monospace;line-height:1.9}
.logline.ok{color:#86efac}.logline.err{color:#fca5a5}
.hdot{width:8px;height:8px;border-radius:50%;background:#9b8c84;display:inline-block;margin-right:6px}
.hdot.live{background:#16a34a}
</style>
</head>
<body>
<div class="login" id="dp-login">
  <div class="lcard">
    <div class="brand"><div class="bicon">A</div><div class="bname">ARIA</div></div>
    <div style="text-align:center;margin-bottom:22px">
      <div style="font-size:15px;font-weight:500;margin-bottom:4px">Deploy Panel</div>
      <div style="font-size:12px;color:#9b8c84">Enter your deploy password</div>
    </div>
    <div class="err" id="dp-err">Incorrect password.</div>
    <div class="lbl">Password</div>
    <input class="field" type="password" id="dp-pw" placeholder="••••••••" onkeydown="if(event.key==='Enter')dpLogin()">
    <button class="btn" onclick="dpLogin()">Access Deploy Panel</button>
  </div>
</div>
<div class="dash" id="dp-dash">
  <div class="nav">
    <div class="nleft">
      <div class="nicon">A</div>
      <div><div class="ntitle">Deploy Panel</div><div class="nsub"><span class="hdot" id="dp-hdot"></span><span id="dp-htext">Checking...</span></div></div>
    </div>
    <button class="logout" onclick="dpLogout()">Sign Out</button>
  </div>
  <div class="section">
    <div class="stitle">Files Queued for Deploy</div>
    <div class="ssub">All 3 files pushed to GitHub. Render redeploys automatically.</div>
    <div class="frow"><span class="fname">public/index.html</span><span class="fstat" id="dp-st-index">Ready</span></div>
    <div class="frow"><span class="fname">public/sw.js</span><span class="fstat" id="dp-st-sw">Ready</span></div>
    <div class="frow"><span class="fname">server.js</span><span class="fstat" id="dp-st-server">Ready</span></div>
  </div>
  <div class="sbar" id="dp-sbar"></div>
  <button class="dbtn" id="dp-btn" onclick="dpDeployAll()">🚀 Deploy All Files</button>
  <button class="btn-sec" onclick="dpHealth()">Check Server Health</button>
  <div class="log" id="dp-log"><div class="log-lbl">Deploy Log</div><div id="dp-lines"></div></div>
</div>
<script>
let dpSecret='';
function dpLogin(){const pw=document.getElementById('dp-pw').value;if(!pw)return;dpSecret=pw;dpHealth();document.getElementById('dp-err').style.display='none';document.getElementById('dp-login').style.display='none';document.getElementById('dp-dash').style.display='block';}
function dpLogout(){dpSecret='';document.getElementById('dp-login').style.display='flex';document.getElementById('dp-dash').style.display='none';document.getElementById('dp-pw').value='';}
async function dpHealth(){try{const r=await fetch('/health');const d=await r.json();if(d.status==='ok'){document.getElementById('dp-hdot').className='hdot live';document.getElementById('dp-htext').textContent='Server live';dpStatus('Server is healthy!','ok');}}catch(e){document.getElementById('dp-htext').textContent='Server sleeping';dpStatus('Server sleeping — open the app first.','err');}}
function dpStatus(msg,type){const s=document.getElementById('dp-sbar');s.textContent=msg;s.className='sbar '+type;s.style.display='block';}
function dpLog(msg,type=''){const log=document.getElementById('dp-log');log.style.display='block';const line=document.createElement('div');line.className='logline '+type;line.textContent=new Date().toLocaleTimeString()+'  '+msg;document.getElementById('dp-lines').appendChild(line);log.scrollTop=log.scrollHeight;}
function dpSetStat(id,text,type){const el=document.getElementById('dp-st-'+id);if(el){el.textContent=text;el.className='fstat '+type;}}
async function dpDeployAll(){
  const btn=document.getElementById('dp-btn');
  btn.disabled=true;btn.textContent='Deploying...';
  document.getElementById('dp-lines').innerHTML='';
  document.getElementById('dp-log').style.display='none';
  dpStatus('Starting deploy...','loading');
  dpLog('Deploy started');
  const files=[{id:'index',filename:'public/index.html'},{id:'sw',filename:'public/sw.js'},{id:'server',filename:'server.js'}];
  let allOk=true;
  for(const f of files){
    dpSetStat(f.id,'Deploying...','');
    dpLog('Pushing '+f.filename+'...');
    try{
      const res=await fetch('/api/deploy-latest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:dpSecret,filename:f.filename})});
      const data=await res.json().catch(()=>({ok:res.ok}));
      if(data.ok||res.ok){dpSetStat(f.id,'Deployed','ok');dpLog(f.filename+' pushed','ok');}
      else{dpSetStat(f.id,'Failed','err');dpLog(f.filename+': '+(data.error||'failed'),'err');allOk=false;}
    }catch(e){dpSetStat(f.id,'Error','err');dpLog('Error: '+e.message,'err');allOk=false;}
    await new Promise(r=>setTimeout(r,2000));
  }
  if(allOk){dpStatus('All files deployed! Live in ~60 seconds.','ok');dpLog('Deploy complete.','ok');btn.textContent='Done!';setTimeout(()=>{btn.disabled=false;btn.textContent='Deploy All Files';},5000);}
  else{dpStatus('Some files failed — check log.','err');btn.disabled=false;btn.textContent='Deploy All Files';}
}
dpHealth();
</script>
</body></html>`));

/* ── Claude proxy ── */
app.post('/api/chat', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (rateLimit(ip)) return res.status(429).json({ error: 'Too many requests.' });
  const { messages, system, userEmail, isPro } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'messages array is required.' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Add ANTHROPIC_API_KEY in Render environment variables.' });
  const model = getModel(userEmail, isPro);
  console.log(`CHAT [${model.includes('sonnet')?'Pro':'Free'}] ${userEmail||'anon'}`);
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1024, system: system || '', messages })
    });
    const data = await upstream.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ ...data, tier: model.includes('sonnet') ? 'Pro' : 'Free' });
  } catch(err) {
    console.error('[proxy] failed to reach Anthropic');
    res.status(502).json({ error: 'Could not reach AI. Please try again.' });
  }
});

/* ── SPA fallback ── */
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () =>
  console.log(`ARIA running on port ${PORT} [${PROD ? 'production' : 'dev'}]`)
);
