'use strict';

const { getFirestore } = require('../../db/firebase');

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const ALLOWED_CATEGORIES = new Set(['mac', 'iphone', 'ipad', 'airpods']);
const ALLOWED_UPDATE_FIELDS = ['price', 'active', 'description', 'variants', 'color_variants', 'stock', 'specs', 'badge', 'image_url'];

/**
 * Busca productos aplicando filtros simples en memoria (después de un get() sin orderBy).
 */
async function searchProducts(filters = {}) {
  const db = getFirestore();
  const snap = await db.collection('products').get();
  let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (typeof filters.active === 'boolean') {
    results = results.filter(p => (p.active !== false) === filters.active);
  }
  if (typeof filters.hasImage === 'boolean') {
    results = results.filter(p => {
      const has = Boolean(p.image_url && String(p.image_url).trim());
      return has === filters.hasImage;
    });
  }
  if (filters.category) {
    results = results.filter(p => p.category === filters.category);
  }
  if (filters.nameContains) {
    const q = String(filters.nameContains).toLowerCase();
    results = results.filter(p => String(p.name || '').toLowerCase().includes(q));
  }
  return results.slice(0, 80);
}

/**
 * Crea un producto en Firestore.
 */
async function createProduct(payload) {
  const db = getFirestore();
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('Falta nombre del producto');

  const category = ALLOWED_CATEGORIES.has(String(payload.category || '').toLowerCase())
    ? String(payload.category).toLowerCase()
    : 'mac';

  const price = Number(payload.price);

  const doc = {
    name,
    slug: payload.slug || slugify(name),
    category,
    price: Number.isFinite(price) && price > 0 ? price : 1,
    description: String(payload.description || `${name} disponible en MacStore.`).slice(0, 2000),
    active: payload.active !== false,
    stock: Number(payload.stock) || 0,
    sort_order: Number(payload.sort_order) || 0,
    image_url: String(payload.image_url || ''),
    color_variants: Array.isArray(payload.color_variants) ? payload.color_variants : [],
    variants: Array.isArray(payload.variants) ? payload.variants : [],
    specs: (payload.specs && typeof payload.specs === 'object') ? payload.specs : {},
    badge: String(payload.badge || ''),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const ref = await db.collection('products').add(doc);
  return { id: ref.id, ...doc };
}

/**
 * Actualiza campos de un producto. Solo permite ALLOWED_UPDATE_FIELDS.
 */
async function updateProduct(productId, updates = {}) {
  if (!productId) throw new Error('Falta productId');
  const db = getFirestore();
  const filtered = {};
  for (const k of ALLOWED_UPDATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(updates, k)) filtered[k] = updates[k];
  }
  if (!Object.keys(filtered).length) throw new Error('No hay campos válidos para actualizar');
  filtered.updatedAt = new Date();
  await db.collection('products').doc(productId).update(filtered);
  return { ok: true, productId, updated: Object.keys(filtered) };
}

/**
 * Oculta (desactiva) un producto.
 */
async function hideProduct(productId) {
  return updateProduct(productId, { active: false });
}

/**
 * Activa un producto.
 */
async function showProduct(productId) {
  return updateProduct(productId, { active: true });
}

/**
 * Elimina un producto permanentemente.
 */
async function deleteProduct(productId) {
  if (!productId) throw new Error('Falta productId');
  const db = getFirestore();
  await db.collection('products').doc(productId).delete();
  return { ok: true, productId };
}

/**
 * Elimina en lote productos sin imagen.
 */
async function bulkDeleteWithoutImage() {
  const db = getFirestore();
  const snap = await db.collection('products').get();
  const withoutImage = snap.docs.filter(d => {
    const img = d.data().image_url;
    return !img || !String(img).trim();
  });
  const batch = db.batch();
  withoutImage.forEach(d => batch.delete(d.ref));
  await batch.commit();
  return { ok: true, deletedCount: withoutImage.length };
}

/**
 * Importa/sincroniza un array de productos desde scraping externo.
 * Usa slug como clave de deduplicación.
 */
async function syncProductsFromArray(rawProducts, sourceUrl = '') {
  const db = getFirestore();
  const snap = await db.collection('products').get();
  const existingBySlug = new Map(snap.docs.map(d => [d.data().slug, { id: d.id, ...d.data() }]));

  let created = 0;
  let updated = 0;

  for (const p of rawProducts) {
    const name = String(p.name || '').trim();
    if (!name) continue;
    const slug = slugify(name);
    const category = ALLOWED_CATEGORIES.has(String(p.category || '').toLowerCase())
      ? String(p.category).toLowerCase()
      : 'mac';
    const price = Number(p.price);
    const payload = {
      name, slug, category,
      price: Number.isFinite(price) && price > 0 ? price : 1,
      description: String(p.description || `${name} disponible en MacStore.`).slice(0, 2000),
      image_url: String(p.image || p.image_url || ''),
      variants: Array.isArray(p.variants) ? p.variants : [],
      specs: (p.specs && typeof p.specs === 'object') ? p.specs : {},
      active: true,
      updatedAt: new Date(),
      ficha: { notas: `Sincronizado desde ${sourceUrl}` },
    };

    const existing = existingBySlug.get(slug);
    if (existing) {
      await db.collection('products').doc(existing.id).update(payload);
      updated++;
    } else {
      await db.collection('products').add({ ...payload, stock: 0, sort_order: 0, createdAt: new Date() });
      created++;
    }
  }

  return { ok: true, created, updated, total: rawProducts.length };
}

module.exports = {
  searchProducts,
  createProduct,
  updateProduct,
  hideProduct,
  showProduct,
  deleteProduct,
  bulkDeleteWithoutImage,
  syncProductsFromArray,
};
