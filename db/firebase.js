const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

let app;

function parseServiceAccountFromEnv(raw) {
  if (!raw) return null;

  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      if (parsed.private_key && typeof parsed.private_key === 'string') {
        parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
      }
      return parsed;
    }
  } catch (_) {}

  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (parsed.private_key && typeof parsed.private_key === 'string') {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }
    return parsed;
  } catch (_) {}

  throw new Error('FIREBASE_SERVICE_ACCOUNT no es un JSON válido ni un JSON en base64 válido.');
}

function resolveServiceAccount() {
  const fromEnv = parseServiceAccountFromEnv(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (fromEnv) {
    validateServiceAccount(fromEnv);
    return fromEnv;
  }

  const keyPath = path.join(__dirname, '..', 'serviceAccountKey.json');
  if (fs.existsSync(keyPath)) {
    const fileJson = require(keyPath);
    if (fileJson.private_key && typeof fileJson.private_key === 'string') {
      fileJson.private_key = fileJson.private_key.replace(/\\n/g, '\n');
    }
    return fileJson;
  }

  throw new Error(
    'No se encontró la credencial de Firebase. Define FIREBASE_SERVICE_ACCOUNT en .env o agrega serviceAccountKey.json en la raíz del proyecto.'
  );
}

function getFirebase() {
  if (app) return app;

  const serviceAccount = resolveServiceAccount();
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;

  app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    ...(storageBucket ? { storageBucket } : {})
  });

  return app;
}

function validateServiceAccount(raw) {
  if (!raw || typeof raw !== 'object' || !raw.private_key || !raw.client_email || !raw.project_id) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT debe ser un JSON válido con private_key, client_email y project_id.');
  }
}

function getFirestore() {
  getFirebase();
  return admin.firestore();
}

function getStorage() {
  getFirebase();
  return admin.storage().bucket();
}

module.exports = { getFirestore, getStorage };
