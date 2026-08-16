require('dotenv').config();

let admin = null;
let initError = null;

// Lazy-initialize the default Firebase app once. Returns null on any failure
// and records the reason in getInitError().
function getAdmin() {
  if (admin) return admin;
  try {
    const serviceAccountJson = process.env.FCM_SERVICE_ACCOUNT;
    if (!serviceAccountJson) {
      initError = 'FCM_SERVICE_ACCOUNT env not set';
      return null;
    }
    const mod = require('firebase-admin');
    if (!mod.apps.length) {
      mod.initializeApp({
        credential: mod.credential.cert(JSON.parse(serviceAccountJson)),
      });
    }
    admin = mod;
    initError = null;
    console.log('Firebase Admin initialized for FCM push');
    return admin;
  } catch (e) {
    admin = null;
    initError = e.message;
    console.error('Firebase Admin init failed:', e.message);
    return null;
  }
}

function getInitError() {
  return initError;
}

module.exports = { getAdmin, getInitError };