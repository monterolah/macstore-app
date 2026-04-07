const ExcelJS = require('exceljs');
const { getFirestore } = require('../db/firebase');
const { slugify } = require('../middleware/helpers');

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1','true','si','sí','yes','activo','visible','on'].includes(v)) return true;
  if (['0','false','no','inactivo','oculto','off'].includes(v)) return false;
  return fallback;
}

function normalizeNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number') return value;
  const cleaned = String(value).replace(/[,$\s]/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : fallback;
}

function inferCategoryFromText(text, fallback = 'accesorios') {
  const value = slugify(text || '');
  if (!value) return fallback;
  if (/macbook|imac|mac-mini|mac-studio|studio-display|pro-display|display/.test(value)) return 'mac';
  if (/iphone|magsafe-iphone/.test(value)) return 'iphone';
  if (/ipad|magic-keyboard-for-ipad|apple-pencil/.test(value)) return 'ipad';
  if (/watch|apple-watch/.test(value)) return 'apple-watch';
  if (/airpods|beats/.test(value)) return 'airpods';
  if (/cable|charger|cargador|adaptador|case|funda|keyboard|mouse|trackpad|hub|correa|band|accessor/.test(value)) return 'accesorios';
  return fallback;
}

async function loadCategoriesMap(db) {
  const snap = await db.collection('categories').get();
  const bySlug = new Map();
  const byName = new Map();
  snap.docs.forEach(doc => {
    const data = doc.data() || {};
    const slug = normalizeText(data.slug || '').toLowerCase();
    const name = normalizeText(data.name || '').toLowerCase();
    const obj = { id: doc.id, ...data };
    if (slug) bySlug.set(slug, obj);
    if (name) byName.set(name, obj);
  });
  return { bySlug, byName };
}

async function ensureCategory(db, rawCategory, categoriesMap, fallbackText = '') {
  const preferred = normalizeText(rawCategory) || inferCategoryFromText(fallbackText, 'accesorios');
  const categoryName = normalizeText(preferred) || 'Accesorios';
  const categorySlug = slugify(categoryName);
  const existing = categoriesMap.bySlug.get(categorySlug) || categoriesMap.byName.get(categoryName.toLowerCase());
  if (existing) return existing.slug || categorySlug;
  const payload = { name: categoryName, slug: categorySlug, description: '', sort_order: 0, active: true, createdAt: new Date() };
  const ref = await db.collection('categories').add(payload);
  const created = { id: ref.id, ...payload };
  categoriesMap.bySlug.set(categorySlug, created);
  categoriesMap.byName.set(categoryName.toLowerCase(), created);
  return categorySlug;
}

function rowToCatalogProduct(row, categorySlug, existingDoc = null) {
  const name = normalizeText(row['Nombre']);
  if (!name) return null;
  const shortDesc   = normalizeText(row['Descripción corta']);
  const longDesc    = normalizeText(row['Descripción larga']);
  const price       = normalizeNumber(row['Precio'], existingDoc?.price || 0);
  const originalPrice = normalizeNumber(row['Precio oferta'], 0);
  const visible     = normalizeBool(row['Visible web'], existingDoc?.active !== false);
  const featured    = normalizeBool(row['Destacado'], existingDoc?.featured === true);
  const stock       = Math.max(0, Math.round(normalizeNumber(row['Stock'], existingDoc?.stock || 0)));
  const image1      = normalizeText(row['URL imagen 1']) || existingDoc?.image_url || '';
  const sku         = normalizeText(row['SKU']);
  const marca       = normalizeText(row['Marca']);
  const modelo      = normalizeText(row['Modelo']);
  const color       = normalizeText(row['Color']);
  const capacidad   = normalizeText(row['Capacidad']);
  const compatibilidad = normalizeText(row['Compatibilidad']);
  const condicion   = normalizeText(row['Condición']);
  const etiquetas   = normalizeText(row['Etiquetas']);
  const notas       = normalizeText(row['Notas internas']);
  const subcategoria = normalizeText(row['Subcategoría']);
  const description = [shortDesc, longDesc].filter(Boolean).join('\n\n') || existingDoc?.description || '';
  const specs = Array.isArray(existingDoc?.specs) ? [...existingDoc.specs] : [];
  const pushSpec = (k, v) => { if (v) specs.push({ key: k, value: v }); };
  if (!existingDoc?.ficha && specs.length === 0) {
    pushSpec('Marca', marca); pushSpec('Modelo', modelo); pushSpec('Color', color);
    pushSpec('Capacidad', capacidad); pushSpec('Compatibilidad', compatibilidad);
    pushSpec('Condición', condicion); pushSpec('Subcategoría', subcategoria);
  }
  return {
    sku, name, slug: existingDoc?.slug || slugify(name), description, price,
    original_price: originalPrice > 0 ? originalPrice : null, category: categorySlug,
    badge: condicion || existingDoc?.badge || null, featured, active: visible, stock,
    image_url: image1, img_fit: existingDoc?.img_fit || 'contain', img_pos: existingDoc?.img_pos || 'center',
    img_scale: existingDoc?.img_scale || 1, specs,
    variants: Array.isArray(existingDoc?.variants) ? existingDoc.variants : [],
    logos: Array.isArray(existingDoc?.logos) ? existingDoc.logos : [],
    color_variants: Array.isArray(existingDoc?.color_variants) ? existingDoc.color_variants : [],
    ficha_tecnica: existingDoc?.ficha_tecnica || '',
    ficha: { ...(existingDoc?.ficha || {}), marca: marca || existingDoc?.ficha?.marca || '', modelo: modelo || existingDoc?.ficha?.modelo || '', capacidad: capacidad || existingDoc?.ficha?.capacidad || '', colores: color || existingDoc?.ficha?.colores || '', notas: [compatibilidad, etiquetas, notas].filter(Boolean).join(' • ') || existingDoc?.ficha?.notas || '' },
    brand: marca || existingDoc?.brand || '', model: modelo || existingDoc?.model || '',
    tags: etiquetas ? etiquetas.split(',').map(t => t.trim()).filter(Boolean) : (existingDoc?.tags || []),
    updatedAt: new Date()
  };
}

// ── Leer Excel con ExcelJS (seguro, sin prototype pollution) ──────────────────

async function readWorkbookRows(filePath, sheetNameHint = null) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  let sheet = sheetNameHint ? workbook.getWorksheet(sheetNameHint) : null;
  if (!sheet) sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('No se encontró hoja para importar');

  const allRows = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    // Convertir Row de ExcelJS a array de valores primitivos limpios
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      let val = cell.value;
      // Manejar tipos especiales de ExcelJS
      if (val && typeof val === 'object') {
        if (val.richText) val = val.richText.map(r => r.text || '').join('');
        else if (val.result !== undefined) val = val.result;
        else if (val instanceof Date) val = val;
        else val = String(val);
      }
      cells.push(val ?? '');
    });
    allRows.push(cells);
  });

  return allRows;
}

async function readWorkbookAsObjects(filePath, sheetNameHint = null) {
  const allRows = await readWorkbookRows(filePath, sheetNameHint);
  if (allRows.length < 2) return [];

  // Encontrar fila de headers
  const normalizedRows = allRows.map(row => row.map(c => normalizeText(c)));
  let headerIdx = normalizedRows.findIndex(row =>
    row.some(cell => ['nombre', 'descripcion', '#item', 'sku'].includes(cell.toLowerCase()))
  );
  if (headerIdx < 0) headerIdx = 0;

  const rawHeaders = normalizedRows[headerIdx];
  const headers = rawHeaders.map((h, i) => h || `COL_${i + 1}`);

  return normalizedRows.slice(headerIdx + 1)
    .filter(row => row.some(c => c !== ''))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] ?? ''; });
      return obj;
    });
}

// ── Importar catálogo ─────────────────────────────────────────────────────────
async function importCatalogFromWorkbook(filePath, options = {}) {
  const db   = getFirestore();
  const rows = await readWorkbookAsObjects(filePath, 'PRODUCTOS_BASE');
  const validRows = rows.filter(r => normalizeText(r['Nombre']));
  if (!validRows.length) throw new Error('El Excel no trae productos válidos');

  const categoriesMap  = await loadCategoriesMap(db);
  const productsSnap   = await db.collection('products').get();
  const existingBySku  = new Map();
  const existingByName = new Map();

  productsSnap.docs.forEach(doc => {
    const data = doc.data() || {};
    const sku  = normalizeText(data.sku);
    const name = normalizeText(data.name).toLowerCase();
    if (sku)  existingBySku.set(sku, { id: doc.id, ...data });
    if (name) existingByName.set(name, { id: doc.id, ...data });
  });

  const touchedIds = new Set();
  let created = 0, updated = 0, hidden = 0;

  for (const row of validRows) {
    const sku      = normalizeText(row['SKU']);
    const name     = normalizeText(row['Nombre']);
    const existing = (sku && existingBySku.get(sku)) || existingByName.get(name.toLowerCase()) || null;
    const categorySlug = await ensureCategory(db, row['Categoría'], categoriesMap, name);
    const product  = rowToCatalogProduct(row, categorySlug, existing);
    if (!product) continue;

    if (existing) {
      await db.collection('products').doc(existing.id).set({ ...existing, ...product }, { merge: true });
      touchedIds.add(existing.id);
      updated++;
    } else {
      const ref = await db.collection('products').add({ ...product, sort_order: 0, createdAt: new Date() });
      touchedIds.add(ref.id);
      created++;
    }
  }

  if (options.hideMissing) {
    for (const doc of productsSnap.docs) {
      if (!touchedIds.has(doc.id) && doc.data()?.active !== false) {
        await db.collection('products').doc(doc.id).set({ active: false, updatedAt: new Date() }, { merge: true });
        hidden++;
      }
    }
  }

  return { ok: true, totalRows: validRows.length, created, updated, hidden, mode: options.hideMissing ? 'replace' : 'merge', importType: 'catalog' };
}

// ── Importar inventario ───────────────────────────────────────────────────────
function rowToInventoryItem(row) {
  const sku        = normalizeText(row['#Item'] || row['SKU'] || row['Sku'] || row['sku']);
  const partNumber = normalizeText(row['#parte'] || row['Parte'] || row['No. Parte'] || row['Part Number']);
  const name       = normalizeText(row['Descripcion'] || row['Descripción'] || row['Descripcion producto'] || row['Nombre']);
  const qty        = Math.max(0, Math.round(normalizeNumber(row['Qty'] || row['Cantidad'], 0)));
  const price      = normalizeNumber(row['PRECIO'] || row['Precio'], 0);
  const total      = normalizeNumber(row['T PV'] || row['Total'], price * qty);
  const categoryRaw = normalizeText(row['Categoría'] || row['Categoria']);
  if (!sku || !name || qty <= 0) return null;
  return { sku, partNumber, name, qty, price, total, categoryRaw, description: name, sourceFormat: 'ingreso-mercaderia' };
}

async function importInventoryWorkbook(filePath, options = {}) {
  const db    = getFirestore();
  const rows  = await readWorkbookAsObjects(filePath);
  const items = rows.map(rowToInventoryItem).filter(Boolean);
  if (!items.length) throw new Error('El archivo no trae ingresos válidos');

  const categoriesMap          = await loadCategoriesMap(db);
  const productsSnap           = await db.collection('products').get();
  const existingBySkuCategory  = new Map();
  const existingBySku          = new Map();

  productsSnap.docs.forEach(doc => {
    const data     = doc.data() || {};
    const sku      = normalizeText(data.sku);
    const category = normalizeText(data.category).toLowerCase();
    const obj      = { id: doc.id, ...data };
    if (sku && category) existingBySkuCategory.set(`${sku}__${category}`, obj);
    if (sku && !existingBySku.has(sku)) existingBySku.set(sku, obj);
  });

  let created = 0, updated = 0, ignored = 0;
  const entryItems = [];

  for (const item of items) {
    const preferredExisting = existingBySku.get(item.sku) || null;
    const categorySlug = await ensureCategory(db, item.categoryRaw || preferredExisting?.category || '', categoriesMap, item.name);
    const key      = `${item.sku}__${categorySlug}`;
    const existing = existingBySkuCategory.get(key) || (preferredExisting?.category === categorySlug ? preferredExisting : null);

    if (existing) {
      const previousStock  = Math.max(0, parseInt(existing.stock) || 0);
      const newStock       = previousStock + item.qty;
      const previousActive = existing.active !== false;
      await db.collection('products').doc(existing.id).set({
        sku: item.sku, category: categorySlug, name: existing.name || item.name,
        description: existing.description || item.description || item.name,
        stock: newStock, price: item.price > 0 ? item.price : (existing.price || 0),
        original_price: existing.original_price || null,
        part_number: item.partNumber || existing.part_number || '',
        last_entry_at: new Date(), updatedAt: new Date(), active: previousActive
      }, { merge: true });

      const merged = { ...existing, stock: newStock, price: item.price > 0 ? item.price : existing.price, part_number: item.partNumber || existing.part_number || '' };
      existingBySku.set(item.sku, merged);
      existingBySkuCategory.set(key, merged);
      updated++;
      entryItems.push({ productId: existing.id, sku: item.sku, partNumber: item.partNumber, name: existing.name || item.name, category: categorySlug, qtyAdded: item.qty, unitPrice: item.price, lineTotal: item.total, previousStock, newStock, previousActive, createdProduct: false });
      continue;
    }

    const ref = await db.collection('products').add({
      sku: item.sku, part_number: item.partNumber, name: item.name, slug: slugify(item.name),
      description: item.description || item.name, category: categorySlug, price: item.price,
      original_price: null, badge: null, featured: false, active: true, stock: item.qty,
      image_url: '', img_fit: 'contain', img_pos: 'center', img_scale: 1,
      specs: [], variants: [], logos: [], color_variants: [], ficha_tecnica: '', ficha: {},
      brand: '', model: '', tags: [], sort_order: 0,
      createdAt: new Date(), updatedAt: new Date(), last_entry_at: new Date()
    });

    const createdDoc = { id: ref.id, sku: item.sku, category: categorySlug, stock: item.qty, active: true, name: item.name, price: item.price, part_number: item.partNumber };
    existingBySku.set(item.sku, createdDoc);
    existingBySkuCategory.set(key, createdDoc);
    created++;
    entryItems.push({ productId: ref.id, sku: item.sku, partNumber: item.partNumber, name: item.name, category: categorySlug, qtyAdded: item.qty, unitPrice: item.price, lineTotal: item.total, previousStock: 0, newStock: item.qty, previousActive: false, createdProduct: true });
  }

  const timestamp = new Date();
  const entryPayload = {
    type: 'inventory', title: options.title || `Ingreso ${timestamp.toLocaleDateString('es-SV')}`,
    sourceFileName: options.sourceFileName || '', sourceFormat: 'ingreso-mercaderia',
    status: 'active', createdAt: timestamp, updatedAt: timestamp,
    totals: { lines: entryItems.length, units: entryItems.reduce((s, i) => s + (i.qtyAdded || 0), 0), amount: entryItems.reduce((s, i) => s + (i.lineTotal || 0), 0), created, updated, ignored },
    items: entryItems, note: options.note || 'Ingreso aplicado al inventario existente por SKU + categoría.'
  };

  const entryId = (await db.collection('inventory_entries').add(entryPayload)).id;
  return { ok: true, importType: 'inventory', entryId, totalRows: items.length, created, updated, ignored, hidden: 0, mode: 'inventory-merge' };
}

module.exports = { importCatalogFromWorkbook, importInventoryWorkbook };
