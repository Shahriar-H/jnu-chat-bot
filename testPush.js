require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');

const router = express.Router();

const { getAdmin, getInitError } = require('./fcm');

const usersCol = () => mongoose.connection.collection('users');
const busesCol = () => mongoose.connection.collection('buses');

const busSlug = (name) => 'bus_' + encodeURIComponent(name);

function buildMessage({ token, tokens, title, body, busName, requesterEmail, requesterName, reqId }) {
  const msg = {
    notification: { title, body },
    data: {
      type: 'bus_request',
      reqId,
      busId: busSlug(busName),
      busName: busName || '',
      requesterEmail: requesterEmail || '',
      requesterName: requesterName || '',
    },
    android: {
      priority: 'high',
      notification: { priority: 'high', channelId: 'default' },
    },
  };
  if (token) msg.token = token;
  if (tokens) msg.tokens = tokens;
  return msg;
}

// ---- Test UI ----
router.get('/test-push', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FCM Push Test</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f1f5f9; margin: 0; padding: 24px; }
  .card { background: #fff; max-width: 520px; margin: 0 auto; border-radius: 14px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  h1 { margin-top: 0; font-size: 20px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 4px; color: #334155; }
  input, select, textarea { width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 14px; }
  textarea { min-height: 70px; resize: vertical; }
  button { margin-top: 18px; width: 100%; padding: 12px; background: #059669; color: #fff; border: 0; border-radius: 8px; font-size: 15px; font-weight: 700; cursor: pointer; }
  button:disabled { opacity: .5; }
  #result { margin-top: 14px; font-size: 13px; white-space: pre-wrap; word-break: break-word; }
  .ok { color: #059669; } .err { color: #dc2626; }
  .radios { display: flex; gap: 18px; margin-top: 6px; }
</style>
</head>
<body>
<div class="card">
  <h1>FCM Push Test</h1>
  <div class="radios">
    <label style="margin-top:0"><input type="radio" name="target" value="bus" checked onchange="toggleTarget()"> Send to bus riders</label>
    <label style="margin-top:0"><input type="radio" name="target" value="token" onchange="toggleTarget()"> Send to a token</label>
  </div>

  <label>Bus name</label>
  <input id="busName" list="busList" placeholder="e.g. Jamuna 14:00" oninput="onBusName()">
  <datalist id="busList"></datalist>

  <label>FCM token</label>
  <textarea id="token" placeholder="Paste a device registration token..." disabled></textarea>

  <label>Title</label>
  <input id="title" value="Shakib is asking about Jamuna bus">

  <label>Body</label>
  <textarea id="body">Tap to help by sharing your location or where the bus is now.</textarea>

  <label>Requester name</label>
  <input id="requesterName" placeholder="e.g. Shakib">

  <label>Requester email (optional)</label>
  <input id="requesterEmail" placeholder="e.g. shakib@example.com">

  <button id="sendBtn" onclick="send()">Send Push</button>
  <div id="result"></div>
</div>

<script>
const DATA_URL = 'https://shahriar-h.github.io/jnu-bus-app-ads/data2.json';

fetch('/buses').then(r => r.json()).then(d => {
  const list = d?.data || [];
  const dl = document.getElementById('busList');
  list.forEach(b => { const o = document.createElement('option'); o.value = b.name; dl.appendChild(o); });
}).catch(() => {
  fetch(DATA_URL).then(r => r.json()).then(d => {
    const list = d?.data || [];
    const dl = document.getElementById('busList');
    list.forEach(b => { const o = document.createElement('option'); o.value = b.name; dl.appendChild(o); });
  }).catch(() => {});
});

function toggleTarget() {
  const v = document.querySelector('input[name=target]:checked').value;
  document.getElementById('token').disabled = v !== 'token';
  document.getElementById('busName').disabled = v !== 'bus';
}

function onBusName() {
  const title = document.getElementById('title');
  if (title.value.trim() === '' || title.value.includes('bus') === false) {
    title.value = 'Someone is asking about ' + document.getElementById('busName').value + ' bus';
  }
}

async function send() {
  const btn = document.getElementById('sendBtn');
  const res = document.getElementById('result');
  btn.disabled = true;
  res.className = '';
  res.textContent = 'Sending...';
  const target = document.querySelector('input[name=target]:checked').value;
  const payload = {
    target,
    busName: document.getElementById('busName').value.trim(),
    token: document.getElementById('token').value.trim(),
    title: document.getElementById('title').value.trim(),
    body: document.getElementById('body').value.trim(),
    requesterName: document.getElementById('requesterName').value.trim(),
    requesterEmail: document.getElementById('requesterEmail').value.trim(),
  };
  try {
    const r = await fetch('/test-push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    res.className = r.ok ? 'ok' : 'err';
    res.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    res.className = 'err';
    res.textContent = 'Request failed: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}
</script>
</body>
</html>`);
});

// ---- Send the push ----
router.post('/test-push/send', async (req, res) => {
  try {
    const admin = getAdmin();
    if (!admin) {
      return res.status(500).json({ error: 'FCM not configured: ' + (getInitError() || 'FCM_SERVICE_ACCOUNT env missing') });
    }
    const { target, busName, token, title, body, requesterEmail, requesterName } = req.body || {};
    if (!title || !body) return res.status(400).json({ error: 'title and body are required' });

    const reqId = 'req_' + crypto.randomUUID();
    const payload = {
      busName,
      requesterEmail,
      requesterName,
      reqId,
      title,
      body,
    };

    if (target === 'token') {
      if (!token) return res.status(400).json({ error: 'token required when target=token' });
      if (!busName) return res.status(400).json({ error: 'busName required to build data payload' });
      const msg = buildMessage({ ...payload, token });
      await admin.messaging().send(msg);
      return res.json({ ok: true, message: 'Sent to 1 device' });
    }

    // target === 'bus'
    if (!busName) return res.status(400).json({ error: 'busName required when target=bus' });

    const riders = await usersCol()
      .find({ busIds: busName, notificationsEnabled: { $ne: false } })
      .toArray();

    const tokens = [];
    for (const r of riders) {
      for (const t of r.fcmTokens || []) {
        if (typeof t === 'string' && t && !tokens.includes(t)) tokens.push(t);
      }
    }

    if (!tokens.length) {
      return res.json({ ok: false, error: 'No riders with stored FCM tokens for this bus', riders: riders.length });
    }

    const msg = buildMessage({ ...payload, tokens });
    const result = await admin.messaging().sendEachForMulticast(msg);
    const dead = [];
    result.responses.forEach((r, i) => {
      const code = r.error?.code;
      if (r.error && (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token')) {
        dead.push(tokens[i]);
      }
    });
    if (dead.length) {
      await usersCol().updateMany(
        { fcmTokens: { $in: dead } },
        { $pull: { fcmTokens: { $in: dead } } }
      );
    }
    res.json({
      ok: true,
      successCount: result.successCount,
      failureCount: result.failureCount,
      riders: riders.length,
      prunedTokens: dead.length,
    });
  } catch (e) {
    console.error('/test-push/send error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
