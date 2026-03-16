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

/* ── In-memory signup store ── */
const signups = [];

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

/* ── Signup logging ── */
app.post('/api/signup', (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Missing fields' });
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const entry = { name, email, joined: new Date().toISOString(), ts };
  signups.push(entry);
  console.log(`NEW SIGNUP — Name: ${name} | Email: ${email} | Time: ${ts}`);
  res.json({ ok: true });
});

/* ── Admin auth ── */
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const adminPassword = process.env.ADMIN_PASSWORD || 'aria-admin-2025';
  if (token !== adminPassword) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/* ── Admin API: get signups ── */
app.get('/api/admin/signups', adminAuth, (req, res) => {
  res.json({ total: signups.length, signups: signups.slice().reverse() });
});

/* ── Admin API: export CSV ── */
app.get('/api/admin/export', adminAuth, (req, res) => {
  const csv = ['Name,Email,Joined'].concat(
    signups.map(s => `"${s.name}","${s.email}","${s.ts}"`)
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="aria-users.csv"');
  res.send(csv);
});

/* ── AUTO-DEPLOY endpoint ── */
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
    if (result.content) {
      console.log(`DEPLOYED: ${filename}`);
      res.json({ ok: true, message: `${filename} deployed` });
    } else {
      res.status(500).json({ error: result.message || 'Deploy failed' });
    }
  } catch (err) {
    res.status(502).json({ error: 'Deploy failed: ' + err.message });
  }
});

/* ── DEPLOY-LATEST: reads current file from disk and pushes to GitHub ── */
app.post('/api/deploy-latest', async (req, res) => {
  const { secret, filename } = req.body;
  const deploySecret = process.env.DEPLOY_SECRET || 'aria-deploy-2025';
  if (secret !== deploySecret) return res.status(401).json({ error: 'Invalid deploy secret' });

  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO;
  const email = process.env.GITHUB_EMAIL;
  if (!token || !repo) return res.status(500).json({ error: 'GitHub env vars not set' });

  try {
    const fs = require('fs');
    const filePath = path.join(__dirname, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on server' });
    const content = fs.readFileSync(filePath, 'utf8');

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
    if (result.content) {
      console.log(`DEPLOYED LATEST: ${filename}`);
      res.json({ ok: true, message: `${filename} deployed from server` });
    } else {
      res.status(500).json({ error: result.message || 'Deploy failed' });
    }
  } catch (err) {
    res.status(502).json({ error: 'Deploy failed: ' + err.message });
  }
});


/* ── Deploy Panel ── */
app.get('/deploy-panel', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ARIA Deploy Panel</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Geist',sans-serif;background:#f9f6f1;color:#1a1612;min-height:100vh}
.login{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:white;border-radius:16px;padding:32px 24px;width:100%;max-width:360px;box-shadow:0 8px 32px rgba(0,0,0,0.1)}
.brand{display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:28px}
.brand-icon{width:36px;height:36px;background:linear-gradient(135deg,#c4923a,#e8b060);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;color:#1a1612}
.brand-name{font-size:20px;font-weight:300;letter-spacing:3px;text-transform:uppercase}
.label{font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#6b5e56;margin-bottom:6px}
.field{width:100%;padding:12px 14px;border:1.5px solid #ebe2d5;border-radius:8px;font-family:inherit;font-size:14px;outline:none;margin-bottom:14px;background:#f9f6f1;-webkit-appearance:none}
.field:focus{border-color:#c4923a;background:white}
.btn{width:100%;padding:13px;background:#1a1612;color:white;border:none;border-radius:8px;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:10px}
.btn:active{background:#c4923a}
.btn:disabled{background:#9b8c84;cursor:not-allowed}
.btn-sec{width:100%;padding:11px;background:transparent;color:#6b5e56;border:1.5px solid #ebe2d5;border-radius:8px;font-family:inherit;font-size:13px;font-weight:500;cursor:pointer}
.err{font-size:12px;color:#dc2626;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:9px 12px;margin-bottom:12px;display:none}
.dashboard{display:none;padding:20px;max-width:600px;margin:0 auto}
.nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;padding:14px 0;border-bottom:1px solid #ebe2d5}
.nav-brand{display:flex;align-items:center;gap:8px}
.nav-icon{width:28px;height:28px;background:linear-gradient(135deg,#c4923a,#e8b060);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;color:#1a1612}
.nav-title{font-size:16px;font-weight:500;letter-spacing:1px}
.nav-sub{font-size:12px;color:#9b8c84}
.logout{font-size:12px;color:#9b8c84;background:none;border:1px solid #ebe2d5;border-radius:6px;padding:6px 12px;cursor:pointer;font-family:inherit}
.section{background:white;border:1px solid #ebe2d5;border-radius:12px;padding:20px;margin-bottom:16px}
.section-title{font-size:13px;font-weight:600;color:#1a1612;margin-bottom:4px}
.section-sub{font-size:12px;color:#9b8c84;margin-bottom:16px;line-height:1.5}
.file-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f3ede4}
.file-row:last-child{border:none}
.file-name{font-size:13px;color:#3d3530;font-family:monospace}
.file-status{font-size:11px;padding:3px 9px;border-radius:100px;background:#f0d9a8;color:#7a5a1a}
.file-status.ok{background:#f0fdf4;color:#166534}
.file-status.err{background:#fef2f2;color:#dc2626}
.deploy-btn{width:100%;padding:14px;background:#1a1612;color:white;border:none;border-radius:10px;font-family:inherit;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:10px}
.deploy-btn:active{background:#c4923a}
.deploy-btn:disabled{background:#9b8c84;cursor:not-allowed}
.status-bar{padding:11px 14px;border-radius:8px;font-size:13px;display:none;margin-bottom:12px;line-height:1.5}
.status-bar.ok{background:#f0fdf4;border:1px solid #86efac;color:#166534}
.status-bar.err{background:#fef2f2;border:1px solid #fecaca;color:#dc2626}
.status-bar.loading{background:#f0d9a8;border:1px solid #c4923a;color:#7a5a1a}
.log-box{background:#1a1612;border-radius:10px;padding:14px;display:none;margin-top:12px}
.log-label{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:#9b8c84;margin-bottom:8px}
.log-line{font-size:12px;color:#f0d9a8;font-family:monospace;line-height:1.9}
.log-line.ok{color:#86efac}
.log-line.err{color:#fca5a5}
.health-dot{width:8px;height:8px;border-radius:50%;background:#9b8c84;display:inline-block;margin-right:6px}
.health-dot.live{background:#16a34a}
</style>
</head>
<body>

<div class="login" id="loginView">
  <div class="card">
    <div class="brand">
      <div class="brand-icon">A</div>
      <div class="brand-name">ARIA</div>
    </div>
    <div style="text-align:center;margin-bottom:22px">
      <div style="font-size:15px;font-weight:500;margin-bottom:4px">Deploy Panel</div>
      <div style="font-size:12px;color:#9b8c84">Enter your deploy password</div>
    </div>
    <div class="err" id="loginErr">Incorrect password.</div>
    <div class="label">Password</div>
    <input class="field" type="password" id="pw" placeholder="••••••••" onkeydown="if(event.key==='Enter')doLogin()">
    <button class="btn" onclick="doLogin()">Access Deploy Panel →</button>
  </div>
</div>

<div class="dashboard" id="dashView">
  <div class="nav">
    <div class="nav-brand">
      <div class="nav-icon">A</div>
      <div>
        <div class="nav-title">Deploy Panel</div>
        <div class="nav-sub"><span class="health-dot" id="healthDot"></span><span id="healthText">Checking...</span></div>
      </div>
    </div>
    <button class="logout" onclick="doLogout()">Sign Out</button>
  </div>

  <div class="section">
    <div class="section-title">Files Queued for Deploy</div>
    <div class="section-sub">These files will be pushed to GitHub and Render will redeploy automatically.</div>
    <div id="fileRows">
      <div class="file-row">
        <span class="file-name">public/index.html</span>
        <span class="file-status" id="status-index">Ready</span>
      </div>
    </div>
  </div>

  <div class="status-bar" id="statusBar"></div>

  <button class="deploy-btn" id="deployBtn" onclick="deployAll()">🚀 Deploy All Files</button>
  <button class="btn-sec" onclick="checkHealth()">Check Server Health</button>

  <div class="log-box" id="logBox">
    <div class="log-label">Deploy Log</div>
    <div id="logLines"></div>
  </div>
</div>

<script>
let secret = '';

function doLogin() {
  const pw = document.getElementById('pw').value;
  if (!pw) return;
  secret = pw;
  checkHealth();
  document.getElementById('loginErr').style.display = 'none';
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('dashView').style.display = 'block';
}

function doLogout() {
  secret = '';
  document.getElementById('loginView').style.display = 'flex';
  document.getElementById('dashView').style.display = 'none';
  document.getElementById('pw').value = '';
}

async function checkHealth() {
  try {
    const res = await fetch('/health');
    const data = await res.json();
    if (data.status === 'ok') {
      document.getElementById('healthDot').className = 'health-dot live';
      document.getElementById('healthText').textContent = 'Server live';
    }
  } catch(e) {
    document.getElementById('healthText').textContent = 'Server sleeping';
  }
}

function showStatus(msg, type) {
  const s = document.getElementById('statusBar');
  s.textContent = msg;
  s.className = 'status-bar ' + type;
  s.style.display = 'block';
}

function addLog(msg, type='') {
  document.getElementById('logBox').style.display = 'block';
  const line = document.createElement('div');
  line.className = 'log-line ' + type;
  line.textContent = new Date().toLocaleTimeString() + '  ' + msg;
  document.getElementById('logLines').appendChild(line);
}

function setFileStatus(id, text, type) {
  const el = document.getElementById('status-' + id);
  if (el) { el.textContent = text; el.className = 'file-status ' + type; }
}

async function deployAll() {
  const btn = document.getElementById('deployBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Deploying...';
  document.getElementById('logLines').innerHTML = '';
  document.getElementById('logBox').style.display = 'none';
  showStatus('Starting deploy...', 'loading');
  addLog('Deploy started');

  const files = [
    { id: 'index', filename: 'public/index.html' }
  ];

  let allOk = true;
  for (const f of files) {
    setFileStatus(f.id, 'Deploying...', '');
    addLog('Pushing ' + f.filename + ' to GitHub...');
    try {
      const res = await fetch('/api/deploy-latest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, filename: f.filename })
      });
      const data = await res.json();
      if (data.ok) {
        setFileStatus(f.id, '✓ Deployed', 'ok');
        addLog('✓ ' + f.filename + ' pushed successfully', 'ok');
      } else {
        setFileStatus(f.id, '✗ Failed', 'err');
        addLog('✗ ' + f.filename + ': ' + (data.error || 'failed'), 'err');
        allOk = false;
      }
    } catch(e) {
      setFileStatus(f.id, '✗ Error', 'err');
      addLog('✗ Network error: ' + e.message, 'err');
      allOk = false;
    }
  }

  if (allOk) {
    showStatus('✅ All files deployed! Render is rebuilding — live in ~60 seconds.', 'ok');
    addLog('Deploy complete. Render auto-deploy triggered.', 'ok');
    btn.textContent = '✅ Deployed!';
    setTimeout(() => { btn.disabled = false; btn.textContent = '🚀 Deploy All Files'; }, 5000);
  } else {
    showStatus('⚠️ Some files failed. Check the log below.', 'err');
    btn.disabled = false;
    btn.textContent = '🚀 Deploy All Files';
  }
}

checkHealth();
</script>
</body>
</html>`);
});


app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ARIA Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Geist',sans-serif;background:#f9f6f1;color:#1a1612;min-height:100vh}
.login{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:white;border-radius:16px;padding:32px 24px;width:100%;max-width:360px;box-shadow:0 8px 32px rgba(0,0,0,0.1)}
.brand{display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:28px}
.brand-icon{width:36px;height:36px;background:linear-gradient(135deg,#c4923a,#e8b060);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;color:#1a1612}
.brand-name{font-size:20px;font-weight:300;letter-spacing:3px;text-transform:uppercase}
.label{font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#6b5e56;margin-bottom:6px}
.field{width:100%;padding:12px 14px;border:1.5px solid #ebe2d5;border-radius:8px;font-family:inherit;font-size:14px;outline:none;margin-bottom:14px;background:#f9f6f1;-webkit-appearance:none}
.field:focus{border-color:#c4923a;background:white}
.btn{width:100%;padding:13px;background:#1a1612;color:white;border:none;border-radius:8px;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer}
.btn:active{background:#c4923a}
.err{font-size:12px;color:#dc2626;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:9px 12px;margin-bottom:12px;display:none}
.dashboard{display:none;padding:20px;max-width:900px;margin:0 auto}
.nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;padding:14px 0;border-bottom:1px solid #ebe2d5}
.nav-brand{display:flex;align-items:center;gap:8px}
.nav-icon{width:28px;height:28px;background:linear-gradient(135deg,#c4923a,#e8b060);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;color:#1a1612}
.nav-title{font-size:16px;font-weight:500;letter-spacing:1px}
.nav-sub{font-size:12px;color:#9b8c84}
.logout{font-size:12px;color:#9b8c84;background:none;border:1px solid #ebe2d5;border-radius:6px;padding:6px 12px;cursor:pointer;font-family:inherit}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px}
.stat{background:white;border:1px solid #ebe2d5;border-radius:12px;padding:16px;text-align:center}
.stat-val{font-size:28px;font-weight:600;color:#c4923a;font-family:Georgia,serif}
.stat-lbl{font-size:11px;color:#9b8c84;text-transform:uppercase;letter-spacing:1px;margin-top:4px}
.toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.toolbar-title{font-size:14px;font-weight:500}
.export-btn{font-size:12px;padding:7px 14px;background:#1a1612;color:white;border:none;border-radius:7px;cursor:pointer;font-family:inherit}
.table-wrap{background:white;border:1px solid #ebe2d5;border-radius:12px;overflow:hidden}
table{width:100%;border-collapse:collapse}
th{font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#9b8c84;padding:12px 16px;text-align:left;border-bottom:1px solid #ebe2d5;background:#f9f6f1}
td{padding:12px 16px;font-size:13px;border-bottom:1px solid #f3ede4;color:#3d3530}
tr:last-child td{border:none}
.empty-td{text-align:center;padding:40px;color:#9b8c84;font-size:14px}
.badge{display:inline-block;font-size:10px;padding:2px 8px;border-radius:100px;background:#f0d9a8;color:#7a5a1a}
.refresh{font-size:11px;color:#9b8c84;margin-top:12px;text-align:center}
</style>
</head>
<body>
<div class="login" id="loginView">
  <div class="card">
    <div class="brand"><div class="brand-icon">A</div><div class="brand-name">ARIA</div></div>
    <div style="text-align:center;margin-bottom:22px">
      <div style="font-size:15px;font-weight:500;margin-bottom:4px">Admin Dashboard</div>
      <div style="font-size:12px;color:#9b8c84">Enter your admin password</div>
    </div>
    <div class="err" id="err">Incorrect password.</div>
    <div class="label">Admin Password</div>
    <input class="field" type="password" id="pw" placeholder="••••••••" onkeydown="if(event.key==='Enter')doLogin()">
    <button class="btn" onclick="doLogin()">Access Dashboard →</button>
  </div>
</div>
<div class="dashboard" id="dashView">
  <div class="nav">
    <div class="nav-brand">
      <div class="nav-icon">A</div>
      <div><div class="nav-title">ARIA Admin</div><div class="nav-sub">User Management</div></div>
    </div>
    <button class="logout" onclick="doLogout()">Sign Out</button>
  </div>
  <div class="stats">
    <div class="stat"><div class="stat-val" id="totalCount">0</div><div class="stat-lbl">Total Users</div></div>
    <div class="stat"><div class="stat-val" id="todayCount">0</div><div class="stat-lbl">Joined Today</div></div>
    <div class="stat"><div class="stat-val" id="weekCount">0</div><div class="stat-lbl">This Week</div></div>
  </div>
  <div class="toolbar">
    <div class="toolbar-title">All Members</div>
    <button class="export-btn" onclick="exportCSV()">Export CSV</button>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>#</th><th>Name</th><th>Email</th><th>Joined</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <div class="refresh" id="refreshTime">Auto-refreshes every 30 seconds</div>
</div>
<script>
let adminToken='';
function doLogin(){
  const pw=document.getElementById('pw').value;
  if(!pw)return;
  adminToken=pw;loadData();
}
function doLogout(){
  adminToken='';
  document.getElementById('loginView').style.display='flex';
  document.getElementById('dashView').style.display='none';
  document.getElementById('pw').value='';
}
async function loadData(){
  try{
    const res=await fetch('/api/admin/signups',{headers:{'x-admin-token':adminToken}});
    if(res.status===401){document.getElementById('err').style.display='block';adminToken='';return;}
    const data=await res.json();
    document.getElementById('err').style.display='none';
    document.getElementById('loginView').style.display='none';
    document.getElementById('dashView').style.display='block';
    const now=new Date(),todayStr=now.toDateString(),weekAgo=new Date(now-7*24*60*60*1000);
    let today=0,week=0;
    data.signups.forEach(s=>{const d=new Date(s.joined);if(d.toDateString()===todayStr)today++;if(d>=weekAgo)week++;});
    document.getElementById('totalCount').textContent=data.total;
    document.getElementById('todayCount').textContent=today;
    document.getElementById('weekCount').textContent=week;
    const tbody=document.getElementById('tbody');
    if(data.signups.length===0){
      tbody.innerHTML='<tr><td colspan="4" class="empty-td">No signups yet. Share your app!</td></tr>';
    }else{
      tbody.innerHTML=data.signups.map((s,i)=>{
        const d=new Date(s.joined);
        return '<tr><td><span class="badge">'+(data.total-i)+'</span></td><td>'+s.name+'</td><td style="color:#c4923a">'+s.email+'</td><td>'+d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})+' '+d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})+'</td></tr>';
      }).join('');
    }
    document.getElementById('refreshTime').textContent='Last updated: '+new Date().toLocaleTimeString();
  }catch(e){console.error(e);}
}
function exportCSV(){window.open('/api/admin/export?token='+adminToken,'_blank');}
setInterval(()=>{if(adminToken)loadData();},30000);
</script>
</body>
</html>`);
});

/* ── Claude proxy ── */
app.post('/api/chat', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (rateLimit(ip)) return res.status(429).json({ error: 'Too many requests.' });

  const { messages, system } = req.body;
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'messages array is required.' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Add ANTHROPIC_API_KEY in Render environment variables.' });

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: system || '',
        messages
      })
    });
    const data = await upstream.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data);
  } catch (err) {
    console.error('[proxy] failed to reach Anthropic');
    res.status(502).json({ error: 'Could not reach AI. Please try again.' });
  }
});

/* ── SPA fallback ── */
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () =>
  console.log(`ARIA running on port ${PORT} [${PROD ? 'production' : 'dev'}]`)
);
