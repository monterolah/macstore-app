const functions = require('firebase-functions');
require('dotenv').config();
const path = require('path');

const express          = require('express');
const session          = require('express-session');
const RedisStore       = require('connect-redis')(session);
const { createClient } = require('redis');
const { initializeDB } = require('../db/database');
const { formatPrice }  = require('../middleware/helpers');

const publicApp = express();
const adminApp = express();
const adminApiApp = express();
const isProd = process.env.NODE_ENV === 'production';
if (isProd) {
  publicApp.set('trust proxy', 1);
  adminApp.set('trust proxy', 1);
  adminApiApp.set('trust proxy', 1);
}

publicApp.set('view engine', 'ejs');
publicApp.set('views', path.join(__dirname, '../views'));

adminApp.set('view engine', 'ejs');
adminApp.set('views', path.join(__dirname, '../views'));
adminApp.locals.formatPrice = formatPrice;

publicApp.use(express.json({ limit: '50mb' }));
publicApp.use(express.urlencoded({ extended: true, limit: '50mb' }));
publicApp.use(express.static(path.join(__dirname, '../public')));

const SESSION_SECRET = process.env.SESSION_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;
if (isProd) {
  if (!SESSION_SECRET) throw new Error('Falta SESSION_SECRET en las variables de entorno de funciones.');
  if (!JWT_SECRET) throw new Error('Falta JWT_SECRET en las variables de entorno de funciones.');
}
if (!SESSION_SECRET) console.warn('⚠️ WARNING: define SESSION_SECRET para funciones.');
if (!JWT_SECRET) console.warn('⚠️ WARNING: define JWT_SECRET para funciones.');

const adminSessionOptions = {
  store: undefined,
  secret: SESSION_SECRET || JWT_SECRET || 'dev-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { name: 'admin_sid', path: '/admin', secure: isProd, httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }
};

if (process.env.REDIS_URL) {
  const redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', err => console.error('Redis error:', err));
  redisClient.connect().catch(err => {
    console.error('No se pudo conectar a Redis:', err.message);
    if (isProd) throw err;
  });
  adminSessionOptions.store = new RedisStore({ client: redisClient, prefix: 'sess:' });
  console.log('✅ Redis session store enabled for functions');
}

adminApp.use(express.json({ limit: '50mb' }));
adminApp.use(express.urlencoded({ extended: true, limit: '50mb' }));
adminApp.use(session(adminSessionOptions));

adminApiApp.use(express.json({ limit: '50mb' }));
adminApiApp.use(express.urlencoded({ extended: true, limit: '50mb' }));
adminApiApp.use(session(adminSessionOptions));

publicApp.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  if (req.originalUrl.startsWith('/admin') || req.originalUrl.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  }
  next();
});

adminApp.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  if (req.originalUrl.startsWith('/admin') || req.originalUrl.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  }
  next();
});

adminApiApp.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  if (req.originalUrl.startsWith('/admin') || req.originalUrl.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  }
  next();
});

publicApp.locals.formatPrice = formatPrice;

publicApp.use('/api', adminApiApp);
publicApp.use('/admin', adminApp);
publicApp.use('/', require('../routes/public'));
adminApp.use('/', require('../routes/admin'));
adminApiApp.use('/', require('../routes/api'));

publicApp.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).send('Error: ' + err.message);
});

let initialized = false;
const wrappedApp = async (req, res) => {
  if (!initialized) {
    await initializeDB();
    initialized = true;
  }
  publicApp(req, res);
};

exports.api = functions.https.onRequest(wrappedApp);
