require('dotenv').config();

const express      = require('express');
const session      = require('express-session');
const { RedisStore } = require('connect-redis');
const { createClient } = require('redis');
const crypto       = require('crypto');
const os           = require('os');
const path         = require('path');
const fs           = require('fs');
const https        = require('https');
const http         = require('http');
const { initializeDB } = require('./db/database');
const { formatPrice }  = require('./middleware/helpers');

const app  = express();
const adminApp = express();
const adminApiApp = express();
const isProd = process.env.NODE_ENV === 'production';
if (isProd) {
  app.set('trust proxy', 1);
  adminApp.set('trust proxy', 1);
  adminApiApp.set('trust proxy', 1);
}

console.log('ADMIN_EMAIL:', process.env.ADMIN_EMAIL);
console.log('ADMIN_PASSWORD existe:', !!process.env.ADMIN_PASSWORD);
console.log('JWT_SECRET existe:', !!process.env.JWT_SECRET);
console.log('SESSION_SECRET existe:', !!process.env.SESSION_SECRET);

function ensureSecret(name, fallback) {
  const value = process.env[name];
  if (value && String(value).trim()) return value;
  if (isProd) {
    console.error(`❌ Falta ${name} en producción`);
    process.exit(1);
  }
  return fallback;
}

if (isProd) {
  const required = ['JWT_SECRET', 'SESSION_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('❌ Variables de entorno faltantes en producción:', missing.join(', '));
    process.exit(1);
  }
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

adminApp.set('view engine', 'ejs');
adminApp.set('views', path.join(__dirname, 'views'));
adminApp.locals.formatPrice = formatPrice;

function addSecurityHeaders(req, res, next) {
  // Eliminar huellas del servidor
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=()');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' cdn.jsdelivr.net cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' cdn.jsdelivr.net cdnjs.cloudflare.com fonts.googleapis.com; font-src 'self' fonts.gstatic.com cdnjs.cloudflare.com data:; img-src 'self' data: https: blob: storage.googleapis.com firebasestorage.googleapis.com; connect-src 'self' https://res.cloudinary.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none';"
  );
  // Sin caché en todas las rutas sensibles y en archivos JS
  if (
    req.originalUrl.startsWith('/admin') ||
    req.originalUrl.startsWith('/api/') ||
    req.originalUrl.endsWith('.js')
  ) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  if (isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  next();
}

app.use(addSecurityHeaders);
adminApp.use(addSecurityHeaders);
adminApiApp.use(addSecurityHeaders);

const _loginAttempts = new Map();
function rateLimit(key, max, windowMs) {
  return (req, res, next) => {
    const ip = key + (req.ip || req.connection.remoteAddress || 'unknown');
    const now = Date.now();
    const hits = (_loginAttempts.get(ip) || []).filter(t => now - t < windowMs);

    if (hits.length >= max) {
      return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
    }

    hits.push(now);
    _loginAttempts.set(ip, hits);
    next();
  };
}

const LOGIN_MAX_API   = 10;
const LOGIN_MAX_ADMIN = 5;
const LOGIN_WINDOW    = 15 * 60 * 1000;

adminApiApp.use('/auth/login', rateLimit('api_', LOGIN_MAX_API, LOGIN_WINDOW));
adminApp.use('/login', (req, res, next) =>
  req.method === 'POST'
    ? rateLimit('adm_', LOGIN_MAX_ADMIN, LOGIN_WINDOW)(req, res, next)
    : next()
);

setInterval(() => _loginAttempts.clear(), 60 * 60 * 1000);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));


app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProd ? '7d' : 0 }));

const adminSessionOptions = {
  store: new session.MemoryStore(),
  secret: ensureSecret('SESSION_SECRET', crypto.randomBytes(32).toString('hex')),
  resave: false,
  saveUninitialized: false,
  cookie: {
    name: 'admin_sid',
    path: '/admin',
    secure: isProd,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000
  }
};

if (process.env.REDIS_URL) {
  const redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', err => console.error('Redis error:', err));
  redisClient.connect().catch(err => {
    console.error('No se pudo conectar a Redis:', err.message);
    if (isProd) process.exit(1);
  });
  adminSessionOptions.store = new RedisStore({ client: redisClient, prefix: 'sess:' });
  console.log('✅ Redis session store enabled');
}

adminApiApp.use(express.json({ limit: '10mb' }));
adminApiApp.use(express.urlencoded({ extended: true, limit: '10mb' }));
adminApiApp.use(session(adminSessionOptions));

adminApp.use(express.json({ limit: '10mb' }));
adminApp.use(express.urlencoded({ extended: true, limit: '10mb' }));
adminApp.use(session(adminSessionOptions));

app.locals.formatPrice = formatPrice;

app.use('/api', adminApiApp);
adminApiApp.use('/', require('./routes/api'));
adminApiApp.use('/ramiro', require('./routes/ramiro'));
app.use('/admin', adminApp);
adminApp.use('/', require('./routes/admin'));
app.use('/', require('./routes/public'));

app.use((err, req, res, next) => {
  console.error(err.stack || err.message);
  res.status(500).send('Error interno del servidor');
});

initializeDB().then(() => {
  const HTTP_PORT  = parseInt(process.env.PORT, 10) || 3000;
  const HTTPS_PORT = parseInt(process.env.HTTPS_PORT, 10) || 3443;
  const LOCAL_IP   = process.env.LOCAL_IP || '192.168.1.244';

  const sslKey  = path.join(__dirname, 'ssl', 'key.pem');
  const sslCert = path.join(__dirname, 'ssl', 'cert.pem');
  const hasCerts = fs.existsSync(sslKey) && fs.existsSync(sslCert);

  if (hasCerts) {
    // ── Modo local: HTTPS con certificados propios + HTTP redirige ──────────
    const redirectApp = express();
    redirectApp.use((req, res) => {
      const host = (req.headers.host || LOCAL_IP).replace(/:\d+$/, '');
      res.redirect(301, `https://${host}:${HTTPS_PORT}${req.url}`);
    });
    http.createServer(redirectApp).listen(HTTP_PORT, '0.0.0.0', () => {
      console.log(`  ↪  HTTP  :${HTTP_PORT}  → redirige a HTTPS`);
    });

    const sslOptions = { key: fs.readFileSync(sslKey), cert: fs.readFileSync(sslCert) };
    https.createServer(sslOptions, app).listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`
  ╔══════════════════════════════════════════╗
  ║   MacStore + Firebase v2.0  (HTTPS)     ║
  ║   https://localhost:${HTTPS_PORT}            ║
  ║   https://${LOCAL_IP}:${HTTPS_PORT}       ║
  ║   Admin: https://${LOCAL_IP}:${HTTPS_PORT}/admin ║
  ╚══════════════════════════════════════════╝`);
    });

  } else {
    // ── Modo hosting: HTTP puro (el proveedor maneja SSL por su lado) ────────
    app.listen(HTTP_PORT, '0.0.0.0', () => {
      console.log(`
  ╔══════════════════════════════════════════╗
  ║   MacStore + Firebase v2.0              ║
  ║   http://localhost:${HTTP_PORT}              ║
  ║   (SSL gestionado por el proveedor)     ║
  ╚══════════════════════════════════════════╝`);
    });
  }
}).catch(err => {
  console.error('Error iniciando Firebase:', err.message);
  process.exit(1);
});
