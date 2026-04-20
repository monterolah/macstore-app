const express = require('express');
const { getFirestore } = require('../db/firebase');
const { getCache, setCache } = require('../utils/cache');
const router  = express.Router();
const fmt     = p => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(p||0);

// ── Leer cookie sin cookie-parser ─────────────────────────────────────────
function getCookie(req, name) {
  const str = req.headers.cookie || '';
  const pair = str.split(';').find(c => c.trim().startsWith(name + '='));
  return pair ? decodeURIComponent(pair.split('=')[1].trim()) : null;
}

// ── Modo vendedor: inyectar en todas las respuestas ───────────────────────
router.use((req, res, next) => {
  res.locals.vendorMode = getCookie(req, 'vendorMode') === '1';
  next();
});

// ── Activar / desactivar modo tienda ─────────────────────────────────────
router.get('/tienda', (req, res) => {
  res.cookie('vendorMode', '1', { maxAge: 8 * 60 * 60 * 1000, sameSite: 'lax' });
  res.redirect('/');
});
router.get('/salir-tienda', (req, res) => {
  res.clearCookie('vendorMode');
  res.redirect('/');
});

// ── Helpers de query optimizados ──────────────────────────────────────────────

async function getSiteData() {
  if (getCache('settings')) return getCache('settings');
  const doc = await getFirestore().collection('settings').doc('main').get();
  const data = doc.exists ? doc.data() : {};
  setCache('settings', data);
  return data;
}

async function getCategories() {
  if (getCache('categories')) return getCache('categories');
  const snap = await getFirestore()
    .collection('categories')
    .where('active', '==', true)
    .orderBy('sort_order', 'asc')
    .get();
  const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  setCache('categories', data);
  return data;
}

async function getAnnouncements() {
  if (getCache('announcements')) return getCache('announcements');
  const snap = await getFirestore()
    .collection('announcements')
    .where('active', '==', true)
    .orderBy('sort_order', 'asc')
    .get();
  const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  setCache('announcements', data);
  return data;
}

function docToObj(doc) {
  return { id: doc.id, ...doc.data() };
}

// ── HOME ──────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const db = getFirestore();

    // Si banners y productos están en caché explícita para el home:
    let banners = getCache('homeBanners');
    let allProducts = getCache('homeProducts');
    const promises = [
      getSiteData(),
      getCategories(),
      !banners ? db.collection('banners').where('active', '==', true).orderBy('sort_order', 'asc').get() : Promise.resolve(null),
      !allProducts ? db.collection('products').where('active', '==', true).orderBy('sort_order', 'asc').get() : Promise.resolve(null),
      getAnnouncements()
    ];

    const [settings, categories, bannersSnap, productsSnap, announcements] = await Promise.all(promises);

    if (!banners) {
      banners = bannersSnap.docs.map(docToObj);
      setCache('homeBanners', banners);
    }
    if (!allProducts) {
      allProducts = productsSnap.docs.map(docToObj);
      setCache('homeProducts', allProducts);
    }
    const featured    = allProducts.filter(p => p.featured);
    // Productos no destacados para el catálogo general
    const nonFeatured = allProducts.filter(p => !p.featured);

    // Solo mostrar categorías que tienen productos (o forzadas)
    const activeCatSlugs = new Set(allProducts.map(p => p.category));
    const visibleCats    = categories.filter(c => c.force_show || activeCatSlugs.has(c.slug));

    res.render('home', {
      req, announcements,
      title: settings.store_name || 'MacStore',
      description: settings.store_tagline || '',
      settings, categories: visibleCats, banners, featured, products: nonFeatured, formatPrice: fmt
    });
  } catch (e) { console.error(e); res.status(500).send('Error interno del servidor'); }
});

// ── CATEGORY ──────────────────────────────────────────────────────────────────
router.get('/categoria/:slug', async (req, res) => {
  try {
    const db   = getFirestore();
    const slug = req.params.slug;

    // Query de productos filtrada por categoría directamente en Firestore
    const [settings, categories, productsSnap, announcements] = await Promise.all([
      getSiteData(),
      getCategories(),
      db.collection('products')
        .where('active', '==', true)
        .where('category', '==', slug)
        .get(),
      getAnnouncements()
    ]);

    const category = categories.find(c => c.slug === slug);
    if (!category) return res.status(404).render('404', { title: 'No encontrado', description: '', settings, categories, announcements });

    const products = productsSnap.docs.map(docToObj).sort((a, b) => (b.sort_order || 0) - (a.sort_order || 0));
    res.render('category', { req, title: category.name, description: category.description || '', settings, categories, category, products, announcements, formatPrice: fmt });
  } catch (e) { console.error(e); res.status(500).send('Error interno del servidor'); }
});

// ── PRODUCT ───────────────────────────────────────────────────────────────────
router.get('/producto/:slug', async (req, res) => {
  try {
    const db   = getFirestore();
    const slug = req.params.slug;

    // Buscar producto por slug sin traer toda la colección
    const [settings, categories, productSnap, announcements] = await Promise.all([
      getSiteData(),
      getCategories(),
      db.collection('products').where('slug', '==', slug).where('active', '==', true).limit(1).get(),
      getAnnouncements()
    ]);

    if (productSnap.empty) return res.status(404).render('404', { title: 'No encontrado', description: '', settings, categories, announcements });

    const product = docToObj(productSnap.docs[0]);

    // Productos relacionados: misma categoría, máximo 4
    const relatedSnap = await db.collection('products')
      .where('active', '==', true)
      .where('category', '==', product.category)
      .limit(5)
      .get();

    const related = relatedSnap.docs.map(docToObj).filter(p => p.id !== product.id).slice(0, 4);

    res.render('product', { req, title: product.name, description: product.description || '', settings, categories, product, related, announcements, formatPrice: fmt });
  } catch (e) { console.error(e); res.status(500).send('Error interno del servidor'); }
});

// ── CATALOG ───────────────────────────────────────────────────────────────────
router.get('/productos', async (req, res) => {
  try {
    const db  = getFirestore();
    const cat = req.query.cat;

    // Si hay filtro de categoría, query directa; si no, todos activos
    let productsQuery = db.collection('products').where('active', '==', true).orderBy('sort_order', 'asc');
    if (cat) productsQuery = productsQuery.where('category', '==', cat);

    const [settings, categories, productsSnap, announcements] = await Promise.all([
      getSiteData(),
      getCategories(),
      productsQuery.get(),
      getAnnouncements()
    ]);

    let products = productsSnap.docs.map(docToObj);
    const q = (req.query.q || '').trim().toLowerCase();
    if (q) {
      products = products.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q) ||
        (p.category || '').toLowerCase().includes(q) ||
        (p.badge || '').toLowerCase().includes(q)
      );
    }
    res.render('catalog', { req, title: q ? `Búsqueda: ${req.query.q}` : 'Catálogo', description: 'Todos los productos Apple disponibles', settings, categories, products, announcements, formatPrice: fmt, searchQuery: req.query.q || '' });
  } catch (e) { console.error(e); res.status(500).send('Error interno del servidor'); }
});

module.exports = router;
