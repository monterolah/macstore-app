const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { getFirestore } = require('../db/firebase');
const { requireAdmin } = require('../middleware/auth');
const router  = express.Router();
const fmt     = p => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(p||0);

function docToObj(doc) { return { id: doc.id, ...doc.data() }; }

function sortBySortOrder(items) {
  return [...items].sort((a, b) => {
    const av = Number.isFinite(Number(a?.sort_order)) ? Number(a.sort_order) : Number.MAX_SAFE_INTEGER;
    const bv = Number.isFinite(Number(b?.sort_order)) ? Number(b.sort_order) : Number.MAX_SAFE_INTEGER;
    if (av !== bv) return av - bv;
    return String(a?.name || '').localeCompare(String(b?.name || ''));
  });
}

async function getSiteData() {
  try {
    const doc = await getFirestore().collection('settings').doc('main').get();
    return doc.exists ? doc.data() : {};
  } catch(e) { return {}; }
}

async function getCategories() {
  try {
    const snap = await getFirestore()
      .collection('categories')
      .orderBy('sort_order','asc')
      .get();
    return snap.docs.map(docToObj).filter(c => c.active !== false);
  } catch(e) { return []; }
}

// ── GET LOGIN ──────────────────────────────────────────────────────────────
router.get('/login', async (req, res) => {
  const settings = await getSiteData();
  res.render('admin/login', { title:'Admin — MacStore', settings, categories:[], announcements:[], error:null });
});

// ── POST LOGIN ─────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const settings = await getSiteData();
  try {
    const { email, password } = req.body;
    const snap = await getFirestore().collection('admins').where('email','==',email).limit(1).get();
    const admin = snap.empty ? null : snap.docs[0].data();
    const validPassword = admin && bcrypt.compareSync(password, admin.password);
    if (!admin || !validPassword)
      return res.render('admin/login', { title:'Admin', settings, categories:[], announcements:[], error:'Credenciales incorrectas' });
    const token = jwt.sign({ id:snap.docs[0].id, email:admin.email, name:admin.name }, process.env.JWT_SECRET, { expiresIn:'8h' });
    req.session.adminToken = token;
    res.redirect('/admin');
  } catch(e) {
    console.error('Login error:', e.message);
    res.render('admin/login', { title:'Admin', settings, categories:[], announcements:[], error:'Error al iniciar sesión' });
  }
});

// ── LOGOUT ────────────────────────────────────────────────────────────────
router.get('/logout', (req, res) => { req.session.adminToken = null; res.redirect('/admin/login'); });

// ── DASHBOARD ─────────────────────────────────────────────────────────────
router.get('/', requireAdmin, async (req, res) => {
  const db    = getFirestore();
  const admin = req.admin || { name:'Admin', email:'' };

  const [settings, categories, pSnap, bSnap] = await Promise.all([
    getSiteData(),
    getCategories(),
    db.collection('products').get(),
    db.collection('banners').where('active','==',true).get()
  ]);

  const products = sortBySortOrder(pSnap.docs.map(docToObj));
  const stats = {
    products: pSnap.size,
    active:   products.filter(p => p.active !== false).length,
    banners:  bSnap.size,
  };
  const recentProducts = [...products].reverse().slice(0, 6);
  res.render('admin/dashboard', { title:'Dashboard — Admin', settings, categories, announcements:[], stats, token:req.session.adminToken, formatPrice:fmt, admin, recentProducts });
});

// ── PRODUCTS LIST ─────────────────────────────────────────────────────────
router.get('/productos', requireAdmin, async (req, res) => {
  const db    = getFirestore();
  const admin = req.admin || { name:'Admin', email:'' };
  const [settings, categories, snap] = await Promise.all([
    getSiteData(),
    getCategories(),
    db.collection('products').get()
  ]);
  const products = sortBySortOrder(snap.docs.map(docToObj));
  res.render('admin/products', { title:'Productos — Admin', settings, categories, announcements:[], products, token:req.session.adminToken, formatPrice:fmt, admin });
});

// ── NEW PRODUCT ───────────────────────────────────────────────────────────
router.get('/productos/nuevo', requireAdmin, async (req, res) => {
  const admin = req.admin || { name:'Admin', email:'' };
  const [settings, categories] = await Promise.all([getSiteData(), getCategories()]);
  res.render('admin/product-form', { title:'Nuevo producto', settings, categories, announcements:[], product:null, token:req.session.adminToken, admin });
});

// ── EDIT PRODUCT ──────────────────────────────────────────────────────────
router.get('/productos/:id/editar', requireAdmin, async (req, res) => {
  const db    = getFirestore();
  const admin = req.admin || { name:'Admin', email:'' };
  const [settings, categories, doc] = await Promise.all([
    getSiteData(),
    getCategories(),
    db.collection('products').doc(req.params.id).get()
  ]);
  if (!doc.exists) return res.redirect('/admin/productos');
  res.render('admin/product-form', { title:'Editar producto', settings, categories, announcements:[], product:docToObj(doc), token:req.session.adminToken, admin });
});

// ── CATEGORIAS ────────────────────────────────────────────────────────────
router.get('/categorias', requireAdmin, async (req, res) => {
  const db    = getFirestore();
  const admin = req.admin || { name:'Admin', email:'' };
  const [settings, categories, snap] = await Promise.all([
    getSiteData(),
    getCategories(),
    db.collection('categories').orderBy('sort_order','asc').get()
  ]);
  const cats = snap.docs.map(docToObj);
  res.render('admin/categories', { title:'Categorías — Admin', settings, categories, announcements:[], cats, token:req.session.adminToken, admin });
});

// ── BANNERS ───────────────────────────────────────────────────────────────
router.get('/banners', requireAdmin, async (req, res) => {
  const db    = getFirestore();
  const admin = req.admin || { name:'Admin', email:'' };
  const [settings, categories, snap] = await Promise.all([
    getSiteData(),
    getCategories(),
    db.collection('banners').orderBy('sort_order','asc').get()
  ]);
  const banners = snap.docs.map(docToObj);
  res.render('admin/banners', { title:'Banners — Admin', settings, categories, announcements:[], banners, token:req.session.adminToken, admin });
});

// ── ANUNCIOS ──────────────────────────────────────────────────────────────
router.get('/anuncios', requireAdmin, async (req, res) => {
  const db    = getFirestore();
  const admin = req.admin || { name:'Admin', email:'' };
  const [settings, categories, snap] = await Promise.all([
    getSiteData(),
    getCategories(),
    db.collection('announcements').orderBy('sort_order','asc').get()
  ]);
  const announcements = snap.docs.map(docToObj);
  res.render('admin/announcements', { title:'Anuncios — Admin', settings, categories, announcements, token:req.session.adminToken, admin });
});

// ── MÉTODOS DE PAGO ───────────────────────────────────────────────────────
router.get('/metodos-pago', requireAdmin, async (req, res) => {
  const db    = getFirestore();
  const admin = req.admin || { name:'Admin', email:'' };
  const [settings, categories, snap] = await Promise.all([
    getSiteData(),
    getCategories(),
    db.collection('payment_methods').orderBy('sort_order','asc').get()
  ]);
  const methods = snap.docs.map(docToObj);
  res.render('admin/payment-methods', { title:'Métodos de Pago — Admin', settings, categories, announcements:[], methods, token:req.session.adminToken, admin });
});

// ── NOTIFICACIONES / INGRESOS ─────────────────────────────────────────────
router.get('/notificaciones', requireAdmin, async (req, res) => {
  const db    = getFirestore();
  const admin = req.admin || { name:'Admin', email:'' };
  const [settings, categories, snap] = await Promise.all([
    getSiteData(),
    getCategories(),
    db.collection('inventory_entries').orderBy('createdAt','desc').limit(50).get()
  ]);
  const entries = snap.docs.map(docToObj);
  res.render('admin/notifications', { title:'Notificaciones — Admin', settings, categories, announcements:[], entries, token:req.session.adminToken, admin });
});

// ── COTIZACIONES ──────────────────────────────────────────────────────────
router.get('/cotizaciones', requireAdmin, async (req, res) => {
  const admin = req.admin || { name:'Admin', email:'' };
  const [settings, categories] = await Promise.all([getSiteData(), getCategories()]);
  res.render('admin/quotations', { title:'Cotizaciones — Admin', settings, categories, announcements:[], token:req.session.adminToken, admin });
});

// ── ASISTENTE IA ──────────────────────────────────────────────────────────
router.get('/asistente', requireAdmin, async (req, res) => {
  const admin = req.admin || { name:'Admin', email:'' };
  const [settings, categories] = await Promise.all([getSiteData(), getCategories()]);
  res.render('admin/gemini', { title:'Asistente IA — Admin', settings, categories, announcements:[], token:req.session.adminToken, admin });
});

// ── CONFIGURACIÓN ─────────────────────────────────────────────────────────
router.get('/configuracion', requireAdmin, async (req, res) => {
  const admin = req.admin || { name:'Admin', email:'' };
  const [settings, categories] = await Promise.all([getSiteData(), getCategories()]);
  res.render('admin/settings', { title:'Configuración — Admin', settings, categories, announcements:[], token:req.session.adminToken, admin });
});

module.exports = router;
