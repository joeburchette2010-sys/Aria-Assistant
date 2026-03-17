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
const signups  = [];
const errorLog = [];

/* ── Intercept errors for monitoring ── */
const _origErr = console.error;
console.error = (...args) => {
  errorLog.push({ ts: new Date().toISOString(), msg: args.join(' ') });
  if (errorLog.length > 100) errorLog.shift();
  _origErr(...args);
};

/* ── Health check ── */
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

/* ── Admin auth middleware ── */
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const adminPassword = process.env.ADMIN_PASSWORD || 'aria-admin-2025';
  if (token !== adminPassword) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/* ── Signup logging + Google Sheets webhook ── */
app.post('/api/signup', async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Missing fields' });
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  signups.push({ name, email, joined: new Date().toISOString(), ts });
  console.log(`NEW SIGNUP — Name: ${name} | Email: ${email} | Time: ${ts}`);

  // Google Sheets webhook (set SHEETS_WEBHOOK in Render env vars)
  const webhook = process.env.SHEETS_WEBHOOK;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, joined: new Date().toISOString(), ts, total: signups.length })
      });
    } catch (e) {
      console.error('Sheets webhook failed:', e.message);
    }
  }
  res.json({ ok: true });
});

/* ── Admin API: signups ── */
app.get('/api/admin/signups', adminAuth, (req, res) => {
  res.json({ total: signups.length, signups: signups.slice().reverse() });
});

/* ── Admin API: CSV export ── */
app.get('/api/admin/export', adminAuth, (req, res) => {
  const csv = ['Name,Email,Joined'].concat(
    signups.map(s => `"${s.name}","${s.email}","${s.ts}"`)
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="aria-users.csv"');
  res.send(csv);
});

/* ── Command Center: stats ── */
app.get('/api/command/stats', adminAuth, (req, res) => {
  const now = new Date();
  const oneDayAgo  = new Date(now - 24 * 60 * 60 * 1000);
  const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const dailyCounts = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(now - i * 24 * 60 * 60 * 1000);
    const dayStr = day.toDateString();
    dailyCounts.push({
      label: day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      count: signups.filter(s => new Date(s.joined).toDateString() === dayStr).length
    });
  }
  res.json({
    total:         signups.length,
    today:         signups.filter(s => new Date(s.joined) > oneDayAgo).length,
    week:          signups.filter(s => new Date(s.joined) > oneWeekAgo).length,
    recentSignups: signups.slice(-5).reverse(),
    allSignups:    signups.slice().reverse(),
    dailyCounts,
    errors:        errorLog.slice(-10).reverse(),
    uptime:        process.uptime(),
    serverTime:    now.toISOString()
  });
});

/* ── Command Center: AI insights ── */
app.post('/api/command/ai', adminAuth, async (req, res) => {
  const { type } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  const stats = {
    totalUsers:    signups.length,
    recentSignups: signups.slice(-5).map(s => s.name),
    recentErrors:  errorLog.slice(-3).map(e => e.msg)
  };
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
  } catch (err) {
    res.status(502).json({ error: 'AI request failed' });
  }
});

/* ── Discord Bot: post message to channel ── */
app.post('/api/discord/post', adminAuth, async (req, res) => {
  const { channelId, content } = req.body;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return res.status(500).json({ error: 'DISCORD_BOT_TOKEN not set' });
  if (!channelId || !content) return res.status(400).json({ error: 'Missing channelId or content' });
  try {
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.substring(0, 2000) })
    });
    const data = await r.json();
    if (data.id) {
      console.log(`DISCORD POST: channel ${channelId}`);
      res.json({ ok: true, messageId: data.id });
    } else {
      res.status(500).json({ error: data.message || 'Discord post failed' });
    }
  } catch (err) {
    res.status(502).json({ error: 'Discord post failed: ' + err.message });
  }
});


app.post('/api/deploy', async (req, res) => {
  const { secret, filename, content } = req.body;
  const deploySecret = process.env.DEPLOY_SECRET || 'aria-deploy-2025';
  if (secret !== deploySecret) return res.status(401).json({ error: 'Invalid deploy secret' });
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO;
  const email = process.env.GITHUB_EMAIL;
  if (!token || !repo) return res.status(500).json({ error: 'GitHub env vars not set' });
  try {
    const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${filename}`, {
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    const fileData = await getRes.json();
    const sha = fileData.sha;
    const pushRes = await fetch(`https://api.github.com/repos/${repo}/contents/${filename}`, {
      method: 'PUT',
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Auto-deploy: update ${filename}`,
        content: Buffer.from(content).toString('base64'),
        sha,
        committer: { name: 'ARIA Deploy Bot', email: email || 'deploy@aria.app' }
      })
    });
    const result = await pushRes.json();
    if (result.content) { console.log(`DEPLOYED: ${filename}`); res.json({ ok: true }); }
    else res.status(500).json({ error: result.message || 'Deploy failed' });
  } catch (err) {
    res.status(502).json({ error: 'Deploy failed: ' + err.message });
  }
});

/* ── Deploy-latest endpoint — fetches from GitHub and re-pushes ── */
app.post('/api/deploy-latest', async (req, res) => {
  const { secret, filename } = req.body;
  const deploySecret = process.env.DEPLOY_SECRET || 'aria-deploy-2025';
  if (secret !== deploySecret) return res.status(401).json({ error: 'Invalid deploy secret' });
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO;
  const email = process.env.GITHUB_EMAIL;
  if (!token || !repo) return res.status(500).json({ error: 'GitHub env vars not set' });
  try {
    const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${filename}`, {
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    const fileData = await getRes.json();
    if (!fileData.sha) return res.status(404).json({ error: 'File not found in GitHub: ' + filename });
    const sha = fileData.sha;
    // Decode content — strip newlines added by GitHub base64 encoding
    const currentContent = Buffer.from(fileData.content.replace(/\n/g,''), 'base64').toString('utf8');
    // Add timestamp to commit message to force unique commit
    const ts = new Date().toISOString().replace('T',' ').substring(0,19);
    const pushRes = await fetch(`https://api.github.com/repos/${repo}/contents/${filename}`, {
      method: 'PUT',
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Auto-deploy: ${filename} [${ts}]`,
        content: Buffer.from(currentContent).toString('base64'),
        sha,
        committer: { name: 'ARIA Deploy Bot', email: email || 'deploy@aria.app' }
      })
    });
    const result = await pushRes.json();
    // 422 = nothing changed, treat as success
    if (result.content || pushRes.status === 422) {
      console.log(`DEPLOYED: ${filename}`);
      res.json({ ok: true, message: `${filename} deployed` });
    } else {
      res.status(500).json({ error: result.message || 'Deploy failed' });
    }
  } catch (err) {
    res.status(502).json({ error: 'Deploy failed: ' + err.message });
  }
});

/* ── UNIFIED DASHBOARD (Admin + Command Center combined) ── */
app.get('/admin', (_req, res) => { res.redirect('/command'); });

app.get('/command', (_req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ARIA Command Center</title><link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&display=swap" rel="stylesheet"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Geist',sans-serif;background:#f9f6f1;color:#1a1612;min-height:100vh}.login{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.login-card{background:white;border-radius:16px;padding:32px 24px;width:100%;max-width:360px;box-shadow:0 8px 32px rgba(0,0,0,0.1)}.brand{display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:28px}.brand-icon{width:36px;height:36px;background:linear-gradient(135deg,#c4923a,#e8b060);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;color:#1a1612}.brand-name{font-size:20px;font-weight:300;letter-spacing:3px;text-transform:uppercase}.label{font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#6b5e56;margin-bottom:6px}.field{width:100%;padding:12px 14px;border:1.5px solid #ebe2d5;border-radius:8px;font-family:inherit;font-size:14px;outline:none;margin-bottom:14px;background:#f9f6f1;-webkit-appearance:none}.field:focus{border-color:#c4923a;background:white}.btn{width:100%;padding:13px;background:#1a1612;color:white;border:none;border-radius:8px;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer}.btn:active{background:#c4923a}.err{font-size:12px;color:#dc2626;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:9px 12px;margin-bottom:12px;display:none}.dash{display:none;padding:20px;max-width:1000px;margin:0 auto}.topnav{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;padding:14px 0;border-bottom:1px solid #ebe2d5}.topnav-left{display:flex;align-items:center;gap:8px}.topnav-icon{width:28px;height:28px;background:linear-gradient(135deg,#c4923a,#e8b060);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;color:#1a1612}.topnav-title{font-size:16px;font-weight:500}.topnav-sub{font-size:12px;color:#9b8c84}.signout{font-size:12px;color:#9b8c84;background:none;border:1px solid #ebe2d5;border-radius:6px;padding:6px 12px;cursor:pointer;font-family:inherit}.tabs{display:flex;gap:8px;margin-bottom:20px}.tab-btn{padding:8px 16px;border-radius:100px;border:1.5px solid #ebe2d5;background:#f9f6f1;font-family:inherit;font-size:12px;font-weight:500;color:#9b8c84;cursor:pointer}.tab-btn.active{background:#1a1612;color:white;border-color:#1a1612}.tab-content{display:none}.tab-content.active{display:block}.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px}.stat{background:white;border:1px solid #ebe2d5;border-radius:12px;padding:16px;text-align:center}.stat-val{font-size:28px;font-weight:600;color:#c4923a;font-family:Georgia,serif}.stat-lbl{font-size:11px;color:#9b8c84;text-transform:uppercase;letter-spacing:1px;margin-top:4px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}@media(max-width:600px){.grid2{grid-template-columns:1fr}}.panel{background:white;border:1px solid #ebe2d5;border-radius:12px;padding:18px;margin-bottom:16px}.panel-title{font-size:13px;font-weight:600;color:#1a1612;margin-bottom:4px}.panel-sub{font-size:11px;color:#9b8c84;margin-bottom:14px}.ai-btn{padding:9px 16px;background:#1a1612;color:white;border:none;border-radius:7px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;margin-bottom:12px}.ai-btn:active{background:#c4923a}.ai-btn:disabled{background:#9b8c84;cursor:not-allowed}.ai-output{background:#f9f6f1;border:1px solid #ebe2d5;border-radius:8px;padding:12px;font-size:13px;line-height:1.7;color:#3d3530;white-space:pre-wrap;min-height:60px;display:none}.copy-btn{font-size:11px;padding:4px 10px;background:white;border:1px solid #ebe2d5;border-radius:5px;cursor:pointer;font-family:inherit;margin-top:8px;display:none}.copy-btn.ok{background:#f0fdf4;border-color:#86efac;color:#166534}.error-item{padding:8px 0;border-bottom:1px solid #f3ede4;font-size:12px;color:#dc2626;font-family:monospace;line-height:1.5}.error-item:last-child{border:none}.error-time{font-size:10px;color:#9b8c84;display:block;margin-bottom:2px;font-family:inherit}.signup-item{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f3ede4}.signup-item:last-child{border:none}.signup-name{font-size:13px;font-weight:500;color:#1a1612}.signup-email{font-size:12px;color:#c4923a}.signup-time{font-size:11px;color:#9b8c84}.empty-msg{font-size:13px;color:#9b8c84;text-align:center;padding:20px 0}.chart-wrap{display:flex;align-items:flex-end;gap:6px;height:80px;margin-top:8px}.bar-wrap{display:flex;flex-direction:column;align-items:center;flex:1;gap:4px}.bar{background:linear-gradient(180deg,#c4923a,#e8b060);border-radius:3px 3px 0 0;width:100%;min-height:2px}.bar-lbl{font-size:9px;color:#9b8c84;text-align:center}.status-dot{width:8px;height:8px;border-radius:50%;background:#16a34a;display:inline-block;margin-right:4px}.refresh-time{font-size:11px;color:#9b8c84;text-align:center;margin-top:8px}.export-btn{font-size:12px;padding:7px 14px;background:#1a1612;color:white;border:none;border-radius:7px;cursor:pointer;font-family:inherit}.badge{display:inline-block;font-size:10px;padding:2px 8px;border-radius:100px;background:#f0d9a8;color:#7a5a1a}table{width:100%;border-collapse:collapse}th{font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#9b8c84;padding:10px 14px;text-align:left;border-bottom:1px solid #ebe2d5;background:#f9f6f1}td{padding:10px 14px;font-size:13px;border-bottom:1px solid #f3ede4;color:#3d3530}tr:last-child td{border:none}</style></head><body>
<div class="login" id="loginView">
  <div class="login-card">
    <div class="brand"><div class="brand-icon">A</div><div class="brand-name">ARIA</div></div>
    <div style="text-align:center;margin-bottom:22px">
      <div style="font-size:15px;font-weight:500;margin-bottom:4px">Command Center</div>
      <div style="font-size:12px;color:#9b8c84">Unified project dashboard</div>
    </div>
    <div class="err" id="loginErr">Incorrect password.</div>
    <div class="label">Password</div>
    <input class="field" type="password" id="pw" placeholder="••••••••" onkeydown="if(event.key==='Enter')doLogin()">
    <button class="btn" onclick="doLogin()">Access Command Center</button>
  </div>
</div>
<div class="dash" id="dashView">
  <div class="topnav">
    <div class="topnav-left">
      <div class="topnav-icon">A</div>
      <div>
        <div class="topnav-title">ARIA Command Center</div>
        <div class="topnav-sub"><span class="status-dot"></span>Live</div>
      </div>
    </div>
    <button class="signout" onclick="doLogout()">Sign Out</button>
  </div>
  <div class="tabs">
    <button class="tab-btn active" onclick="showTab('overview')">Overview</button>
    <button class="tab-btn" onclick="showTab('members')">Members</button>
    <button class="tab-btn" onclick="showTab('ai')">AI Tools</button>
    <button class="tab-btn" onclick="showTab('errors')">Errors</button>
  </div>

  <!-- OVERVIEW TAB -->
  <div class="tab-content active" id="tab-overview">
    <div class="stats-grid">
      <div class="stat"><div class="stat-val" id="totalUsers">0</div><div class="stat-lbl">Total Users</div></div>
      <div class="stat"><div class="stat-val" id="todayUsers">0</div><div class="stat-lbl">Today</div></div>
      <div class="stat"><div class="stat-val" id="weekUsers">0</div><div class="stat-lbl">This Week</div></div>
      <div class="stat"><div class="stat-val" id="uptime">0h</div><div class="stat-lbl">Uptime</div></div>
    </div>
    <div class="grid2">
      <div class="panel">
        <div class="panel-title">Growth (7 days)</div>
        <div class="panel-sub">Daily new signups</div>
        <div class="chart-wrap" id="chartWrap"></div>
      </div>
      <div class="panel">
        <div class="panel-title">Recent Signups</div>
        <div class="panel-sub">Latest 5 members</div>
        <div id="recentSignups"></div>
      </div>
    </div>
  </div>

  <!-- MEMBERS TAB -->
  <div class="tab-content" id="tab-members">
    <div class="panel">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div><div class="panel-title">All Members</div><div class="panel-sub">Complete signup list</div></div>
        <button class="export-btn" onclick="exportCSV()">Export CSV</button>
      </div>
      <table>
        <thead><tr><th>#</th><th>Name</th><th>Email</th><th>Joined</th></tr></thead>
        <tbody id="membersTable"></tbody>
      </table>
    </div>
  </div>

  <!-- AI TOOLS TAB -->
  <div class="tab-content" id="tab-ai">
    <div class="grid2">
      <div class="panel">
        <div class="panel-title">Feature Suggestions</div>
        <div class="panel-sub">AI product recommendations</div>
        <button class="ai-btn" id="featBtn" onclick="getAI('features','featBtn','featOutput','featCopy')">Generate</button>
        <div class="ai-output" id="featOutput"></div>
        <button class="copy-btn" id="featCopy" onclick="copyText('featOutput','featCopy')">Copy</button>
      </div>
      <div class="panel">
        <div class="panel-title">Newsletter Draft</div>
        <div class="panel-sub">Ready for Substack</div>
        <button class="ai-btn" id="newsBtn" onclick="getAI('newsletter','newsBtn','newsOutput','newsCopy')">Draft</button>
        <div class="ai-output" id="newsOutput"></div>
        <button class="copy-btn" id="newsCopy" onclick="copyText('newsOutput','newsCopy')">Copy</button>
      </div>
    </div>
    <div class="grid2">
      <div class="panel">
        <div class="panel-title">Reddit Post</div>
        <div class="panel-sub">Ready for r/SideProject</div>
        <button class="ai-btn" id="redditBtn" onclick="getAI('reddit','redditBtn','redditOutput','redditCopy')">Draft</button>
        <div class="ai-output" id="redditOutput"></div>
        <button class="copy-btn" id="redditCopy" onclick="copyText('redditOutput','redditCopy')">Copy</button>
      </div>
      <div class="panel">
        <div class="panel-title">Discord Content</div>
        <div class="panel-sub">Welcome + announcements</div>
        <button class="ai-btn" id="discordBtn" onclick="getAI('discord','discordBtn','discordOutput','discordCopy')">Generate</button>
        <div class="ai-output" id="discordOutput"></div>
        <button class="copy-btn" id="discordCopy" onclick="copyText('discordOutput','discordCopy')">Copy</button>
        <button class="copy-btn" id="discordPostGeneral" style="display:none;background:#5865F2;color:white;border-color:#5865F2" onclick="postToDiscord('general',document.getElementById('discordOutput').textContent,'discordPostGeneral')">📤 Post to #general</button>
        <button class="copy-btn" id="discordPostUpdates" style="display:none;background:#5865F2;color:white;border-color:#5865F2;margin-left:6px" onclick="postToDiscord('aria-updates',document.getElementById('discordOutput').textContent,'discordPostUpdates')">📤 Post to #aria-updates</button>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">Shareholder Report</div>
      <div class="panel-sub">Weekly progress summary</div>
      <button class="ai-btn" id="shareBtn" onclick="getAI('shareholder','shareBtn','shareOutput','shareCopy')">Generate</button>
      <div class="ai-output" id="shareOutput"></div>
      <button class="copy-btn" id="shareCopy" onclick="copyText('shareOutput','shareCopy')">Copy</button>
    </div>
  </div>

  <!-- ERRORS TAB -->
  <div class="tab-content" id="tab-errors">
    <div class="panel">
      <div class="panel-title">Error Monitor</div>
      <div class="panel-sub">Last 10 server errors — auto-refreshes every 60s</div>
      <div id="errorFeed"></div>
    </div>
  </div>

  <div class="refresh-time" id="refreshTime">Loading...</div>
</div>
<script>
let token='';
function doLogin(){
  const pw=document.getElementById('pw').value;
  if(!pw)return;
  token=pw;
  document.getElementById('loginErr').style.display='none';
  document.getElementById('loginView').style.display='none';
  document.getElementById('dashView').style.display='block';
  loadData();
}
function doLogout(){
  token='';
  document.getElementById('loginView').style.display='flex';
  document.getElementById('dashView').style.display='none';
  document.getElementById('pw').value='';
}
function showTab(name){
  document.querySelectorAll('.tab-btn').forEach((b,i)=>b.classList.toggle('active',['overview','members','ai','errors'][i]===name));
  document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
}
async function loadData(){
  try{
    const res=await fetch('/api/command/stats',{headers:{'x-admin-token':token}});
    if(res.status===401){document.getElementById('loginErr').style.display='block';doLogout();return;}
    const d=await res.json();
    document.getElementById('totalUsers').textContent=d.total;
    document.getElementById('todayUsers').textContent=d.today;
    document.getElementById('weekUsers').textContent=d.week;
    document.getElementById('uptime').textContent=Math.floor(d.uptime/3600)+'h';
    const maxCount=Math.max(...d.dailyCounts.map(x=>x.count),1);
    document.getElementById('chartWrap').innerHTML=d.dailyCounts.map(day=>'<div class="bar-wrap"><div class="bar" style="height:'+Math.max((day.count/maxCount)*70,2)+'px"></div><div class="bar-lbl">'+day.label.split(' ')[1]+'</div></div>').join('');
    const signupEl=document.getElementById('recentSignups');
    signupEl.innerHTML=d.recentSignups.length===0?'<div class="empty-msg">No signups yet</div>':d.recentSignups.map(s=>'<div class="signup-item"><div><div class="signup-name">'+s.name+'</div><div class="signup-email">'+s.email+'</div></div><div class="signup-time">'+new Date(s.joined).toLocaleDateString('en-US',{month:'short',day:'numeric'})+'</div></div>').join('');
    const tbody=document.getElementById('membersTable');
    tbody.innerHTML=d.allSignups.length===0?'<tr><td colspan="4" style="text-align:center;padding:30px;color:#9b8c84">No members yet</td></tr>':d.allSignups.map((s,i)=>'<tr><td><span class="badge">'+(d.total-i)+'</span></td><td>'+s.name+'</td><td style="color:#c4923a">'+s.email+'</td><td>'+new Date(s.joined).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})+'</td></tr>').join('');
    const errorEl=document.getElementById('errorFeed');
    errorEl.innerHTML=d.errors.length===0?'<div class="empty-msg" style="color:#16a34a">No errors detected</div>':d.errors.map(e=>'<div class="error-item"><span class="error-time">'+new Date(e.ts).toLocaleTimeString()+'</span>'+e.msg.substring(0,120)+'</div>').join('');
    document.getElementById('refreshTime').textContent='Last updated: '+new Date().toLocaleTimeString();
  }catch(e){console.error(e);}
}
const DISCORD_CHANNELS = {
  'aria-updates': '1483261092062040184',
  'general': '1483261401664458972',
  'getting-started': '1483262143426990282'
};

async function postToDiscord(channelName, content, btnId) {
  const btn = document.getElementById(btnId);
  if (!DISCORD_CHANNELS[channelName]) { alert('Channel not found'); return; }
  btn.disabled = true;
  btn.textContent = 'Posting...';
  try {
    const res = await fetch('/api/discord/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify({ channelId: DISCORD_CHANNELS[channelName], content })
    });
    const data = await res.json();
    if (data.ok) {
      btn.textContent = '✓ Posted!';
      btn.style.background = '#16a34a';
      setTimeout(() => { btn.disabled = false; btn.textContent = '📤 Post to #' + channelName; btn.style.background = ''; }, 3000);
    } else {
      btn.textContent = '✗ Failed';
      btn.disabled = false;
      alert('Failed: ' + (data.error || 'Unknown error'));
    }
  } catch(e) {
    btn.textContent = '✗ Error';
    btn.disabled = false;
  }
}
  const btn=document.getElementById(btnId);
  btn.disabled=true;btn.textContent='Generating...';
  try{
    const res=await fetch('/api/command/ai',{method:'POST',headers:{'Content-Type':'application/json','x-admin-token':token},body:JSON.stringify({type})});
    const data=await res.json();
    const out=document.getElementById(outputId);
    const copy=document.getElementById(copyId);
    out.textContent=data.content||data.error;
    out.style.display='block';
    copy.style.display='inline-block';
    if(type==='discord'){
      const pg=document.getElementById('discordPostGeneral');
      const pu=document.getElementById('discordPostUpdates');
      if(pg)pg.style.display='inline-block';
      if(pu)pu.style.display='inline-block';
    }
  }catch(e){
    document.getElementById(outputId).textContent='Failed. Try again.';
    document.getElementById(outputId).style.display='block';
  }
  btn.disabled=false;
  btn.textContent=type==='newsletter'?'Redraft':'Regenerate';
}
function copyText(outputId,copyId){
  navigator.clipboard.writeText(document.getElementById(outputId).textContent);
  const btn=document.getElementById(copyId);
  btn.textContent='Copied!';btn.classList.add('ok');
  setTimeout(()=>{btn.textContent='Copy';btn.classList.remove('ok');},2000);
}
function exportCSV(){window.open('/api/admin/export?token='+token,'_blank');}
setInterval(()=>{if(token)loadData();},60000);
</script></body></html>`);
});

/* ── Deploy Panel ── */
app.get('/deploy-panel', (_req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ARIA Deploy Panel</title><link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&display=swap" rel="stylesheet"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Geist',sans-serif;background:#f9f6f1;color:#1a1612;min-height:100vh}.login{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:white;border-radius:16px;padding:32px 24px;width:100%;max-width:360px;box-shadow:0 8px 32px rgba(0,0,0,0.1)}.brand{display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:28px}.brand-icon{width:36px;height:36px;background:linear-gradient(135deg,#c4923a,#e8b060);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;color:#1a1612}.brand-name{font-size:20px;font-weight:300;letter-spacing:3px;text-transform:uppercase}.label{font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#6b5e56;margin-bottom:6px}.field{width:100%;padding:12px 14px;border:1.5px solid #ebe2d5;border-radius:8px;font-family:inherit;font-size:14px;outline:none;margin-bottom:14px;background:#f9f6f1;-webkit-appearance:none}.field:focus{border-color:#c4923a;background:white}.btn{width:100%;padding:13px;background:#1a1612;color:white;border:none;border-radius:8px;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:10px}.btn:active{background:#c4923a}.btn-sec{width:100%;padding:11px;background:transparent;color:#6b5e56;border:1.5px solid #ebe2d5;border-radius:8px;font-family:inherit;font-size:13px;cursor:pointer}.err{font-size:12px;color:#dc2626;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:9px 12px;margin-bottom:12px;display:none}.dash{display:none;padding:20px;max-width:600px;margin:0 auto}.nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;padding:14px 0;border-bottom:1px solid #ebe2d5}.nav-left{display:flex;align-items:center;gap:8px}.nav-icon{width:28px;height:28px;background:linear-gradient(135deg,#c4923a,#e8b060);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;color:#1a1612}.nav-title{font-size:16px;font-weight:500}.nav-sub{font-size:12px;color:#9b8c84}.logout{font-size:12px;color:#9b8c84;background:none;border:1px solid #ebe2d5;border-radius:6px;padding:6px 12px;cursor:pointer;font-family:inherit}.section{background:white;border:1px solid #ebe2d5;border-radius:12px;padding:20px;margin-bottom:16px}.section-title{font-size:13px;font-weight:600;margin-bottom:4px}.section-sub{font-size:12px;color:#9b8c84;margin-bottom:16px}.file-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f3ede4}.file-row:last-child{border:none}.file-name{font-size:13px;color:#3d3530;font-family:monospace}.file-status{font-size:11px;padding:3px 9px;border-radius:100px;background:#f0d9a8;color:#7a5a1a}.file-status.ok{background:#f0fdf4;color:#166534}.file-status.err{background:#fef2f2;color:#dc2626}.deploy-btn{width:100%;padding:14px;background:#1a1612;color:white;border:none;border-radius:10px;font-family:inherit;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:10px}.deploy-btn:active{background:#c4923a}.deploy-btn:disabled{background:#9b8c84;cursor:not-allowed}.status-bar{padding:11px 14px;border-radius:8px;font-size:13px;display:none;margin-bottom:12px}.status-bar.ok{background:#f0fdf4;border:1px solid #86efac;color:#166534}.status-bar.err{background:#fef2f2;border:1px solid #fecaca;color:#dc2626}.status-bar.loading{background:#f0d9a8;border:1px solid #c4923a;color:#7a5a1a}.log-box{background:#1a1612;border-radius:10px;padding:14px;display:none;margin-top:12px}.log-label{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:#9b8c84;margin-bottom:8px}.log-line{font-size:12px;color:#f0d9a8;font-family:monospace;line-height:1.9}.log-line.ok{color:#86efac}.log-line.err{color:#fca5a5}.hdot{width:8px;height:8px;border-radius:50%;background:#9b8c84;display:inline-block;margin-right:6px}.hdot.live{background:#16a34a}</style></head><body>
<div class="login" id="loginView">
  <div class="card">
    <div class="brand"><div class="brand-icon">A</div><div class="brand-name">ARIA</div></div>
    <div style="text-align:center;margin-bottom:22px">
      <div style="font-size:15px;font-weight:500;margin-bottom:4px">Deploy Panel</div>
      <div style="font-size:12px;color:#9b8c84">Enter your deploy password</div>
    </div>
    <div class="err" id="loginErr">Incorrect password.</div>
    <div class="label">Password</div>
    <input class="field" type="password" id="pw" placeholder="••••••••" onkeydown="if(event.key==='Enter')doLogin()">
    <button class="btn" onclick="doLogin()">Access Deploy Panel</button>
  </div>
</div>
<div class="dash" id="dashView">
  <div class="nav">
    <div class="nav-left">
      <div class="nav-icon">A</div>
      <div><div class="nav-title">Deploy Panel</div><div class="nav-sub"><span class="hdot" id="hdot"></span><span id="htext">Checking...</span></div></div>
    </div>
    <button class="logout" onclick="doLogout()">Sign Out</button>
  </div>
  <div class="section">
    <div class="section-title">Files Queued for Deploy</div>
    <div class="section-sub">All 3 files pushed to GitHub. Render redeploys automatically.</div>
    <div id="fileRows">
      <div class="file-row"><span class="file-name">public/index.html</span><span class="file-status" id="status-index">Ready</span></div>
      <div class="file-row"><span class="file-name">public/sw.js</span><span class="file-status" id="status-sw">Ready</span></div>
      <div class="file-row"><span class="file-name">server.js</span><span class="file-status" id="status-server">Ready</span></div>
    </div>
  </div>
  <div class="status-bar" id="statusBar"></div>
  <button class="deploy-btn" id="deployBtn" onclick="deployAll()">Deploy All Files</button>
  <button class="btn-sec" onclick="checkHealth()">Check Server Health</button>
  <div class="log-box" id="logBox"><div class="log-label">Deploy Log</div><div id="logLines"></div></div>
</div>
<script>
let secret='';
function doLogin(){const pw=document.getElementById('pw').value;if(!pw)return;secret=pw;checkHealth();document.getElementById('loginErr').style.display='none';document.getElementById('loginView').style.display='none';document.getElementById('dashView').style.display='block';}
function doLogout(){secret='';document.getElementById('loginView').style.display='flex';document.getElementById('dashView').style.display='none';document.getElementById('pw').value='';}
async function checkHealth(){try{const r=await fetch('/health');const d=await r.json();if(d.status==='ok'){document.getElementById('hdot').className='hdot live';document.getElementById('htext').textContent='Server live';}}catch(e){document.getElementById('htext').textContent='Server sleeping';}}
function showStatus(msg,type){const s=document.getElementById('statusBar');s.textContent=msg;s.className='status-bar '+type;s.style.display='block';}
function addLog(msg,type=''){document.getElementById('logBox').style.display='block';const line=document.createElement('div');line.className='log-line '+type;line.textContent=new Date().toLocaleTimeString()+'  '+msg;document.getElementById('logLines').appendChild(line);}
function setFileStatus(id,text,type){const el=document.getElementById('status-'+id);if(el){el.textContent=text;el.className='file-status '+type;}}
async function deployAll(){const btn=document.getElementById('deployBtn');btn.disabled=true;btn.textContent='Deploying...';document.getElementById('logLines').innerHTML='';document.getElementById('logBox').style.display='none';showStatus('Starting deploy...','loading');addLog('Deploy started');const files=[{id:'index',filename:'public/index.html'},{id:'sw',filename:'public/sw.js'},{id:'server',filename:'server.js'}];let allOk=true;for(const f of files){setFileStatus(f.id,'Deploying...','');addLog('Pushing '+f.filename+'...');try{const res=await fetch('/api/deploy-latest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret,filename:f.filename})});const data=await res.json();if(data.ok){setFileStatus(f.id,'Deployed','ok');addLog(f.filename+' pushed','ok');}else{setFileStatus(f.id,'Failed','err');addLog(f.filename+': '+(data.error||'failed'),'err');allOk=false;}}catch(e){setFileStatus(f.id,'Error','err');addLog('Error: '+e.message,'err');allOk=false;}await new Promise(r=>setTimeout(r,1500));}if(allOk){showStatus('All files deployed! Live in ~60 seconds.','ok');addLog('Deploy complete.','ok');btn.textContent='Done!';setTimeout(()=>{btn.disabled=false;btn.textContent='Deploy All Files';},5000);}else{showStatus('Some files failed. Check log.','err');btn.disabled=false;btn.textContent='Deploy All Files';}}
checkHealth();
</script></body></html>`);
});

/* ── Claude proxy ── */

// Pro emails — admin always gets Pro free
const PRO_EMAILS = new Set([
  'joeburchette2010@gmail.com'
]);

// Add a paid user to Pro (called when Stripe payment confirmed later)
function grantPro(email) { PRO_EMAILS.add(email.toLowerCase()); }

function getModel(userEmail, isPro) {
  const email = (userEmail || '').toLowerCase();
  // Admin email always gets Sonnet
  if (PRO_EMAILS.has(email)) return 'claude-sonnet-4-20250514';
  // Paid Pro users get Sonnet
  if (isPro) return 'claude-sonnet-4-20250514';
  // Free users get Haiku — same quality, 70% cheaper
  return 'claude-haiku-4-5-20251001';
}

app.post('/api/chat', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (rateLimit(ip)) return res.status(429).json({ error: 'Too many requests.' });
  const { messages, system, userEmail, isPro } = req.body;
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'messages array is required.' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Add ANTHROPIC_API_KEY in Render environment variables.' });

  const model = getModel(userEmail, isPro);
  const tier  = model.includes('sonnet') ? 'Pro' : 'Free';
  console.log(`CHAT [${tier}] ${userEmail || 'anonymous'} — model: ${model}`);

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1024, system: system || '', messages })
    });
    const data = await upstream.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ ...data, tier });
  } catch (err) {
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
