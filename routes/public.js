const express = require('express');
const { getFirestore } = require('../db/firebase');
const router  = express.Router();
const fmt     = p => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(p||0);

// ── Helpers de query optimizados ──────────────────────────────────────────────

async function getSiteData() {
  const doc = await getFirestore().collection('settings').doc('main').get();
  return doc.exists ? doc.data() : {};
}

async function getCategories() {
  const snap = await getFirestore()
    .collection('categories')
    .where('active', '==', true)
    .orderBy('sort_order', 'asc')
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getAnnouncements() {
  const snap = await getFirestore()
    .collection('announcements')
    .where('active', '==', true)
    .orderBy('sort_order', 'asc')
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

function docToObj(doc) {
  return { id: doc.id, ...doc.data() };
}

// ── HOME ──────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const db = getFirestore();

    // Todo en paralelo — 4 queries simultáneas en vez de 4 en serie
    const [settings, categories, bannersSnap, productsSnap, announcements] = await Promise.all([
      getSiteData(),
      getCategories(),
      db.collection('banners').where('active', '==', true).orderBy('sort_order', 'asc').get(),
      db.collection('products').where('active', '==', true).orderBy('sort_order', 'asc').get(),
      getAnnouncements()
    ]);

    const banners     = bannersSnap.docs.map(docToObj);
    const allProducts = productsSnap.docs.map(docToObj);
    const featured    = allProducts.filter(p => p.featured);

    // Solo mostrar categorías que tienen productos (o forzadas)
    const activeCatSlugs = new Set(allProducts.map(p => p.category));
    const visibleCats    = categories.filter(c => c.force_show || activeCatSlugs.has(c.slug));

    res.render('home', {
      req, announcements,
      title: settings.store_name || 'MacStore',
      description: settings.store_tagline || '',
      settings, categories: visibleCats, banners, featured, formatPrice: fmt
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
        .orderBy('sort_order', 'asc')
        .get(),
      getAnnouncements()
    ]);

    const category = categories.find(c => c.slug === slug);
    if (!category) return res.status(404).render('404', { title: 'No encontrado', description: '', settings, categories, announcements });

    const products = productsSnap.docs.map(docToObj);
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

    const products = productsSnap.docs.map(docToObj);
    res.render('catalog', { req, title: 'Catálogo', description: 'Todos los productos Apple disponibles', settings, categories, products, announcements, formatPrice: fmt });
  } catch (e) { console.error(e); res.status(500).send('Error interno del servidor'); }
});

module.exports = router;
