require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const router = express.Router();

// ---- Mongo collections (direct driver access, consistent with index.js) ----
const usersCol = () => mongoose.connection.collection('users');
const requestsCol = () => mongoose.connection.collection('requests');
const responsesCol = () => mongoose.connection.collection('responses');
const checkinsCol = () => mongoose.connection.collection('checkins');
const busesCol = () => mongoose.connection.collection('buses');

const BUS_DATA_URL = 'https://shahriar-h.github.io/jnu-bus-app-ads/data2.json';

const SECRET = process.env.JWT_SECRET || 'mysecretkey';

// Google OAuth client IDs this app is allowed to accept. Override via env if needed.
const GOOGLE_CLIENT_IDS = (
  process.env.GOOGLE_CLIENT_IDS ||
  '610416669780-nie8aeb7r04852iramlnrsftl7f9dglg.apps.googleusercontent.com,' +
    '610416669780-adtshtts0vo3b2bbv2k9hkus57vm2r3g.apps.googleusercontent.com'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const REQUEST_TTL_MS = 60 * 60 * 1000; // 60 minutes
const CHECKIN_TTL_MS = 60 * 60 * 1000; // 60 minutes

// ---- Firebase Admin (used only for FCM push) ----
let admin = null;
try {
  const serviceAccountJson = process.env.FCM_SERVICE_ACCOUNT;
  if (serviceAccountJson) {
    admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
      });
    }
    console.log('Firebase Admin initialized for FCM push');
  } else {
    console.warn('FCM_SERVICE_ACCOUNT not set — bus request push notifications disabled');
  }
} catch (e) {
  console.error('Firebase Admin init failed:', e.message);
}

// Send a direct FCM push to every rider of the given bus (their stored device tokens).
// The requester's own devices are excluded so they don't get a notification about their own ask.
async function pushToBusRiders(busName, payload, excludeEmail) {
  if (!admin) return;
  let riders;
  try {
    riders = await usersCol()
      .find({ busIds: busName, notificationsEnabled: { $ne: false } })
      .toArray();
  } catch (e) {
    console.error('pushToBusRiders query failed:', e.message);
    return;
  }

  const tokens = [];
  for (const rider of riders) {
    if (excludeEmail && rider.email === excludeEmail) continue;
    for (const t of rider.fcmTokens || []) {
      if (typeof t === 'string' && t && !tokens.includes(t)) tokens.push(t);
    }
  }
  if (!tokens.length) {
    console.log('pushToBusRiders: no tokens for bus', busName);
    return;
  }

  const message = {
    tokens,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: {
      type: 'bus_request',
      reqId: payload.reqId,
      busId: payload.busId,
      busName: payload.busName,
      requesterEmail: payload.requesterEmail || '',
      requesterName: payload.requesterName || '',
    },
    android: {
      priority: 'high',
      notification: { priority: 'high', channelId: 'default' },
    },
  };

  try {
    const res = await admin.messaging().sendEachForMulticast(message);
    console.log('FCM multicast:', res.successCount, 'ok /', res.failureCount, 'failed');
    if (res.failureCount > 0) {
      const dead = new Set();
      res.responses.forEach((r, i) => {
        const code = r.error?.code;
        if (
          r.error &&
          (code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token')
        ) {
          dead.add(tokens[i]);
        }
      });
      if (dead.size) await pruneTokens(dead);
    }
  } catch (e) {
    console.error('FCM multicast failed:', e.message);
  }
}

async function pruneTokens(deadTokens) {
  try {
    await usersCol().updateMany(
      { fcmTokens: { $in: [...deadTokens] } },
      { $pull: { fcmTokens: { $in: [...deadTokens] } } }
    );
  } catch (e) {
    console.error('pruneTokens failed:', e.message);
  }
}

// ---- Helpers ----
function publicUser(user) {
  return {
    email: user.email,
    name: user.name || '',
    picture: user.picture || '',
    phone: user.phone || '',
    department: user.department || '',
    session: user.session || '',
    busIds: Array.isArray(user.busIds) ? user.busIds : [],
    notificationsEnabled: user.notificationsEnabled !== false,
  };
}

async function verifyGoogleToken(accessToken) {
  const { data } = await axios.get('https://oauth2.googleapis.com/tokeninfo', {
    params: { access_token: accessToken },
    timeout: 10000,
  });
  if (!data || data.email_verified !== 'true') {
    throw new Error('Google email not verified');
  }
  if (!GOOGLE_CLIENT_IDS.includes(data.aud)) {
    throw new Error('Invalid audience');
  }
  return data;
}

async function getOrCreateUser(info) {
  const col = usersCol();
  let user = await col.findOne({ email: info.email });
  if (!user) {
    const doc = {
      email: info.email,
      name: info.name || '',
      picture: info.picture || '',
      googleId: info.sub || '',
      phone: '',
      department: '',
      session: '',
      busIds: [],
      fcmTokens: [],
      notificationsEnabled: true,
      createdAt: new Date(),
    };
    const res = await col.insertOne(doc);
    user = { ...doc, _id: res.insertedId };
  } else {
    const patch = {};
    if (!user.name && info.name) patch.name = info.name;
    if (!user.picture && info.picture) patch.picture = info.picture;
    if (!user.googleId && info.sub) patch.googleId = info.sub;
    if (Object.keys(patch).length) {
      await col.updateOne({ email: info.email }, { $set: patch });
      Object.assign(user, patch);
    }
  }
  return user;
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, SECRET);
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Does this user have the bus (by name) in their profile's busIds?
function isBusMember(user, busName) {
  if (!user || !busName) return false;
  return Array.isArray(user.busIds) && user.busIds.includes(busName);
}

// Convert a busId slug ("bus_<encodedName>") back to the display name
function busNameFromId(busId) {
  if (!busId || !String(busId).startsWith('bus_')) return String(busId || '');
  try {
    return decodeURIComponent(String(busId).slice(4));
  } catch (e) {
    return String(busId).slice(4);
  }
}

// ---- Bus list stored in DB, fetched by the app ----
router.get('/buses', async (req, res) => {
  try {
    let buses = await busesCol().find({}).sort({ order: 1 }).toArray();
    if (!buses.length) {
      const { data } = await axios.get(BUS_DATA_URL, { timeout: 15000 });
      const list = data?.data || [];
      if (list.length) {
        const docs = list.map((b, i) => ({ ...b, order: i, updatedAt: new Date() }));
        await busesCol().deleteMany({});
        await busesCol().insertMany(docs);
        buses = docs;
      }
    }
    res.json({ data: buses.map(({ _id, ...b }) => b) });
  } catch (e) {
    console.error('/buses error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---- Google sign-in -> backend JWT ----
router.post('/auth/google', async (req, res) => {
  try {
    const accessToken = req.body?.accessToken;
    if (!accessToken) return res.status(400).json({ error: 'Missing accessToken' });

    const info = await verifyGoogleToken(accessToken);
    const user = await getOrCreateUser(info);
    const token = jwt.sign({ id: String(user._id), email: user.email }, SECRET, {
      expiresIn: '30d',
    });

    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error('/auth/google error:', e.message);
    res.status(401).json({ error: e.message || 'Google authentication failed' });
  }
});

// ---- Update own profile (bus membership drives topic subscriptions) ----
router.post('/users/me', authRequired, async (req, res) => {
  try {
    const { email } = req.user;
    const body = req.body || {};
    const allowed = {};
    for (const k of ['name', 'phone', 'department', 'session', 'notificationsEnabled']) {
      if (body[k] !== undefined) allowed[k] = body[k];
    }
    if (Array.isArray(body.busIds)) allowed.busIds = [...new Set(body.busIds)];

    await usersCol().updateOne({ email }, { $set: { ...allowed, updatedAt: new Date() } });

    const user = await usersCol().findOne({ email });
    res.json({ user: publicUser(user) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Register/update this user's FCM device token(s) for direct push ----
router.post('/users/me/token', authRequired, async (req, res) => {
  try {
    const { email } = req.user;
    const fcmToken = typeof req.body?.fcmToken === 'string' ? req.body.fcmToken.trim() : '';
    if (!fcmToken) return res.status(400).json({ error: 'Missing fcmToken' });

    const user = await usersCol().findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const current = Array.isArray(user.fcmTokens) ? user.fcmTokens : [];
    const next = [fcmToken, ...current.filter((t) => t !== fcmToken)].slice(0, 5);
    await usersCol().updateOne({ email }, { $set: { fcmTokens: next, updatedAt: new Date() } });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.post('/bus/ask', authRequired, async (req, res) => {
  try {
    const { email, name } = req.user;
    const { busId, busName, getLocation = true, getPlan = true, note = '' } = req.body || {};
    if (!busId || !busName) return res.status(400).json({ error: 'Missing busId or busName' });

    const user = await usersCol().findOne({ email });

    const reqId = 'req_' + crypto.randomUUID();
    const now = new Date();
    const doc = {
      reqId,
      busId,
      busName,
      requesterEmail: email,
      requesterName: user?.name || name || email,
      getLocation: !!getLocation,
      getPlan: !!getPlan,
      note,
      status: 'active',
      createdAt: now,
      expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
    };
    await requestsCol().insertOne(doc);

    await pushToBusRiders(busName, {
      reqId,
      busId,
      busName,
      requesterEmail: email,
      requesterName: doc.requesterName,
      title: `${doc.requesterName} is asking about ${busName} bus`,
      body: 'Tap to help by sharing your location or where the bus is now.',
    }, email);

    res.json({ reqId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Respond to a request (GPS location or "bus at stop" plan) ----
router.post('/bus/respond', authRequired, async (req, res) => {
  try {
    const { email, name } = req.user;
    const { reqId, type, lat, lng, stopName, onBus, note } = req.body || {};
    if (!reqId || !type || !['location', 'plan'].includes(type)) {
      return res.status(400).json({ error: 'Missing reqId or valid type' });
    }
    if (type === 'location' && (typeof lat !== 'number' || typeof lng !== 'number')) {
      return res.status(400).json({ error: 'lat/lng required for location response' });
    }
    if (type === 'plan' && !stopName) {
      return res.status(400).json({ error: 'stopName required for plan response' });
    }

    const request = await requestsCol().findOne({ reqId });
    if (!request || request.status !== 'active' || request.expiresAt < new Date()) {
      return res.status(400).json({ error: 'Request is no longer active' });
    }

    const user = await usersCol().findOne({ email });
    if (!isBusMember(user, request.busName)) {
      return res.status(403).json({ error: 'Only riders of this bus can share its location' });
    }

    const doc = {
      reqId,
      email,
      responderName: user?.name || name || email,
      type,
      lat: typeof lat === 'number' ? lat : null,
      lng: typeof lng === 'number' ? lng : null,
      stopName: stopName || null,
      onBus: !!onBus,
      note: note || '',
      createdAt: new Date(),
      expiresAt: request.expiresAt,
    };

    await responsesCol().updateOne(
      { reqId, email },
      { $set: doc },
      { upsert: true }
    );

    res.json({ message: 'Response saved' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Active requests for a bus (used by the app for foreground detection) ----
router.get('/bus/requests/active', authRequired, async (req, res) => {
  try {
    const { busId } = req.query;
    if (!busId) return res.status(400).json({ error: 'Missing busId' });

    const user = await usersCol().findOne({ email: req.user.email });
    if (!isBusMember(user, busNameFromId(busId))) {
      return res.json({ requests: [] });
    }

    const docs = await requestsCol()
      .find({ busId, status: 'active', expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();

    const requests = await Promise.all(
      docs.map(async (d) => {
        const responded = await responsesCol().countDocuments({ reqId: d.reqId });
        const respondedByMe = await responsesCol().countDocuments({ reqId: d.reqId, email: req.user.email });
        return {
          reqId: d.reqId,
          busId: d.busId,
          busName: d.busName,
          requesterName: d.requesterName,
          requesterEmail: d.requesterEmail,
          note: d.note,
          getLocation: d.getLocation,
          getPlan: d.getPlan,
          createdAt: d.createdAt,
          expiresAt: d.expiresAt,
          responded,
          respondedByMe: respondedByMe > 0,
        };
      })
    );

    res.json({ requests });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Request detail + all responses (requester polling) ----
router.get('/bus/requests/:reqId', authRequired, async (req, res) => {
  try {
    const { reqId } = req.params;
    const request = await requestsCol().findOne({ reqId });
    if (!request) return res.status(404).json({ error: 'Request not found' });

    const responses = await responsesCol()
      .find({ reqId, expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      request: {
        reqId: request.reqId,
        busId: request.busId,
        busName: request.busName,
        requesterName: request.requesterName,
        requesterEmail: request.requesterEmail,
        note: request.note,
        status: request.expiresAt < new Date() ? 'expired' : request.status,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
      },
      responses,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Passive sharing: "I'm on this bus" ----
router.post('/bus/checkin', authRequired, async (req, res) => {
  try {
    const { email, name } = req.user;
    const { busId, type, lat, lng, stopName, note } = req.body || {};
    if (!busId || !['gps', 'stop'].includes(type)) {
      return res.status(400).json({ error: 'Missing busId or valid type' });
    }
    if (type === 'gps' && (typeof lat !== 'number' || typeof lng !== 'number')) {
      return res.status(400).json({ error: 'lat/lng required for gps checkin' });
    }
    if (type === 'stop' && !stopName) {
      return res.status(400).json({ error: 'stopName required for stop checkin' });
    }

    const user = await usersCol().findOne({ email });
    if (!isBusMember(user, busNameFromId(busId))) {
      return res.status(403).json({ error: 'Only riders of this bus can share its location' });
    }

    const doc = {
      email,
      name: user?.name || name || email,
      busId,
      type,
      lat: typeof lat === 'number' ? lat : null,
      lng: typeof lng === 'number' ? lng : null,
      stopName: stopName || null,
      note: note || '',
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + CHECKIN_TTL_MS),
    };

    await checkinsCol().updateOne({ email, busId }, { $set: doc }, { upsert: true });

    res.json({ message: 'Sharing active' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/bus/checkin', authRequired, async (req, res) => {
  try {
    const { busId } = req.body || {};
    if (!busId) return res.status(400).json({ error: 'Missing busId' });
    await checkinsCol().deleteOne({ email: req.user.email, busId });
    res.json({ message: 'Sharing stopped' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- All active shares for a bus ----
router.get('/bus/checkins', authRequired, async (req, res) => {
  try {
    const { busId } = req.query;
    if (!busId) return res.status(400).json({ error: 'Missing busId' });

    const checkins = await checkinsCol()
      .find({ busId, expiresAt: { $gt: new Date() } })
      .sort({ updatedAt: -1 })
      .toArray();

    res.json({ checkins });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;