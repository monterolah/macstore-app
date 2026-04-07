const jwt = require('jsonwebtoken');

function verifyAdminToken(token) {
  if (!process.env.JWT_SECRET) {
    throw new Error('Falta JWT_SECRET en variables de entorno');
  }
  return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
}

function isApiRequest(req) {
  return req.originalUrl.startsWith('/api/');
}

function requireAdmin(req, res, next) {
  const token = req.session?.adminToken;

  if (!token) {
    if (isApiRequest(req)) return res.status(401).json({ error: 'No autorizado' });
    return res.redirect('/admin/login');
  }

  try {
    req.admin = verifyAdminToken(token);
    next();
  } catch (_) {
    if (req.session) req.session.adminToken = null;
    if (isApiRequest(req)) return res.status(401).json({ error: 'Token inválido o expirado' });
    return res.redirect('/admin/login');
  }
}

function requireAdminAPI(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const authToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const sessionToken = req.session?.adminToken;
  const token = authToken || sessionToken;

  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    req.admin = verifyAdminToken(token);
    next();
  } catch (_) {
    if (req.session) req.session.adminToken = null;
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

module.exports = { requireAdmin, requireAdminAPI };
