const express = require('express');
const path = require('path');
const { getFirestore } = require('../db/firebase');
const { requireAdminAPI } = require('../middleware/auth');
const { thinkRamiro } = require('../ramiro/services/ramiroBrain');
const { readUrlContent, extractProductsFromUrl } = require('../ramiro/services/ramiroUrlReader');
const { syncProductsFromArray } = require('../ramiro/services/ramiroCatalogTools');
const { learnPattern, rememberFacts, getUserMemory } = require('../ramiro/services/ramiroMemory');
const { buildProjectContextSnapshot } = require('../ramiro/services/ramiroProjectContext');
const { runRamiroTool } = require('../ramiro/services/ramiroAgent');

const router = express.Router();

// ── GLOBAL STATE & HELPERS ─────────────────────────────────────────────────

const ramiroPendingConfirmations = new Map();
const RAMIRO_CONFIRM_TTL_MS = 5 * 60 * 1000;

const ramiroLastClarification = new Map();
const RAMIRO_CLARIF_TTL_MS = 3 * 60 * 1000;

const ramiroPendingProductDraft = new Map();
const RAMIRO_DRAFT_TTL_MS = 10 * 60 * 1000;
const ramiroSessionContext = new Map();
const RAMIRO_SESSION_CTX_TTL_MS = 20 * 60 * 1000;

const ramiroLearnedPatterns = new Map();
const ramiroSemanticAliases = new Map();

const verbos = {
  crear: ['crear', 'agregar', 'anadir', 'añadir', 'poner', 'meter', 'insertar', 'registrar', 'subir'],
  eliminar: ['eliminar', 'borrar', 'quitar', 'remover', 'limpiar', 'suprimir'],
  editar: ['editar', 'modificar', 'cambiar', 'actualizar', 'arreglar', 'ajustar'],
  ver: ['ver', 'mostrar', 'listar', 'ensenar', 'enseñar', 'visualizar'],
  buscar: ['buscar', 'encontrar', 'filtrar', 'localizar'],
  activar: ['activar', 'habilitar', 'encender'],
  desactivar: ['desactivar', 'apagar', 'inhabilitar'],
  ocultar: ['ocultar', 'esconder', 'desaparecer'],
  importar: ['importar', 'traer', 'cargar', 'extraer'],
  ordenar: ['ordenar', 'organizar', 'clasificar'],
  aumentar: ['aumentar', 'subir', 'incrementar'],
  disminuir: ['bajar', 'reducir', 'disminuir']
};

const conectores = [
  'y', 'o', 'pero', 'entonces', 'luego', 'despues', 'después',
  'tambien', 'también', 'ademas', 'además', 'porque', 'ya que',
  'aunque', 'mientras', 'cuando', 'si',
  'como', 'para', 'con', 'sin', 'sobre',
  'entre', 'hasta', 'desde'
];

const referencias = {
  eso: 'contexto',
  'eso mismo': 'contexto',
  'lo otro': 'alternativa',
  ese: 'contexto',
  esa: 'contexto',
  aquello: 'contexto',
  ultimo: 'ultimo_elemento',
  'último': 'ultimo_elemento',
  anterior: 'elemento_anterior'
};

const modificadores = {
  pro: ['mas pro', 'más pro', 'mejor', 'mas bonito', 'más bonito', 'mas limpio', 'más limpio', 'mas premium', 'más premium', 'mas apple', 'más apple'],
  rapido: ['rapido', 'rápido', 'de una', 'sin tanto', 'directo'],
  todo: ['todo', 'todos', 'todo eso', 'completo'],
  nada: ['nada', 'ninguno']
};

const matematicas = {
  suma: ['mas', 'más', '+', 'sumar', 'agregar'],
  resta: ['menos', '-', 'quitar'],
  multiplicar: ['por', '*', 'multiplicar'],
  dividir: ['entre', '/', 'dividir'],
  mayor: ['>', 'mayor que', 'mas que', 'más que'],
  menor: ['<', 'menor que', 'menos que'],
  igual: ['=', 'igual', 'lo mismo']
};

const masivo = {
  todos: ['todos', 'todo', 'completo', 'entero'],
  varios: ['varios', 'algunos', 'unos cuantos'],
  ninguno: ['ninguno', 'ninguna']
};

const sistema = {
  producto: ['producto', 'articulo', 'artículo', 'item', 'cosa'],
  categoria: ['categoria', 'categoría', 'tipo', 'grupo'],
  imagen: ['imagen', 'foto', 'imagen del producto'],
  precio: ['precio', 'costo', 'valor'],
  color: ['color', 'tono', 'variante'],
  banner: ['banner', 'anuncio', 'imagen principal']
};

function cleanText(value, max = 5000) {
  return String(value || '').trim().slice(0, max);
}

function cleanGeminiJson(rawText) {
  let text = String(rawText || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  
  if (text.startsWith('{') && !text.endsWith('}')) {
    const openBraces = (text.match(/{/g) || []).length;
    const closeBraces = (text.match(/}/g) || []).length;
    if (openBraces > closeBraces) {
      text += '}'.repeat(openBraces - closeBraces);
    }
  }
  
  return text;
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasAnyStem(text, stems = []) {
  const normalized = normalizeForMatch(text);
  return stems.some(stem => normalized.includes(normalizeForMatch(stem)));
}

function hasAllStemGroups(text, groups = []) {
  const normalized = normalizeForMatch(text);
  return groups.every(group => {
    const options = Array.isArray(group) ? group : [group];
    return options.some(option => normalized.includes(normalizeForMatch(option)));
  });
}

function isLikelyOperationalIntent(text = '') {
  const normalized = normalizeForMatch(text);
  const verbTokens = Object.values(verbos).flat();
  const systemTokens = Object.values(sistema).flat();
  const mathTokens = Object.values(matematicas).flat();
  return hasAnyStem(normalized, [...verbTokens, ...systemTokens, ...mathTokens, 'stock', 'catalogo', 'catálogo', 'url', 'link']);
}

function hasAmbiguousReferenceIntent(text = '') {
  const normalized = normalizeForMatch(text);
  const hasDemonstrative = hasAnyStem(normalized, [...Object.keys(referencias), 'este', 'esta']);
  const hasActionVerb = hasAnyStem(normalized, [
    'quita', 'quit', 'borra', 'elimina', 'cambia', 'edita', 'arregla',
    'pon', 'actualiza', 'activa', 'desactiva', 'oculta', 'muestra'
  ]);
  return hasDemonstrative && hasActionVerb;
}

function inferProductFromConversationRows(conversationRows = [], allProducts = []) {
  if (!Array.isArray(conversationRows) || !conversationRows.length || !Array.isArray(allProducts) || !allProducts.length) {
    return null;
  }

  for (let i = conversationRows.length - 1; i >= 0; i -= 1) {
    const row = conversationRows[i] || {};
    const key = row?.actionResult?.productId || row?.actionResult?.id || row?.data?.productId || null;
    if (key) {
      const found = resolveProductByIdOrSlug(allProducts, key);
      if (found) return found;
    }
  }

  const recentUserTexts = conversationRows
    .filter(r => r && r.role === 'user')
    .map(r => String(r.text || ''))
    .slice(-8)
    .reverse();

  for (const text of recentUserTexts) {
    const n = normalizeForMatch(text);
    const byName = allProducts.find(p => {
      const productName = normalizeForMatch(p.name || '');
      return productName && (n.includes(productName) || productName.includes(n));
    });
    if (byName) return byName;
  }

  return null;
}

function slugify(str) {
  return (String(str || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-'));
}

function findProductByRef(products, ref) {
  const raw = String(ref || '').trim();
  if (!raw) return null;

  const byId = products.find(p => p.id === raw);
  if (byId) return byId;

  const slug = slugify(raw);
  const bySlug = products.find(p => String(p.slug || '') === slug || String(p.slug || '') === raw);
  if (bySlug) return bySlug;

  const q = normalizeForMatch(raw);
  const exactByName = products.find(p => normalizeForMatch(p.name) === q);
  if (exactByName) return exactByName;

  const containsByName = products.find(p => normalizeForMatch(p.name).includes(q));
  if (containsByName) return containsByName;

  return null;
}

function inferCategoryFromName(name) {
  const n = normalizeForMatch(name);
  if (n.includes('iphone')) return 'iphone';
  if (n.includes('ipad')) return 'ipad';
  if (n.includes('airpods')) return 'airpods';
  return 'mac';
}

function parsePriceFromText(text) {
  const m = String(text || '').match(/\$\s*([0-9]{2,6}(?:[\.,][0-9]{1,2})?)/i)
    || String(text || '').match(/(?:precio|en|a)\s*[:=]?\s*([0-9]{2,6}(?:[\.,][0-9]{1,2})?)/i);
  if (!m) return null;
  const n = Number(String(m[1]).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function stripTrailingPriceFromName(text) {
  return String(text || '')
    .replace(/\s+(?:a|en|por)\s*\$?\s*[0-9]{2,6}(?:[\.,][0-9]{1,2})?\s*$/i, '')
    .replace(/\s*\$\s*[0-9]{2,6}(?:[\.,][0-9]{1,2})?\s*$/i, '')
    .replace(/[.,;:]+$/g, '')
    .trim();
}

function isGenericAssistantPrompt(text = '') {
  const n = normalizeForMatch(text);
  if (!n) return true;
  return [
    'en que te puedo ayudar',
    'en que puedo ayudarte',
    'como te puedo ayudar',
    'dime en que te ayudo'
  ].includes(n);
}

function getAdminDisplayName(admin = {}) {
  const raw = cleanText(admin?.name || '', 80);
  if (raw) return raw;
  const email = String(admin?.email || '').trim();
  if (!email || !email.includes('@')) return '';
  const user = email.split('@')[0] || '';
  const clean = user.replace(/[._-]+/g, ' ').trim();
  return clean || user;
}

function getQuickConversationalReply(message = '', admin = {}) {
  const msg = String(message || '').trim();
  const n = normalizeForMatch(msg);
  if (!n) return null;

  const asksOwnName = /(sabes\s+como\s+me\s+llamo|como\s+me\s+llamo|cual\s+es\s+mi\s+nombre|cu[aá]l\s+es\s+mi\s+nombre|sabes\s+mi\s+nombre)/i.test(n);
  if (asksOwnName) {
    const displayName = getAdminDisplayName(admin);
    return displayName
      ? `Sí, te tengo como ${displayName}. Si quieres, te puedo llamar por otro nombre y lo uso en esta conversación.`
      : 'No tengo un nombre visible para ti todavía. Si quieres, dime cómo prefieres que te llame y lo uso en esta conversación.';
  }

  const editHelpIntent = hasAnyStem(n, ['editar', 'edito', 'edit'])
    && hasAnyStem(n, ['no se', 'nose', 'como', 'ayuda', 'explica']);
  if (editHelpIntent) {
    return 'Te guío rápido para editar un producto: 1) abre Admin > Productos, 2) entra al producto, 3) toca Editar, 4) cambia lo que necesites (precio, imagen, colores, stock) y 5) guarda. Si quieres, también puedes pedírmelo por chat con una frase directa, por ejemplo: "precio de iPhone 15 a $999" o "cambia imagen de MacBook Air a https://...".';
  }

  return null;
}

const BLOCKED_ALIAS_TERMS = new Set([
  'que', 'como', 'cual', 'cuál', 'cuando', 'donde', 'dónde',
  'significa', 'equivale', 'igual', 'lo mismo', 'es', 'son', 'esto', 'eso'
]);

function isSafeAliasTerm(term = '') {
  const t = normalizeForMatch(term).slice(0, 80);
  if (!t || t.length < 3) return false;
  if (t.includes('?')) return false;
  if (BLOCKED_ALIAS_TERMS.has(t)) return false;
  return true;
}

function parseSemanticAliasInstruction(message = '') {
  const raw = cleanText(message, 300);
  if (!raw || /\?/.test(raw)) return null;

  let m = raw.match(/^(?:para\s+mi\s+)?(.+?)\s+significa\s+(.+)$/i)
    || raw.match(/^cuando\s+digo\s+(.+?)\s+(?:me\s+refiero\s+a|es)\s+(.+)$/i)
    || raw.match(/^(.+?)\s+equivale\s+a\s+(.+)$/i);
  if (!m) return null;

  const from = normalizeForMatch(m[1] || '').slice(0, 60);
  const to = normalizeForMatch(m[2] || '').slice(0, 120);
  if (!isSafeAliasTerm(from) || !isSafeAliasTerm(to) || from === to) return null;

  return { from, to };
}

function parseSemanticAliasGroupInstruction(message = '') {
  const raw = cleanText(message, 300);
  if (!raw || /\?/.test(raw)) return null;
  if (!/es\s+lo\s+mismo|son\s+lo\s+mismo/i.test(raw)) return null;

  const clean = raw.replace(/\s+(?:es|son)\s+lo\s+mismo\s*$/i, '').trim();
  if (!clean) return null;

  const terms = clean
    .split(/,|\sy\s|\se\s/i)
    .map(t => normalizeForMatch(t).slice(0, 60))
    .filter(Boolean)
    .filter(isSafeAliasTerm);

  if (terms.length < 2) return null;
  const canonical = terms[0];
  const mappings = terms.slice(1)
    .filter(t => t !== canonical)
    .map(t => ({ from: t, to: canonical }));
  return mappings.length ? mappings : null;
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applySemanticAliases(message = '', aliases = {}) {
  let out = String(message || '');
  const entries = Object.entries(aliases || {})
    .filter(([k, v]) => String(k || '').trim() && String(v || '').trim())
    .sort((a, b) => b[0].length - a[0].length);

  for (const [from, to] of entries) {
    const re = new RegExp(`\\b${escapeRegExp(from)}\\b`, 'gi');
    out = out.replace(re, to);
  }
  return out;
}

function applyBaseDictionary(message = '') {
  let out = String(message || '');
  const hits = [];

  const canonicalGroups = [
    { key: 'crear', values: verbos.crear },
    { key: 'eliminar', values: verbos.eliminar },
    { key: 'editar', values: verbos.editar },
    { key: 'ver', values: verbos.ver },
    { key: 'buscar', values: verbos.buscar },
    { key: 'activar', values: verbos.activar },
    { key: 'desactivar', values: verbos.desactivar },
    { key: 'ocultar', values: verbos.ocultar },
    { key: 'importar', values: verbos.importar },
    { key: 'ordenar', values: verbos.ordenar },
    { key: 'aumentar', values: verbos.aumentar },
    { key: 'disminuir', values: verbos.disminuir },
    { key: 'mejorar diseno', values: modificadores.pro },
  ];

  for (const group of canonicalGroups) {
    for (const variant of group.values) {
      const vv = normalizeForMatch(variant);
      if (!vv) continue;
      const re = new RegExp(`\\b${escapeRegExp(vv)}\\b`, 'gi');
      if (re.test(normalizeForMatch(out))) {
        out = normalizeForMatch(out).replace(re, group.key);
        hits.push(`dict_${group.key}`);
      }
    }
  }

  // Mantener conectores/estructura pero con texto normalizado para la fase IA+parser.
  const normalizedOut = normalizeForMatch(out);
  return { text: normalizedOut, hits: Array.from(new Set(hits)) };
}

function applyContextualReferenceHints(message = '', { implicitTargetProduct, sessionCtx, memoryProfile } = {}) {
  const msg = String(message || '');
  const n = normalizeForMatch(msg);
  const hasVagueRef = /\b(eso|ese|esa|esto|esta|aquel|aquella|lo otro)\b/i.test(n);
  if (!hasVagueRef) return msg;

  const refProductName =
    implicitTargetProduct?.name
    || sessionCtx?.lastProductName
    || memoryProfile?.lastProductName
    || memoryProfile?.refs?.esoProductName
    || '';

  if (!refProductName) return msg;
  return `${msg} (referencia_contextual_producto: ${refProductName})`;
}

function getRamiroSessionContext(adminKey) {
  const ctx = ramiroSessionContext.get(adminKey);
  if (!ctx) return null;
  if (ctx.expiresAt < Date.now()) {
    ramiroSessionContext.delete(adminKey);
    return null;
  }
  return ctx;
}

function setRamiroSessionContext(adminKey, next = {}) {
  const prev = getRamiroSessionContext(adminKey) || {};
  ramiroSessionContext.set(adminKey, {
    ...prev,
    ...next,
    updatedAt: Date.now(),
    expiresAt: Date.now() + RAMIRO_SESSION_CTX_TTL_MS,
  });
}

async function loadPersistentSemanticAliases(userId) {
  try {
    const memory = await getUserMemory(userId);
    const prefs = memory?.preferences || {};
    const out = {};

    for (const [key, entry] of Object.entries(prefs)) {
      if (!String(key).startsWith('alias_')) continue;
      const rawValue = String(entry?.value || '');
      const m = rawValue.match(/^\s*(.+?)\s*=>\s*(.+?)\s*$/);
      if (!m) continue;
      const from = normalizeForMatch(m[1]).slice(0, 60);
      const to = normalizeForMatch(m[2]).slice(0, 120);
      if (!from || !to || from === to) continue;
      out[from] = to;
    }
    return out;
  } catch {
    return {};
  }
}

async function loadAdaptiveMemoryProfile(userId) {
  try {
    const memory = await getUserMemory(userId);
    const prefs = memory?.preferences || {};
    const getVal = (k) => String(prefs?.[k]?.value || '').trim();

    return {
      tone: getVal('profile_tone') || 'neutral',
      lastProductId: getVal('last_product_id') || '',
      lastProductName: getVal('last_product_name') || '',
      refs: {
        esoProductId: getVal('ref_eso_product_id') || '',
        esoProductName: getVal('ref_eso_product_name') || '',
      }
    };
  } catch {
    return {
      tone: 'neutral',
      lastProductId: '',
      lastProductName: '',
      refs: { esoProductId: '', esoProductName: '' },
    };
  }
}

function detectUserStyleLabel(message = '') {
  const n = normalizeForMatch(message);
  if (!n) return 'neutral';
  if (/(vos|de una|ahorita|maje|bro|heyy|hey)/i.test(n)) return 'informal_direct';
  if (/(por favor|podria|podrias|gracias|buenas tardes|buenos dias)/i.test(n)) return 'formal_polite';
  return 'neutral';
}

function getProductIdFromPageContext(pageContext) {
  const pathValue = String(pageContext || '');
  if (!pathValue) return null;
  const editMatch = pathValue.match(/\/admin\/productos\/([^/]+)\/editar/i);
  if (editMatch && editMatch[1]) return decodeURIComponent(editMatch[1]);
  const detailMatch = pathValue.match(/\/admin\/productos\/([^/]+)/i);
  return detailMatch && detailMatch[1] ? decodeURIComponent(detailMatch[1]) : null;
}

function resolveProductByIdOrSlug(products, idOrSlug) {
  const key = String(idOrSlug || '').trim();
  if (!key) return null;
  return products.find(p => p.id === key || String(p.slug || '') === key) || null;
}

function resolveTargetProduct(products, rawRef, fallbackProduct) {
  const direct = findProductByRef(products, rawRef);
  if (direct) return direct;
  return fallbackProduct || null;
}

function normalizeColorLabel(value) {
  const txt = cleanText(value, 40);
  if (!txt) return '';
  return txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase();
}

function splitColorTokens(value) {
  return String(value || '')
    .split(/,|\sy\s|\se\s/i)
    .map(v => normalizeColorLabel(v))
    .filter(Boolean);
}

function countTokenOverlap(a, b) {
  const ta = new Set(normalizeForMatch(a).split(' ').filter(t => t.length > 2));
  const tb = new Set(normalizeForMatch(b).split(' ').filter(t => t.length > 2));
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap += 1;
  return overlap;
}

function findDuplicateWithoutImageCandidates(products, baseProduct) {
  if (!baseProduct || !Array.isArray(products)) return [];
  const baseName = String(baseProduct.name || '').trim();
  if (!baseName) return [];
  const baseNorm = normalizeForMatch(baseName);

  const candidates = products
    .filter(p => p && p.id !== baseProduct.id)
    .filter(p => !String(p.image_url || '').trim())
    .map(p => {
      const pName = String(p.name || '').trim();
      const pNorm = normalizeForMatch(pName);
      const overlap = countTokenOverlap(baseName, pName);
      const strongNameMatch = pNorm.includes(baseNorm) || baseNorm.includes(pNorm);
      const score = (strongNameMatch ? 100 : 0)
        + (overlap * 10)
        + (p.category === baseProduct.category ? 3 : 0)
        + (Number(p.active) === 0 || p.active === false ? 2 : 0);
      return { p, score };
    })
    .filter(x => x.score >= 20)
    .sort((a, b) => b.score - a.score);

  return candidates;
}

function pickSafeDuplicateCandidate(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  if (candidates.length === 1) return candidates[0].p;
  const top = candidates[0];
  const second = candidates[1];
  if ((top.score - second.score) >= 20) return top.p;
  return null;
}

function buildLearnedMemoryEntry(originalMsg, action, data, actionResult, allProducts) {
  if (!action || !originalMsg) return null;
  const trigger = String(originalMsg).replace(/\s+/g, ' ').slice(0, 80).trim();
  let meaning = '';
  if (action === 'PRODUCT_UPDATE') {
    const prod = (allProducts || []).find(p => p.id === data?.productId);
    const fields = Object.keys(data?.updates || {}).join(', ');
    meaning = `actualizar ${fields || 'datos'} en "${prod?.name || data?.productId || 'producto'}"}`;
  } else if (action === 'PRODUCT_CREATE') {
    meaning = `crear producto "${data?.product?.name || 'nuevo'}"}`;
  } else if (action === 'PRODUCT_DELETE') {
    const prod = (allProducts || []).find(p => p.id === data?.productId);
    meaning = `eliminar "${prod?.name || data?.productId || 'producto'}"}`;
  } else if (action === 'SYNC_FROM_URL') {
    meaning = `importar catálogo desde ${data?.url || 'URL'}`;
  } else if (action === 'BULK_ACTION') {
    meaning = `acción masiva (${data?.operation || 'operación'}) sobre ${Array.isArray(data?.ids) ? data.ids.length : '?'} productos`;
  } else {
    meaning = action;
  }
  return `[Aprendido] Cuando dice "${trigger}" → quiere: ${meaning}`;
}

function isExplicitConfirmation(message) {
  const norm = normalizeForMatch(message);
  return /^(si|sí|confirmo|confirmado|dale|hazlo|hace lo|ejecuta|procede|ok(?:ay)?|de una)$/.test(norm)
    || /^(si confirma|sí confirma|elimina|borra|asi|así|asi mero|así mero)$/.test(norm)
    || /\b(confirma|confirmado|hazlo|ejecuta|procede|agregalo|agregalos|anadelo|anadelos|añadelo|añadelos|ahorita)\b/.test(norm)
    || /^(?:asi|así)\s+.+\s+(?:ahorita|de una)$/i.test(norm);
}

function buildRiskSummary(action, data) {
  if (action === 'PRODUCT_DELETE') {
    return 'Eliminar un producto de forma permanente.';
  }
  if (action === 'PRODUCT_CREATE') {
    const p = data?.product || {};
    const name = p.name || 'Nuevo producto';
    const price = p.price ? `$${p.price}` : 'sin precio';
    const cat = p.category || 'sin categoría';
    const missing = [];
    if (!p.image_url) missing.push('imagen');
    if (!p.color_variants?.length) missing.push('colores');
    if (!p.variants?.length) missing.push('variantes');
    if (!p.description) missing.push('descripción');
    const missingNote = missing.length ? `\nFalta: ${missing.join(', ')} — podés dármelos ahora o confirmar así.` : '';
    return `Crear "${name}" en categoría ${cat} a ${price}.${missingNote}`;
  }
  if (action === 'BULK_ACTION') {
    const target = cleanText(data?.filter || 'sin filtro', 120);
    const kind = cleanText(data?.action || 'acción masiva', 80);
    return `Aplicar acción masiva (${kind}) sobre: ${target}.`;
  }
  return 'Aplicar una acción de alto impacto.';
}

function isPotentiallyRiskyAction(action, data) {
  if (action === 'PRODUCT_DELETE' || action === 'BULK_ACTION' || action === 'SYNC_FROM_URL') return true;
  return false;
}

function isHardConfirmationActionType(actionType = '') {
  const t = String(actionType || '').toLowerCase();
  return ['delete', 'bulk', 'import', 'sync'].includes(t);
}

function isHardClarificationActionType(actionType = '') {
  const t = String(actionType || '').toLowerCase();
  return ['delete', 'bulk', 'import', 'sync'].includes(t);
}

function isAmbiguousShortCommand(message) {
  const raw = String(message || '').trim();
  if (!raw) return false;
  return /^(?:hey\s+)?(?:quitalo|quitala|quitale|cambialo|cambiala|arreglalo|arreglala|dejalo|dejala|ponlo|ponla|borralo|eliminalo|edita eso|cambia eso)$/i.test(raw)
    || /^(?:hey\s+)?(?:quita|cambia|edita|arregla|pon|borra|elimina)\s+(?:eso|esto|ese|esa|aquel|aquello)$/i.test(raw);
}

function shouldAutoExecute(decision, autonomousMode = true) {
  if (!autonomousMode) return false;
  if (!decision || typeof decision !== 'object') return false;
  if (decision.needsClarification) return false;

  const actionType = String(decision?.action?.type || 'none').toLowerCase();
  if (!actionType || actionType === 'none') return false;
  if (['ask', 'confirm'].includes(actionType)) return false;
  return true;
}

function formatAgentToolMessage(agentResult, decision) {
  if (agentResult?.type === 'search_results') {
    const count = Array.isArray(agentResult.results) ? agentResult.results.length : 0;
    return `Encontré ${count} resultado(s).`;
  }
  if (agentResult?.type === 'url_read') {
    return 'Listo, leí el contenido de la URL y preparé el resumen.';
  }
  if (agentResult?.type === 'import_preview') {
    return `Encontré ${Number(agentResult.found) || 0} productos en la URL. Te muestro una vista previa para confirmar.`;
  }
  if (agentResult?.type === 'import_done') {
    const created = Number(agentResult?.result?.created) || 0;
    const updated = Number(agentResult?.result?.updated) || 0;
    return `Importación completada. Creados: ${created}, actualizados: ${updated}.`;
  }
  if (agentResult?.type === 'action_done') {
    return decision?.response || 'Acción ejecutada correctamente.';
  }
  return decision?.response || agentResult?.response || 'Listo.';
}

function sanitizeConversationId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function generateConversationId(adminKey) {
  const safeAdmin = String(adminKey || 'admin').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  const rand = Math.random().toString(36).slice(2, 8);
  return `c_${safeAdmin}_${Date.now()}_${rand}`;
}

function toEpoch(input) {
  if (!input) return 0;
  if (typeof input === 'number') return input;
  if (typeof input === 'string') {
    const t = Date.parse(input);
    return Number.isFinite(t) ? t : 0;
  }
  if (input && typeof input.toDate === 'function') {
    try { return input.toDate().getTime(); } catch { return 0; }
  }
  return 0;
}

function buildEvalSummary(rows = []) {
  const total = rows.length;
  const byResultType = {};
  const byIntent = {};
  let autoExecuted = 0;
  let clarification = 0;
  let confirmationRequired = 0;
  let actionAttempts = 0;
  let actionSuccess = 0;
  let actionErrors = 0;

  for (const r of rows) {
    const resultType = String(r.resultType || 'unknown');
    byResultType[resultType] = (byResultType[resultType] || 0) + 1;

    const intent = String(r.intentType || r.decision?.mode || 'unknown');
    byIntent[intent] = (byIntent[intent] || 0) + 1;

    if (r.autoExecuted === true) autoExecuted += 1;
    if (r.resultType === 'clarification' || r.needsClarification === true) clarification += 1;
    if (r.resultType === 'confirmation_required' || r.needsConfirmation === true) confirmationRequired += 1;

    const hasAction = Boolean(r.legacyAction || r.decision?.action?.type) && String(r.resultType || '') !== 'message';
    if (hasAction) {
      actionAttempts += 1;
      if (r.actionOk === true) actionSuccess += 1;
      if (r.actionOk === false) actionErrors += 1;
    }
  }

  const safeRate = (num, den) => den > 0 ? Number(((num / den) * 100).toFixed(2)) : 0;
  const sortedIntent = Object.entries(byIntent).sort((a, b) => b[1] - a[1]).slice(0, 10);

  return {
    totalInteractions: total,
    autoExecutionRatePct: safeRate(autoExecuted, total),
    clarificationRatePct: safeRate(clarification, total),
    confirmationRatePct: safeRate(confirmationRequired, total),
    actionSuccessRatePct: safeRate(actionSuccess, actionAttempts),
    actionErrorRatePct: safeRate(actionErrors, actionAttempts),
    counts: {
      autoExecuted,
      clarification,
      confirmationRequired,
      actionAttempts,
      actionSuccess,
      actionErrors,
    },
    byResultType,
    topIntents: sortedIntent.map(([intent, count]) => ({ intent, count })),
  };
}

function buildStyleHintsFromMessages(messages) {
  const msgs = (messages || []).slice(-20).map(m => String(m || '').trim()).filter(Boolean);
  if (!msgs.length) return '';
  return msgs
    .map(t => `- ${t.slice(0, 220)}`)
    .join('\n');
}

async function appendRamiroTranscript(db, payload) {
  await db.collection('ramiro_transcripts').add({
    ...payload,
    createdAt: new Date()
  });
}

// ── MAIN RAMIRO CHAT ENDPOINT ─────────────────────────────────────────────

router.post('/chat', requireAdminAPI, async (req, res) => {
  try {
    const { message, history, pageContext } = req.body;
    if (!message) return res.status(400).json({ error: 'Falta mensaje' });

    const db = getFirestore();
    const adminKey = String(req.admin?.email || req.admin?.id || 'admin').toLowerCase();
    const incomingConversationId = sanitizeConversationId(req.body?.conversationId);
    const conversationId = incomingConversationId || generateConversationId(adminKey);
    const memoryProfile = await loadAdaptiveMemoryProfile(adminKey);

    // Cargar equivalencias semánticas persistidas del usuario para aplicar aprendizaje entre sesiones.
    const persistedAliases = await loadPersistentSemanticAliases(adminKey);
    const cachedAliases = ramiroSemanticAliases.get(adminKey) || {};
    const mergedAliases = { ...persistedAliases, ...cachedAliases };
    ramiroSemanticAliases.set(adminKey, mergedAliases);

    // Aprendizaje explícito de equivalencias semánticas (ej: "añadir significa agregar").
    const learnedAlias = parseSemanticAliasInstruction(String(message || ''));
    const learnedAliasGroup = parseSemanticAliasGroupInstruction(String(message || ''));
    if (learnedAlias || (Array.isArray(learnedAliasGroup) && learnedAliasGroup.length)) {
      const currentAliases = ramiroSemanticAliases.get(adminKey) || {};
      const toStore = learnedAlias ? [learnedAlias] : learnedAliasGroup;
      for (const a of toStore) {
        currentAliases[a.from] = a.to;
      }
      ramiroSemanticAliases.set(adminKey, currentAliases);

      rememberFacts(adminKey, toStore.map(a => ({
        key: `alias_${a.from.replace(/\s+/g, '_').slice(0, 40)}`,
        value: `${a.from} => ${a.to}`,
        reason: 'Equivalencia semántica definida por el usuario'
      }))).catch(() => {});

      const aliasMsg = learnedAlias
        ? `Entendido. Aprendí esta equivalencia: "${learnedAlias.from}" = "${learnedAlias.to}". Desde ahora la aplicaré automáticamente.`
        : `Entendido. Aprendí estas equivalencias: ${toStore.map(a => `"${a.from}" = "${a.to}"`).join(', ')}.`;
      await appendRamiroTranscript(db, {
        role: 'user',
        text: String(message || ''),
        pageContext: pageContext || '',
        conversationId,
        adminEmail: req.admin?.email || ''
      });
      await appendRamiroTranscript(db, {
        role: 'assistant',
        text: aliasMsg,
        conversationId,
        action: null,
        actionResult: { ok: true, type: 'memory' },
        adminEmail: req.admin?.email || ''
      });
      return res.json({ ok: true, message: aliasMsg, conversationId, actionResult: { ok: true, type: 'memory' } });
    }

    const activeAliases = ramiroSemanticAliases.get(adminKey) || {};
    const dictApplied = applyBaseDictionary(String(message || ''));
    if (dictApplied.hits.length) {
      rememberFacts(adminKey, dictApplied.hits.map(hit => ({
        key: `dict_hit_${hit}`,
        value: 'true',
        reason: 'Regla base de diccionario aplicada en interpretación'
      }))).catch(() => {});
    }
    let effectiveMessage = applySemanticAliases(dictApplied.text, activeAliases);
    const userStyle = detectUserStyleLabel(effectiveMessage);
    rememberFacts(adminKey, [{ key: 'profile_tone', value: userStyle, reason: 'Estilo detectado de conversación del usuario' }]).catch(() => {});

    const pendingConfirmation = ramiroPendingConfirmations.get(adminKey);
    if (pendingConfirmation && pendingConfirmation.expiresAt < Date.now()) {
      ramiroPendingConfirmations.delete(adminKey);
    }
    const sessionCtx = getRamiroSessionContext(adminKey);

    // Cargar config y memoria de Ramiro
    const ramiroDoc = await db.collection('settings').doc('ramiro').get();
    const ramiro = ramiroDoc.exists ? ramiroDoc.data() : {};
    const ramiroName = ramiro.name || 'Ramiro';
    const ramiroPersonality = ramiro.personality || 'Soy el asistente de MacStore.';
    const ramiroMemory = (ramiro.memory || []).slice(0, 20);
    const autonomousMode = ramiro.autonomous_mode !== false;

    // Historial persistente del chat (últimos 80 turnos)
    const transcriptSnap = await db.collection('ramiro_transcripts')
      .orderBy('createdAt', 'desc')
      .limit(300)
      .get();
    const transcriptRows = transcriptSnap.docs
      .map(d => d.data())
      .filter(r => String(r?.adminEmail || '').toLowerCase() === String(req.admin?.email || '').toLowerCase())
      .reverse();
    const conversationRows = transcriptRows.filter(r => sanitizeConversationId(r?.conversationId) === conversationId);
    const persistentConversation = transcriptRows
      .map(m => `${m.role === 'assistant' ? 'Ramiro' : 'Admin'}: ${String(m.text || '').slice(0, 350)}`)
      .join('\n');
    const styleHints = buildStyleHintsFromMessages(
      transcriptRows.filter(m => m.role === 'user').map(m => m.text)
    );

    // Cargar productos reales
    const prodSnap = await db.collection('products').get();
    const allProducts = prodSnap.docs.map(d => ({
      id: d.id, name: d.data().name, category: d.data().category,
      slug: d.data().slug,
      price: d.data().price, active: d.data().active !== false,
      sort_order: d.data().sort_order,
      image_url: d.data().image_url || '', stock: d.data().stock || 0,
      specs: d.data().specs || {}, color_variants: d.data().color_variants || [],
      variants: d.data().variants || []
    }));

    // Resolver producto implícito por contexto actual (URL) o última acción persistida
    const pageProductKey = getProductIdFromPageContext(pageContext);
    let implicitTargetProduct = resolveProductByIdOrSlug(allProducts, pageProductKey);
    if (!implicitTargetProduct) {
      implicitTargetProduct = inferProductFromConversationRows(conversationRows, allProducts)
        || inferProductFromConversationRows(transcriptRows, allProducts);
    }
    if (!implicitTargetProduct && memoryProfile?.lastProductId) {
      implicitTargetProduct = resolveProductByIdOrSlug(allProducts, memoryProfile.lastProductId);
    }
    if (!implicitTargetProduct && memoryProfile?.refs?.esoProductId) {
      implicitTargetProduct = resolveProductByIdOrSlug(allProducts, memoryProfile.refs.esoProductId);
    }
    if (!implicitTargetProduct && memoryProfile?.lastProductName) {
      const q = normalizeForMatch(memoryProfile.lastProductName);
      implicitTargetProduct = allProducts.find(p => normalizeForMatch(p.name || '') === q) || null;
    }
    if (!implicitTargetProduct && sessionCtx?.lastProductId) {
      implicitTargetProduct = resolveProductByIdOrSlug(allProducts, sessionCtx.lastProductId);
    }
    if (!implicitTargetProduct && sessionCtx?.lastProductName) {
      const n = normalizeForMatch(sessionCtx.lastProductName);
      implicitTargetProduct = allProducts.find(p => normalizeForMatch(p.name || '') === n) || null;
    }

    effectiveMessage = applyContextualReferenceHints(effectiveMessage, {
      implicitTargetProduct,
      sessionCtx,
      memoryProfile,
    });

    setRamiroSessionContext(adminKey, {
      lastPageContext: String(pageContext || ''),
    });

    // Cargar settings de la tienda
    const settDoc = await db.collection('settings').doc('main').get();
    const storeSettings = settDoc.exists ? settDoc.data() : {};
    rememberFacts(adminKey, [
      { key: 'cfg_store_name', value: String(storeSettings.store_name || 'MacStore'), reason: 'Configuración actual del sistema' },
      { key: 'cfg_store_whatsapp', value: String(storeSettings.store_whatsapp || ''), reason: 'Configuración actual del sistema' },
    ]).catch(() => {});

    // Cargar cotizaciones recientes
    const quotSnap = await db.collection('quotations').orderBy('createdAt', 'desc').limit(10).get();
    const recentQuotations = quotSnap.docs.map(d => ({
      id: d.id, client: d.data().client, total: d.data().total,
      createdAt: d.data().createdAt?.toDate?.()?.toLocaleDateString('es-SV') || 'reciente'
    }));

    const recentQuotesSummary = recentQuotations.length
      ? recentQuotations.map(q => `- ${cleanText(q.client || 'Cliente', 80)} | total:$${Number(q.total) || 0} | fecha:${q.createdAt}`).join('\n')
      : 'Sin cotizaciones recientes.';

    const recentHistory = (history || []).slice(-10)
      .map(m => `${m.role === 'user' ? 'Admin' : 'Ramiro'}: ${String(m.text || '').slice(0, 300)}`)
      .join('\n');

    const projectContext = buildProjectContextSnapshot(path.join(__dirname, '..'));

    // Atajos conversacionales estables: evita respuestas genéricas cuando el modelo falle.
    const quickReply = getQuickConversationalReply(effectiveMessage, req.admin);
    if (quickReply) {
      await appendRamiroTranscript(db, {
        role: 'user',
        text: String(message || ''),
        pageContext: pageContext || '',
        conversationId,
        adminEmail: req.admin?.email || ''
      });
      await appendRamiroTranscript(db, {
        role: 'assistant',
        text: quickReply,
        conversationId,
        action: null,
        actionResult: null,
        adminEmail: req.admin?.email || ''
      });
      return res.json({ ok: true, message: quickReply, conversationId });
    }

    // ── NUEVO BRAIN: Gemini con prompt estructurado y schema JSON claro ──────────
    let plan = null;
    let brainLegacy = null;
    let brainDecision = null;
    let response = { message: '', action: null, data: null };

    try {
      const brainResult = await thinkRamiro({
        userMessage: String(effectiveMessage || ''),
        userId: adminKey,
        storeName: storeSettings.store_name || 'MacStore',
        personality: ramiroPersonality,
        notes: cleanText(ramiro.notes || '', 1500),
        autonomousMode,
        allProducts,
        implicitProduct: implicitTargetProduct,
        persistentHistory: persistentConversation || '',
        quoteSummary: recentQuotesSummary,
        recentHistory,
        projectContext,
      });

      brainDecision = brainResult.decision || null;
      brainLegacy = brainResult.legacy;
      plan = {
        intentType: brainResult.decision?.mode || 'general',
        goal: brainResult.decision?.understood || '',
        needsConfirmation: !!(brainResult.decision?.requiresConfirmation),
        needsResearch: false,
        steps: [],
        clarificationQuestion: brainResult.decision?.question || '',
      };

      // Mapear salida del brain al formato legacy del sistema
      response = {
        message: brainLegacy.message || '',
        action: brainLegacy.action || null,
        data: brainLegacy.data || null,
        intentType: brainLegacy.intent,
        mode: brainLegacy.mode,
        confidence: brainLegacy.confidence,
      };

      const brainNeedsHardClarification = brainDecision?.needsClarification
        && isHardClarificationActionType(brainDecision?.action?.type);

      if (brainNeedsHardClarification) {
        const clarMessage = brainDecision.question || brainDecision.response || '¿Qué dato te falta para continuar?';
        await appendRamiroTranscript(db, {
          role: 'user',
          text: String(message || ''),
          pageContext: pageContext || '',
          conversationId,
          adminEmail: req.admin?.email || ''
        });
        await appendRamiroTranscript(db, {
          role: 'assistant',
          text: clarMessage,
          conversationId,
          action: null,
          actionResult: null,
          adminEmail: req.admin?.email || ''
        });
        await db.collection('ramiro_chats').add({
          userId: adminKey,
          conversationId,
          message: String(message || ''),
          decision: brainDecision,
          intentType: brainDecision?.mode || null,
          resultType: 'clarification',
          needsClarification: true,
          needsConfirmation: false,
          autoExecuted: false,
          actionOk: null,
          createdAt: new Date().toISOString(),
        });
        return res.json({
          ok: true,
          type: 'clarification',
          autoExecuted: false,
          decision: brainDecision,
          message: clarMessage,
          conversationId,
        });
      }

      // Para acciones no destructivas no bloqueamos aquí: dejamos que el parser determinista
      // intente ejecutar según contexto, incluso si el brain pidió aclaración.
      if (brainDecision?.needsClarification && !brainNeedsHardClarification && !response.action) {
        response.message = brainDecision.question || brainDecision.response || response.message;
      }

      if (shouldAutoExecute(brainDecision, autonomousMode)) {
        try {
          const agentResult = await runRamiroTool(brainDecision, { userId: adminKey });
          if (agentResult?.ok) {
            const autoMessage = formatAgentToolMessage(agentResult, brainDecision);
            await appendRamiroTranscript(db, {
              role: 'user',
              text: String(message || ''),
              pageContext: pageContext || '',
              conversationId,
              adminEmail: req.admin?.email || ''
            });
            await appendRamiroTranscript(db, {
              role: 'assistant',
              text: autoMessage,
              conversationId,
              action: brainDecision?.action?.type || null,
              actionResult: agentResult,
              adminEmail: req.admin?.email || ''
            });
            await db.collection('ramiro_chats').add({
              userId: adminKey,
              conversationId,
              message: String(message || ''),
              decision: brainDecision,
              intentType: brainDecision?.mode || null,
              resultType: agentResult?.type || null,
              needsClarification: false,
              needsConfirmation: false,
              autoExecuted: true,
              actionOk: true,
              createdAt: new Date().toISOString(),
            });

            return res.json({
              ok: true,
              type: agentResult.type || 'message',
              autoExecuted: true,
              message: autoMessage,
              conversationId,
              decision: brainDecision,
              toolResult: agentResult,
            });
          }
        } catch (_) {
          // Si falla el router agente, caer al flujo actual de compatibilidad.
        }
      }

    } catch (geminiErr) {
      console.error('[Ramiro] Error Brain:', geminiErr.message);
      return res.status(500).json({ error: geminiErr.message, message: 'Error al llamar a la IA.' });
    }

    const PLACEHOLDER_PATTERNS = [
      /tu respuesta conversacional aqui/i,
      /respuesta natural y.{0,30}disponibles?/i,
      /escribe aqu[ií] tu respuesta/i,
      /^respuesta (real|base|conversacional)/i
    ];
    const isTemplatePlaceholder = !response.action && PLACEHOLDER_PATTERNS.some(r => r.test(String(response.message || '')));
    if (isTemplatePlaceholder) {
      response = { message: '', action: null, data: null };
    }

    if (plan?.intentType && !response.intentType) {
      response.intentType = plan.intentType;
    }

    // Completar productId cuando Gemini trae updates pero omite el destino explícito
    if (response.action === 'PRODUCT_UPDATE' && response.data?.updates && !response.data?.productId && implicitTargetProduct) {
      response.data.productId = implicitTargetProduct.id;
    }
    if (response.action === 'PRODUCT_DELETE' && !response.data?.productId && implicitTargetProduct) {
      response.data = { ...(response.data || {}), productId: implicitTargetProduct.id };
    }

    // Fallback determinista: si Gemini no ejecuta acción o devuelve acción inválida, interpretamos comandos frecuentes
    const invalidUpdateAction = response.action === 'PRODUCT_UPDATE' && (!response.data?.productId || !response.data?.updates || !Object.keys(response.data.updates || {}).length);
    const invalidCreateAction = response.action === 'PRODUCT_CREATE' && !response.data?.product?.name;
    const hasCapacityEnableCommand = /(?:habilita|habilitar|activa|activar)\s+[0-9]{2,4}\s?gb\s+para\s+/i.test(String(effectiveMessage || ''));
    const isBrainFallbackMessage = /no pude procesar bien ese mensaje/i.test(String(response.message || ''))
      || String(response.intentType || '') === 'fallback_no_parse';
    const hasNaturalBrainResponse = Boolean(String(response.message || '').trim())
      && !isTemplatePlaceholder
      && !isGenericAssistantPrompt(response.message)
      && !isBrainFallbackMessage;
    const brainAlreadyHandledConversation = hasNaturalBrainResponse
      && !response.action
      && !isLikelyOperationalIntent(effectiveMessage || '');

    const shouldForceDeterministic = response.action === 'INFO'
      || invalidUpdateAction
      || invalidCreateAction
      || hasCapacityEnableCommand
      || isTemplatePlaceholder
      || (!brainAlreadyHandledConversation && (!response.action || isLikelyOperationalIntent(effectiveMessage || '') || !hasNaturalBrainResponse));

    if (shouldForceDeterministic) {
      response = { message: response.message || '', action: null, data: null };
      const msg = String(effectiveMessage || '').trim();
      const msgNorm = normalizeForMatch(msg);
      const adminDisplayName = getAdminDisplayName(req.admin);
      const targetFromRef = (ref) => resolveTargetProduct(allProducts, ref, implicitTargetProduct);

      const pendingDraft = ramiroPendingProductDraft.get(adminKey);
      if (pendingDraft && pendingDraft.expiresAt < Date.now()) {
        ramiroPendingProductDraft.delete(adminKey);
      }

      const activeDraft = ramiroPendingProductDraft.get(adminKey);
      if (!response.action && activeDraft) {
        const draftPrice = parsePriceFromText(msg)
          || (msg.match(/^\$?\s*([0-9]{2,6}(?:[\.,][0-9]{1,2})?)$/)?.[1]
            ? Number(String(msg.match(/^\$?\s*([0-9]{2,6}(?:[\.,][0-9]{1,2})?)$/)[1]).replace(',', '.'))
            : null);
        const draftCap = msg.match(/([0-9]{2,4}\s?gb)/i);

        if (Number.isFinite(draftPrice) && draftPrice > 0) {
          const capLabel = draftCap ? String(draftCap[1]).replace(/\s+/g, '').toUpperCase() : '';
          const variants = capLabel ? [{ label: capLabel, price: draftPrice, stock: 0 }] : [];
          response = {
            message: `✅ Entendido. Estoy creando ${activeDraft.name} por $${draftPrice}${capLabel ? ` con ${capLabel}` : ''}.`,
            action: 'PRODUCT_CREATE',
            data: {
              product: {
                name: activeDraft.name,
                slug: activeDraft.slug,
                category: activeDraft.category,
                price: draftPrice,
                variants
              }
            }
          };
          ramiroPendingProductDraft.delete(adminKey);
          setRamiroSessionContext(adminKey, {
            pendingProductName: activeDraft.name,
            pendingProductSlug: activeDraft.slug,
            pendingProductCategory: activeDraft.category,
          });
        } else if (draftCap && !/significa|quiero decir|me refiero/.test(msgNorm)) {
          response = {
            message: `Perfecto, ${String(draftCap[1]).replace(/\s+/g, '').toUpperCase()} anotado para ${activeDraft.name}. Solo dime el precio y lo creo.`,
            action: null,
            data: null
          };
        }
      }

      // Corrección rápida de precio sobre el producto implícito/recién creado.
      if (!response.action && implicitTargetProduct) {
        const correctionWithContext = msg.match(/(?:perdon|perd[oó]n|quise\s+decir|me\s+equivoqu[eé]|era)\s*(?:el\s+precio\s+)?(?:es\s+)?\$?\s*([0-9]{2,6}(?:[\.,][0-9]{1,2})?)/i);
        const barePrice = msg.match(/^\$?\s*([0-9]{2,6}(?:[\.,][0-9]{1,2})?)\s*$/i);
        const correctionPrice = correctionWithContext || barePrice;

        if (correctionPrice) {
          const nextPrice = Number(String(correctionPrice[1]).replace(',', '.'));
          if (Number.isFinite(nextPrice) && nextPrice > 0) {
            response = {
              message: `✅ Entendido. Actualizo ${implicitTargetProduct.name} a $${nextPrice}.`,
              action: 'PRODUCT_UPDATE',
              data: {
                productId: implicitTargetProduct.id,
                updates: { price: nextPrice }
              }
            };
          }
        }
      }

      if (!response.action) {
        const asksOwnName = /(sabes\s+como\s+me\s+llamo|como\s+me\s+llamo|cual\s+es\s+mi\s+nombre|cu[aá]l\s+es\s+mi\s+nombre|sabes\s+mi\s+nombre)/i.test(msgNorm);
        if (asksOwnName) {
          response = {
            message: adminDisplayName
              ? `Sí, te tengo como ${adminDisplayName}. Si quieres, te puedo llamar por otro nombre y lo uso en esta conversación.`
              : 'No tengo un nombre visible para ti todavía. Si quieres, dime cómo prefieres que te llame y lo uso en esta conversación.',
            action: null,
            data: null
          };
        }
      }

      if (!response.action) {
        const editHelpIntent = hasAnyStem(msgNorm, ['editar', 'edito', 'edit'])
          && hasAnyStem(msgNorm, ['no se', 'nose', 'como', 'ayuda', 'explica']);
        if (editHelpIntent) {
          response = {
            message: 'Te guío rápido para editar un producto: 1) abre Admin > Productos, 2) entra al producto, 3) toca Editar, 4) cambia lo que necesites (precio, imagen, colores, stock) y 5) guarda. Si quieres, también puedes pedírmelo por chat con una frase directa, por ejemplo: "precio de iPhone 15 a $999" o "cambia imagen de MacBook Air a https://...".',
            action: null,
            data: null
          };
        }
      }

      const complaintIntent = /(equivoc|no era|no es|te pasaste|la cagaste|mala|mal|incorrect)/i.test(msgNorm);
      if (complaintIntent) {
        response = {
          message: 'Entendido. No ejecutaré cambios destructivos ahora. Dime exactamente cuál quieres mantener y cuál eliminar, y lo hago con confirmación.',
          action: null,
          data: null
        };
      }

      if (!response.action) {
        const ambiguousRef = hasAmbiguousReferenceIntent(msgNorm);
        if (ambiguousRef) {
          if (implicitTargetProduct) {
            response = {
              message: `¿Te refieres a ${implicitTargetProduct.name}? Si me dices "sí", aplico ese cambio sobre ese producto.`,
              action: null,
              data: null
            };
          } else {
            response = {
              message: 'Quiero hacerlo bien: ¿a qué producto te refieres exactamente? Si me dices el nombre o abres el producto, lo ejecuto de inmediato.',
              action: null,
              data: null
            };
          }
        }
      }

      if (!response.action) {
        const identityIntent = hasAllStemGroups(msgNorm, [['quien', 'como'], ['eres', 'llamas', 'ramiro']])
          || hasAllStemGroups(msgNorm, [['eres'], ['tu', 'tú'], ['ramiro']]);
        if (identityIntent) {
          response = {
            message: `Soy ${ramiroName}, el asistente de MacStore. Puedo ayudarte a crear, editar, activar, desactivar, borrar e importar productos del catálogo.`,
            action: null,
            data: null
          };
        }
      }

      if (!response.action) {
        const createHelpIntent = hasAnyStem(msgNorm, ['como', 'ayuda', 'explica', 'dime'])
          && hasAnyStem(msgNorm, ['anad', 'anadir', 'agreg', 'cre', 'sub'])
          && hasAnyStem(msgNorm, ['producto', 'catalogo', 'articulo']);
        if (createHelpIntent) {
          response = {
            message: 'Para agregar un producto, escribime el nombre y el precio en una sola frase. Ejemplos: "añade iPhone Air a 1349", "crea MacBook Air M2 por 999" o "agrega iPad Mini $699". Si quieres, también puedes darme imagen, colores, variantes o descripción en el mismo mensaje o después.',
            action: null,
            data: null
          };
        }
      }

      if (!response.action) {
        const removeColorHelpIntent = hasAnyStem(msgNorm, ['como', 'ayuda', 'explica', 'dime'])
          && hasAnyStem(msgNorm, ['quit', 'elimin', 'borr'])
          && hasAnyStem(msgNorm, ['color', 'colores']);
        if (removeColorHelpIntent) {
          response = {
            message: 'Para quitar un color, dime el producto y el color en la misma frase. Ejemplos: "quita color azul a iPhone 15 Pro" o, si ya tienes abierto el producto, "quita color azul". Si quieres solo deshabilitarlo y no borrarlo, también te lo puedo hacer.',
            action: null,
            data: null
          };
        }
      }

      if (!response.action) {
        const quotationHelpIntent = hasAnyStem(msgNorm, ['cotiz', 'presupuesto'])
          && hasAnyStem(msgNorm, ['como', 'ayuda', 'explica', 'dime', 'mando', 'envi', 'hacer', 'saco', 'genero']);
        if (quotationHelpIntent) {
          response = {
            message: 'Sí. Para mandar una cotización: 1) abre el módulo de cotizaciones en admin, 2) agrega cliente/empresa, 3) selecciona productos y cantidades, 4) define IVA, cuotas y notas, 5) genera/exporta PDF y 6) compártelo por WhatsApp o correo. Si quieres te guío paso a paso según tu caso (ej: sin IVA, con cuotas, con descuento o para cliente recurrente).',
            action: null,
            data: null
          };
        }
      }

      // -2) Saludo o mensaje genérico sin contexto de acción
      if (!response.action) {
        const greetIntent = /^(ayuda(me)?|me ayudas?|hola+|hey+y*( ramiro)?|buenas?|qu[eé] puedes?|para qu[eé] sirves?|qu[eé] haces?)\s*[.!?]*$/i.test(msg.trim());
        if (greetIntent || isTemplatePlaceholder) {
          response = {
            message: 'Aquí estoy. Puedo: 1) buscar productos, 2) editar precio, imagen, colores o stock, 3) activar/desactivar productos, 4) crear o eliminar con confirmación, y 5) ayudarte con cotizaciones. Dime una sola cosa y la hacemos de una vez.',
            action: null,
            data: null
          };
        }
      }

      // -1) Importación/sincronización masiva desde URL: "agregame todo lo de este enlace"
      if (!response.action) {
        const urlMatch = msg.match(/https?:\/\/\S+/i);
        const importIntent = /(agreg|import|carg|sub|sincroniz|mete|trae).*(todo|catalogo|catálogo|productos?)/i.test(msgNorm)
          || /(todo).*(enlace|link|url)/i.test(msgNorm)
          || /(desde|de).*(enlace|link|url)/i.test(msgNorm);
        if (urlMatch && importIntent) {
          const sourceUrl = urlMatch[0].replace(/[),.;]+$/, '');
          response = {
            message: 'Preparé una sincronización completa desde el enlace indicado.',
            action: 'SYNC_FROM_URL',
            data: { url: sourceUrl }
          };
        }
      }

      // -0.5) Consulta del sistema: "no aparece en productos pero sí en tienda"
      if (!response.action) {
        const mismatchIntent = /(no me aparece|no aparece|no lo veo|no la veo)/i.test(msgNorm)
          && /(producto|productos|admin|aqui|aquí|tienda|catalogo|catálogo|web)/i.test(msgNorm);
        if (mismatchIntent) {
          const priceMention = msg.match(/\$\s*([0-9]{2,6}(?:[\.,][0-9]{1,2})?)/i)
            || msg.match(/\b([0-9]{3,6})\b/);
          const maybePrice = priceMention ? Number(String(priceMention[1]).replace(',', '.')) : null;

          const hintedProducts = allProducts
            .map(p => {
              const nameNorm = normalizeForMatch(p.name);
              let score = 0;
              if (/macbook/.test(msgNorm) && /macbook/.test(nameNorm)) score += 4;
              if (/pro/.test(msgNorm) && /pro/.test(nameNorm)) score += 2;
              if (/\b14\b/.test(msgNorm) && /\b14\b/.test(nameNorm)) score += 2;
              if (Number.isFinite(maybePrice) && Number(p.price) === maybePrice) score += 3;
              return { p, score };
            })
            .filter(x => x.score >= 3)
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);

          if (hintedProducts.length) {
            const lines = hintedProducts.map(({ p }) => {
              const hasImage = String(p.image_url || '').trim() ? 'si' : 'no';
              const hasSort = p.sort_order !== undefined && p.sort_order !== null;
              return `- ${p.name} | $${Number(p.price) || 0} | id:${String(p.id).slice(0, 8)} | activo:${p.active ? 'si' : 'no'} | imagen:${hasImage} | sort_order:${hasSort ? p.sort_order : 'faltante'}`;
            }).join('\n');

            const probableCause = hintedProducts.some(x => x.p.sort_order === undefined || x.p.sort_order === null)
              ? 'Posible causa: ese producto no tiene sort_order y la vista de admin puede omitirlo por el orderBy.'
              : 'No veo inconsistencia obvia en campos principales; podría ser caché o filtro de UI.';

            response = {
              message: `Encontré estos productos relacionados en la base real:\n${lines}\n\n${probableCause}`,
              action: null,
              data: null
            };
          } else {
            response = {
              message: 'No encontré coincidencias claras con esa referencia en la base actual. Si me das nombre exacto o ID, te digo por qué no aparece en admin.',
              action: null,
              data: null
            };
          }
        }
      }

      // 0) Comandos ultracortos de precio sobre el producto implícito
      if (!response.action && implicitTargetProduct) {
        const up = msg.match(/(?:sube|subir|subilo|subile|aumenta|aumentale)\s*(?:\$)?\s*([0-9]{1,6}(?:[\.,][0-9]{1,2})?)/i);
        const down = msg.match(/(?:baja|bajar|bajalo|bajale|descuenta|rebaja)\s*(?:\$)?\s*([0-9]{1,6}(?:[\.,][0-9]{1,2})?)/i);
        const setAbs = msg.match(/(?:ponelo|ponela|ponle|dejalo|dejala|cambialo|cambiala|cambiale|actualizalo|actualizale)\s+(?:a|en)\s*\$?\s*([0-9]{2,6}(?:[\.,][0-9]{1,2})?)/i);

        if (setAbs) {
          const newPrice = Number(String(setAbs[1]).replace(',', '.'));
          if (Number.isFinite(newPrice) && newPrice > 0) {
            response = {
              message: `✅ actualizado precio de ${implicitTargetProduct.name} a $${newPrice}`,
              action: 'PRODUCT_UPDATE',
              data: {
                productId: implicitTargetProduct.id,
                updates: { price: newPrice }
              }
            };
          }
        } else if (up || down) {
          const deltaRaw = up ? up[1] : down[1];
          const delta = Number(String(deltaRaw).replace(',', '.'));
          const currentPrice = Number(implicitTargetProduct.price) || 0;
          if (Number.isFinite(delta) && delta > 0 && currentPrice > 0) {
            const next = up
              ? Number((currentPrice + delta).toFixed(2))
              : Number(Math.max(1, currentPrice - delta).toFixed(2));
            response = {
              message: `✅ precio de ${implicitTargetProduct.name}: $${currentPrice} → $${next}`,
              action: 'PRODUCT_UPDATE',
              data: {
                productId: implicitTargetProduct.id,
                updates: { price: next }
              }
            };
          }
        }
      }

      // 1) Precio: "pon el precio de X a $249"
      const pricePatterns = [
        /precio\s+(?:de|del)\s+(.+?)\s+(?:a|en)\s*\$\s*([0-9]{2,6}(?:[\.,][0-9]{1,2})?)/i,
        /(?:pon|poner|ponle|cambia|actualiza|sube|baja)\s+(?:el\s+)?precio\s+(?:de|del)?\s*(.+?)\s*(?:a|en|,)\s*\$\s*([0-9]{2,6}(?:[\.,][0-9]{1,2})?)/i
      ];
      for (const re of pricePatterns) {
        if (response.action) break;
        const m = msg.match(re);
        if (!m) continue;
        const targetProd = targetFromRef(m[1]);
        const price = Number(String(m[2]).replace(',', '.'));
        if (targetProd && Number.isFinite(price) && price > 0) {
          response = {
            message: `✅ actualizado precio de ${targetProd.name} a $${price}`,
            action: 'PRODUCT_UPDATE',
            data: {
              productId: targetProd.id,
              updates: { price }
            }
          };
        }
      }

      // 1.5) Capacidad por color: "habilita 512GB para iPhone 17 lavanda"
      if (!response.action) {
        const capCmd = msg.match(/(?:habilita|habilitar|activa|activar)\s+([0-9]{2,4}\s?gb)\s+para\s+(.+)$/i);
        if (capCmd) {
          const capacity = String(capCmd[1]).replace(/\s+/g, '').toUpperCase();
          const targetRaw = String(capCmd[2] || '').trim();

          let targetProd = targetFromRef(targetRaw);
          let colorName = '';

          if (targetProd) {
            const rawNorm = normalizeForMatch(targetRaw);
            const prodNorm = normalizeForMatch(targetProd.name);
            colorName = rawNorm.replace(prodNorm, '').trim();
          } else {
            const genericColors = ['negro', 'blanco', 'azul', 'verde', 'lavanda', 'rosa', 'rojo', 'dorado', 'plata', 'morado', 'amarillo'];
            const targetNorm = normalizeForMatch(targetRaw);
            const colorTail = genericColors.find(c => targetNorm.endsWith(` ${c}`) || targetNorm === c);
            if (colorTail) {
              const productPart = targetRaw.slice(0, Math.max(0, targetRaw.length - colorTail.length)).trim();
              targetProd = targetFromRef(productPart);
              colorName = colorTail;
            }
          }

          if (targetProd) {
            const updates = {};

            // Asegurar variante global de capacidad
            const currentVariants = Array.isArray(targetProd.variants) ? [...targetProd.variants] : [];
            const hasCap = currentVariants.some(v => String(v?.label || '').toUpperCase() === capacity);
            if (!hasCap) {
              currentVariants.push({ label: capacity, price: Number(targetProd.price) || 1, stock: 0 });
            }
            updates.variants = currentVariants;

            // Asegurar capacidad dentro del color solicitado
            const currentColors = Array.isArray(targetProd.color_variants) ? [...targetProd.color_variants] : [];
            const hasObjectColors = currentColors.some(c => c && typeof c === 'object');

            if (hasObjectColors) {
              const normalizedColor = colorName
                ? colorName.charAt(0).toUpperCase() + colorName.slice(1).toLowerCase()
                : '';
              let found = false;
              const updatedColors = currentColors.map(c => {
                if (!c || typeof c !== 'object') return c;
                const name = String(c.name || '').trim();
                const nameNorm = normalizeForMatch(name);
                if (normalizedColor && nameNorm === normalizeForMatch(normalizedColor)) {
                  found = true;
                  const caps = Array.isArray(c.available_caps) ? [...c.available_caps] : [];
                  if (!caps.some(x => String(x).toUpperCase() === capacity)) caps.push(capacity);
                  return { ...c, enabled: true, available_caps: caps };
                }
                return c;
              });

              if (!found && normalizedColor) {
                updatedColors.push({ name: normalizedColor, enabled: true, available_caps: [capacity] });
              }
              updates.color_variants = updatedColors;
            }

            response = {
              message: `✅ habilitado ${capacity}${colorName ? ` para ${colorName}` : ''} en ${targetProd.name}`,
              action: 'PRODUCT_UPDATE',
              data: {
                productId: targetProd.id,
                updates
              }
            };
          }
        }
      }

      // 2) Imagen: "pon imagen https://... a X"
      if (!response.action && /(imagen|foto)/i.test(msg)) {
        const urlMatch = msg.match(/https?:\/\/\S+/i);
        if (urlMatch) {
          const imageUrl = urlMatch[0].replace(/[),.;]+$/, '');
          const byTail = msg.match(/\b(?:a|para|en)\b\s+(.+)$/i);
          const targetCandidate = byTail ? byTail[1].replace(urlMatch[0], '').trim() : msg.replace(urlMatch[0], '').trim();
          const targetProd = targetFromRef(targetCandidate);
          if (targetProd) {
            response = {
              message: `✅ imagen actualizada para ${targetProd.name}`,
              action: 'PRODUCT_UPDATE',
              data: {
                productId: targetProd.id,
                updates: { image_url: imageUrl }
              }
            };
          }
        }
      }

      // 2.5) Imagen ultracorta sobre producto implícito: "ponle esta imagen https://..."
      if (!response.action && implicitTargetProduct) {
        const shortImageCmd = msg.match(/(?:ponle|cambiale|actualizale|pon|cambia).*(?:imagen|foto).*(https?:\/\/\S+)/i);
        if (shortImageCmd) {
          const imageUrl = shortImageCmd[1].replace(/[),.;]+$/, '');
          response = {
            message: `✅ imagen actualizada para ${implicitTargetProduct.name}`,
            action: 'PRODUCT_UPDATE',
            data: {
              productId: implicitTargetProduct.id,
              updates: { image_url: imageUrl }
            }
          };
        }
      }

      // 3) Activar/desactivar
      if (!response.action && /(activa|activar|desactiva|desactivar|inactivo|inactiva)/i.test(msgNorm)) {
        const active = !/(desactiva|desactivar|inactivo|inactiva)/i.test(msgNorm);
        const targetCandidate = msg
          .replace(/(?:pon|poner|deja|marcar|marca|activa|activar|desactiva|desactivar|como|en|estado|inactivo|activo)/gi, ' ')
          .trim();
        const targetProd = targetFromRef(targetCandidate);
        if (targetProd) {
          response = {
            message: `✅ ${targetProd.name} ahora está ${active ? 'activo' : 'inactivo'}`,
            action: 'PRODUCT_UPDATE',
            data: {
              productId: targetProd.id,
              updates: { active }
            }
          };
        }
      }

      // 4) Borrar producto
      if (!response.action && /(elimina|eliminar|borra|borrar)/i.test(msgNorm)) {
        const duplicateByRefMatch = msg.match(/(?:elimina|eliminar|borra|borrar)\s+(.+?)\s+duplicad[oa].*(?:sin\s+imagen|sin\s+foto)/i);
        if (duplicateByRefMatch) {
          const baseRef = cleanText(duplicateByRefMatch[1], 180);
          const base = findProductByRef(allProducts, baseRef);
          const candidates = base ? findDuplicateWithoutImageCandidates(allProducts, base) : [];
          const duplicateFromRef = pickSafeDuplicateCandidate(candidates);
          if (duplicateFromRef) {
            response = {
              message: `✅ se eliminará duplicado sin imagen: ${duplicateFromRef.name}`,
              action: 'PRODUCT_DELETE',
              data: { productId: duplicateFromRef.id }
            };
          } else if (candidates.length > 1) {
            response = {
              message: `Encontré varios duplicados sin imagen para "${baseRef}". ¿Cuál elimino? ${candidates.slice(0, 3).map(c => `${c.p.name} [${String(c.p.id || '').slice(0, 6)}]`).join(' | ')}`,
              action: null,
              data: null
            };
          } else {
            response = {
              message: `No encontré un duplicado sin imagen claro para "${baseRef}". Si quieres, dime el nombre exacto del duplicado y lo elimino.`,
              action: null,
              data: null
            };
          }
        }

        const duplicateNoImageIntent = /(otra|duplicad)/i.test(msgNorm) && /(sin imagen|sin foto)/i.test(msgNorm);

        if (!response.action && duplicateNoImageIntent && implicitTargetProduct) {
          const dupCandidates = findDuplicateWithoutImageCandidates(allProducts, implicitTargetProduct);
          const duplicateCandidate = pickSafeDuplicateCandidate(dupCandidates);
          if (duplicateCandidate) {
            response = {
              message: `✅ se eliminará duplicado sin imagen: ${duplicateCandidate.name}`,
              action: 'PRODUCT_DELETE',
              data: { productId: duplicateCandidate.id }
            };
          } else if (dupCandidates.length > 1) {
            response = {
              message: `Hay varios duplicados sin imagen de ${implicitTargetProduct.name}. ¿Cuál elimino? ${dupCandidates.slice(0, 3).map(c => `${c.p.name} [${String(c.p.id || '').slice(0, 6)}]`).join(' | ')}`,
              action: null,
              data: null
            };
          } else {
            response = {
              message: `No encontré un duplicado sin imagen claro para ${implicitTargetProduct.name}. Si quieres, dime el nombre exacto o abre el duplicado y te ayudo a borrarlo.`,
              action: null,
              data: null
            };
          }
        }

        if (response.action) {
          // Ya resolvimos el caso de duplicado sin imagen.
        } else {
          const targetCandidate = msg.replace(/(?:elimina|eliminar|borra|borrar|producto|por favor)/gi, ' ').trim();
          const targetProd = targetFromRef(targetCandidate);
          if (targetProd) {
            response = {
              message: `✅ se eliminará ${targetProd.name}`,
              action: 'PRODUCT_DELETE',
              data: { productId: targetProd.id }
            };
          }
        }
      }

      // 5) Crear producto (si incluye nombre claro y, de preferencia, precio)
      if (!response.action) {
        const createCmd = msg.match(/^(?:y\s+)?(?:(?:me\s+)?(?:puedes?|podrias?|podr[ií]as?|pod[eé]s?|necesito\s+que|quiero\s+que)\s+)?(?:agrega|agregar|agregues?|crea|crear|crees?|anade|añade|anadir|añadir|sube|subir|mete|meter|pon|poner)\s+(?:el\s+|un\s+|una\s+)?(?:producto\s+)?(.+)$/i);
        if (createCmd && !/(colores?|imagen|foto|precio)/i.test(msgNorm)) {
          if (/significa|quiero decir|me refiero/.test(msgNorm)) {
            response = {
              message: 'Entendido. Cuando quieras crear uno, dime el nombre y precio en una sola frase o en dos pasos.',
              action: null,
              data: null
            };
          } else {
          const rawName = cleanText(createCmd[1], 160).replace(/[.,;]+$/, '').trim();
          const cleanName = stripTrailingPriceFromName(rawName.replace(/^(unos?|unas?)\s+/i, '').trim());
          if (!cleanName) {
            response = {
              message: 'Puedo crearlo, pero necesito un nombre claro para el producto.',
              action: null,
              data: null
            };
          } else {
          const slug = slugify(cleanName);
          const existing = allProducts.find(p => p.slug === slug);
          if (existing) {
            response = {
              message: `ℹ️ ${existing.name} ya existe. Dime qué le actualizo (precio, colores, imagen, stock).`,
              action: null,
              data: null
            };
          } else {
            const price = parsePriceFromText(msg);
            if (!price) {
              ramiroPendingProductDraft.set(adminKey, {
                name: cleanName,
                slug,
                category: inferCategoryFromName(cleanName),
                expiresAt: Date.now() + RAMIRO_DRAFT_TTL_MS
              });
                setRamiroSessionContext(adminKey, {
                  pendingProductName: cleanName,
                  pendingProductSlug: slug,
                  pendingProductCategory: inferCategoryFromName(cleanName),
                });
              response = {
                message: `Listo, puedo crearlo como "${cleanName}". Solo dime el precio (ej: $249) y lo agrego.`,
                action: null,
                data: null
              };
            } else {
              response = {
                message: `✅ creado ${cleanName} por $${price}`,
                action: 'PRODUCT_CREATE',
                data: {
                  product: {
                    name: cleanName,
                    slug,
                    category: inferCategoryFromName(cleanName),
                    price
                  }
                }
              };
            }
            }
          }
          }
        }
      }

      const colorCmd = msg.match(/(?:agrega|agregar|anade|añade|pon|poner)\s+colores?\s+(.+?)\s+a\s+(.+)$/i);
      if (!response.action && colorCmd) {
        const colorsRaw = colorCmd[1] || '';
        const targetRaw = (colorCmd[2] || '').trim();
        const targetProd = targetFromRef(targetRaw);

        if (targetProd) {
          const parsedColors = colorsRaw
            .split(/,|\sy\s|\se\s/i)
            .map(c => cleanText(c, 40))
            .map(c => c ? c.charAt(0).toUpperCase() + c.slice(1).toLowerCase() : '')
            .filter(Boolean);

          const hasObjectColors = Array.isArray(targetProd.color_variants) && targetProd.color_variants.some(c => c && typeof c === 'object');
          let merged;
          if (hasObjectColors) {
            const original = Array.isArray(targetProd.color_variants) ? [...targetProd.color_variants] : [];
            const seen = new Set(original.map(c => normalizeForMatch(c?.name || c)));
            merged = [...original];
            for (const color of parsedColors) {
              const key = normalizeForMatch(color);
              if (!seen.has(key)) {
                seen.add(key);
                merged.push({ name: color, enabled: true, available_caps: [] });
              }
            }
          } else {
            const existingColors = Array.isArray(targetProd.color_variants)
              ? targetProd.color_variants
                .map(c => typeof c === 'string' ? c : String(c?.label || c?.name || ''))
                .map(c => c ? c.charAt(0).toUpperCase() + c.slice(1).toLowerCase() : '')
                .filter(Boolean)
              : [];

            merged = [];
            const seen = new Set();
            for (const c of [...existingColors, ...parsedColors]) {
              const k = c.toLowerCase();
              if (!seen.has(k)) {
                seen.add(k);
                merged.push(c);
              }
            }
          }
          response = {
            message: `✅ agregado colores ${parsedColors.join(', ')} a ${targetProd.name}`,
            action: 'PRODUCT_UPDATE',
            data: {
              productId: targetProd.id,
              updates: { color_variants: merged }
            }
          };
        }
      }

      // 5.5) Colores ultracortos sobre producto implícito
      if (!response.action && implicitTargetProduct) {
        const addColorImplicit = msg.match(/(?:agrega|agregale|anade|añade|ponle|pon)\s+(?:el\s+)?colores?\s+(.+)$/i);
        const removeColorImplicit = msg.match(/(?:quita|quitale|elimina|eliminale|borra|borrale)\s+(?:el\s+)?colores?\s+(.+)$/i);

        if (addColorImplicit) {
          const parsedColors = splitColorTokens(addColorImplicit[1]);
          if (parsedColors.length) {
            const currentColors = Array.isArray(implicitTargetProduct.color_variants) ? [...implicitTargetProduct.color_variants] : [];
            const hasObjectColors = currentColors.some(c => c && typeof c === 'object');
            let merged;
            if (hasObjectColors) {
              merged = [...currentColors];
              const seen = new Set(merged.map(c => normalizeForMatch(c?.name || c?.label || c)));
              for (const color of parsedColors) {
                const key = normalizeForMatch(color);
                if (!seen.has(key)) {
                  seen.add(key);
                  merged.push({ name: color, enabled: true, available_caps: [] });
                }
              }
            } else {
              const base = currentColors
                .map(c => typeof c === 'string' ? c : String(c?.label || c?.name || ''))
                .map(normalizeColorLabel)
                .filter(Boolean);
              const seen = new Set();
              merged = [];
              for (const c of [...base, ...parsedColors]) {
                const k = c.toLowerCase();
                if (!seen.has(k)) {
                  seen.add(k);
                  merged.push(c);
                }
              }
            }
            response = {
              message: `✅ colores agregados en ${implicitTargetProduct.name}: ${parsedColors.join(', ')}`,
              action: 'PRODUCT_UPDATE',
              data: {
                productId: implicitTargetProduct.id,
                updates: { color_variants: merged }
              }
            };
          }
        } else if (removeColorImplicit) {
          const removeColors = splitColorTokens(removeColorImplicit[1]);
          if (removeColors.length) {
            const removeSet = new Set(removeColors.map(c => normalizeForMatch(c)));
            const currentColors = Array.isArray(implicitTargetProduct.color_variants) ? [...implicitTargetProduct.color_variants] : [];
            const hasObjectColors = currentColors.some(c => c && typeof c === 'object');
            let filtered;
            if (hasObjectColors) {
              filtered = currentColors.filter(c => !removeSet.has(normalizeForMatch(c?.name || c?.label || '')));
            } else {
              filtered = currentColors
                .map(c => typeof c === 'string' ? c : String(c?.label || c?.name || ''))
                .map(normalizeColorLabel)
                .filter(c => c && !removeSet.has(normalizeForMatch(c)));
            }
            response = {
              message: `✅ colores removidos en ${implicitTargetProduct.name}: ${removeColors.join(', ')}`,
              action: 'PRODUCT_UPDATE',
              data: {
                productId: implicitTargetProduct.id,
                updates: { color_variants: filtered }
              }
            };
          }
        }
      }

      // 6) Comandos mínimos de demostrativo: "hey quita esto", "hey pon esto"
      if (!response.action && implicitTargetProduct) {
        const shortDeactivate = /^(?:hey\s+)?(?:quita|quitar|oculta|ocultar|desactiva|desactivar)\s+(?:esto|este|esta)(?:\s+producto)?$/i.test(msg);
        const shortActivate = /^(?:hey\s+)?(?:pon|poner|muestra|mostrar|activa|activar)\s+(?:esto|este|esta)(?:\s+producto)?$/i.test(msg);
        const shortChange = /^(?:hey\s+)?(?:cambia|cambiar|edita|editar)\s+(?:esto|este|esta)(?:\s+producto)?$/i.test(msg);

        if (shortDeactivate) {
          response = {
            message: `✅ ${implicitTargetProduct.name} ocultado del catálogo (inactivo).`,
            action: 'PRODUCT_UPDATE',
            data: {
              productId: implicitTargetProduct.id,
              updates: { active: false }
            }
          };
        } else if (shortActivate) {
          response = {
            message: `✅ ${implicitTargetProduct.name} visible en catálogo (activo).`,
            action: 'PRODUCT_UPDATE',
            data: {
              productId: implicitTargetProduct.id,
              updates: { active: true }
            }
          };
        } else if (shortChange) {
          response = {
            message: `Listo. ¿Qué quieres cambiar de ${implicitTargetProduct.name}? Ejemplos: "precio a $999", "agrega color negro", "cambia imagen https://..."`,
            action: null,
            data: null
          };
        }
      }

      if (!response.action && !implicitTargetProduct) {
        const shortWithoutTarget = /^(?:hey\s+)?(?:quita|quitar|pon|poner|cambia|cambiar|edita|editar|activa|activar|desactiva|desactivar)\s+(?:esto|este|esta)(?:\s+producto)?$/i.test(msg);
        if (shortWithoutTarget) {
          response = {
            message: 'Puedo hacerlo rápido, pero necesito saber a qué producto te refieres. Abre el producto en edición o escribe su nombre (ej: "quita esto en iPhone 16 Pro").',
            action: null,
            data: null
          };
        }
      }

      // 7) Ambigüedad breve: intentar inferir; si no hay base, preguntar corto
      if (!response.action && isAmbiguousShortCommand(msg)) {
        if (implicitTargetProduct) {
          response = {
            message: `¿Quieres que haga el cambio sobre ${implicitTargetProduct.name}? Si me dices "sí", ejecuto de inmediato.`,
            action: null,
            data: null
          };
        } else if (plan?.clarificationQuestion) {
          response = {
            message: plan.clarificationQuestion,
            action: null,
            data: null
          };
        } else {
          response = {
            message: '¿A qué te refieres exactamente? Puedo quitar imagen, quitar precio tachado, desactivar producto o eliminarlo.',
            action: null,
            data: null
          };
        }
      }

      // Fallback final: si después de todo no hay acción ni mensaje útil, preguntar
      if (!response.action && !String(response.message || '').trim()) {
        response = {
          message: 'Te leo. Si quieres, dime exactamente qué necesitas y lo resolvemos paso a paso (por ejemplo: "editar precio", "quitar color", "crear producto" o "mandar cotización").',
          action: null,
          data: null
        };
      }
    }

    // Guardrails por intención: evita que Gemini meta cambios no pedidos
    const userMsg = String(effectiveMessage || '');
    const userMsgNorm = normalizeForMatch(userMsg);

    // Si el comando es de imagen y la respuesta no trae image_url, forzamos update determinista de imagen
    if (/(imagen|foto)/i.test(userMsg) && /https?:\/\//i.test(userMsg)) {
      const hasImageUpdate = response.action === 'PRODUCT_UPDATE' && response.data?.updates?.image_url;
      if (!hasImageUpdate) {
        const urlMatch = userMsg.match(/https?:\/\/\S+/i);
        if (urlMatch) {
          const imageUrl = urlMatch[0].replace(/[),.;]+$/, '');
          const byTail = userMsg.match(/\b(?:a|para|en)\b\s+(.+)$/i);
          const targetCandidate = byTail ? byTail[1].replace(urlMatch[0], '').trim() : userMsg.replace(urlMatch[0], '').trim();
          const targetProd = resolveTargetProduct(allProducts, targetCandidate, implicitTargetProduct);
          if (targetProd) {
            response = {
              message: `✅ imagen actualizada para ${targetProd.name}`,
              action: 'PRODUCT_UPDATE',
              data: { productId: targetProd.id, updates: { image_url: imageUrl } }
            };
          }
        }
      }
    }

    if (response.action === 'PRODUCT_UPDATE' && response.data?.updates) {
      const isMultiFieldRequest = /\b(y|e|ademas|adem[aá]s|tambien|tambi[eé]n|todo|completo)\b|,/.test(userMsgNorm);
      const intentFields =
        /(?:habilita|habilitar|activa|activar)\s+[0-9]{2,4}\s?gb\s+para\s+/i.test(userMsg) ? ['variants', 'color_variants'] :
        /(colores?|color)/i.test(userMsgNorm) ? ['color_variants'] :
        /(imagen|foto)/i.test(userMsgNorm) ? ['image_url'] :
        /(precio|\$|sube|subir|subilo|subile|baja|bajar|bajalo|bajale|aumenta|descuenta|rebaja)/i.test(userMsgNorm) ? ['price'] :
        /(stock|inventario)/i.test(userMsgNorm) ? ['stock'] :
        /(activa|activar|desactiva|desactivar|inactivo|activo)/i.test(userMsgNorm) ? ['active'] :
        null;

      if (intentFields && !isMultiFieldRequest) {
        const filtered = {};
        for (const k of intentFields) {
          if (Object.prototype.hasOwnProperty.call(response.data.updates, k)) filtered[k] = response.data.updates[k];
        }
        if (Object.keys(filtered).length) {
          response.data.updates = filtered;
        }
      }
    }

    // Si el usuario está reclamando error, nunca dispares acciones destructivas en esa misma frase.
    const complaintGuard = /(equivoc|no era|incorrect|mal|error)/i.test(normalizeForMatch(String(effectiveMessage || '')));
    if (complaintGuard && (response.action === 'PRODUCT_DELETE' || response.action === 'BULK_ACTION' || response.action === 'SYNC_FROM_URL')) {
      response = {
        message: 'Entendido, no ejecuto más borrados por ahora. Dime cuál producto exacto quieres conservar y cuál eliminar.',
        action: null,
        data: null
      };
    }

    // Si el admin confirma una acción sensible pendiente, la reutilizamos tal cual.
    const freshPending = ramiroPendingConfirmations.get(adminKey);
    if (isExplicitConfirmation(String(effectiveMessage || '')) && freshPending && freshPending.expiresAt >= Date.now()) {
      response = {
        ...freshPending.response,
        message: freshPending.response?.message || 'Confirmado. Ejecutando acción pendiente.'
      };
      if (!plan && freshPending.plan) {
        plan = freshPending.plan;
      }
      ramiroPendingConfirmations.delete(adminKey);
    }

    // Confirmación obligatoria para acciones riesgosas o plan marcado como riesgoso.
    const mustConfirmRisk = false;

    // Ejecutar acción si viene
    let actionResult = null;
    const ALLOWED_UPDATE_FIELDS = [
      'name',
      'slug',
      'category',
      'description',
      'price',
      'original_price',
      'active',
      'stock',
      'badge',
      'sort_order',
      'image_url',
      'image_urls',
      'variants',
      'color_variants',
      'specs',
      'logos',
      'ficha',
      'img_fit',
      'img_pos',
      'img_scale',
      'detail_img_scale',
      'enable_installments'
    ];

    if (response.action === 'PRODUCT_UPDATE' && response.data?.productId) {
      try {
        let targetProd = allProducts.find(p => p.id === response.data.productId);
        // Fallback: buscar por slug si Gemini devuelve slug en lugar de ID
        if (!targetProd) {
          targetProd = allProducts.find(p => p.slug === response.data.productId);
        }
        if (!targetProd) throw new Error(`Producto no encontrado: ${response.data.productId}`);

        const updates = response.data.updates || {};
        const cleanUpdates = {};

        for (const key of Object.keys(updates)) {
          if (!ALLOWED_UPDATE_FIELDS.includes(key)) {
            console.warn(`[Ramiro] Campo no permitido en UPDATE: ${key}`);
            continue;
          }
          let val = updates[key];
          if (key === 'price' || key === 'stock') val = Number(val) || 0;
          if (key === 'active') val = Boolean(val);
          if (key === 'variants' && !Array.isArray(val)) val = [];
          if (key === 'color_variants') {
            if (!Array.isArray(val)) val = [];
            const hasObjectColors = val.some(c => c && typeof c === 'object');
            if (hasObjectColors) {
              const out = [];
              const seen = new Set();
              for (const c of val) {
                if (!c || typeof c !== 'object') continue;
                const name = String(c.name || c.label || '').trim();
                if (!name) continue;
                const normalizedName = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
                const keyName = normalizedName.toLowerCase();
                if (seen.has(keyName)) continue;
                seen.add(keyName);
                const caps = Array.isArray(c.available_caps)
                  ? Array.from(new Set(c.available_caps.map(x => String(x).replace(/\s+/g, '').toUpperCase())))
                  : [];
                out.push({ ...c, name: normalizedName, available_caps: caps });
              }
              val = out;
            } else {
              const normalized = val
                .map(c => typeof c === 'string' ? c : String(c?.label || c?.name || ''))
                .map(c => c ? c.charAt(0).toUpperCase() + c.slice(1).toLowerCase() : '')
                .filter(Boolean);
              const out = [];
              const seen = new Set();
              for (const c of normalized) {
                const k = c.toLowerCase();
                if (!seen.has(k)) {
                  seen.add(k);
                  out.push(c);
                }
              }
              val = out;
            }
          }
          if (key === 'specs' && typeof val !== 'object') val = {};
          cleanUpdates[key] = val;
        }

        if (Object.keys(cleanUpdates).length === 0) throw new Error('No hay cambios válidos para aplicar');

        // Usar el ID real del producto encontrado (en caso que Gemini haya pasado slug)
        const realProductId = targetProd.id;
        await db.collection('products').doc(realProductId).update({ ...cleanUpdates, updatedAt: new Date() });
        const changes = Object.keys(cleanUpdates).map(k => `${k}: ${JSON.stringify(cleanUpdates[k]).slice(0, 30)}`).join(' | ');
        actionResult = { ok: true, type: 'update', productId: realProductId, productName: targetProd.name, changes };
        rememberFacts(adminKey, [
          { key: 'last_action_type', value: 'PRODUCT_UPDATE', reason: 'Decisión ejecutada recientemente' },
          { key: 'last_product_id', value: String(realProductId), reason: 'Último producto afectado' },
          { key: 'last_product_name', value: String(targetProd.name || ''), reason: 'Último producto afectado' },
        ]).catch(() => {});
        setRamiroSessionContext(adminKey, {
          lastProductId: realProductId,
          lastProductName: targetProd.name,
          pendingProductName: null,
          pendingProductSlug: null,
          pendingProductCategory: null,
        });
      } catch(e) { actionResult = { ok: false, error: e.message }; }
    }

    else if (response.action === 'PRODUCT_DELETE' && response.data?.productId) {
      try {
        let targetProd = allProducts.find(p => p.id === response.data.productId);
        // Fallback: buscar por slug
        if (!targetProd) {
          targetProd = allProducts.find(p => p.slug === response.data.productId);
        }
        if (!targetProd) throw new Error(`Producto no encontrado: ${response.data.productId}`);
        
        await db.collection('products').doc(targetProd.id).delete();
        actionResult = { ok: true, type: 'delete', productId: targetProd.id, name: targetProd.name };
        rememberFacts(adminKey, [
          { key: 'last_action_type', value: 'PRODUCT_DELETE', reason: 'Decisión ejecutada recientemente' },
          { key: 'last_product_id', value: String(targetProd.id), reason: 'Último producto afectado' },
          { key: 'last_product_name', value: String(targetProd.name || ''), reason: 'Último producto afectado' },
        ]).catch(() => {});
        setRamiroSessionContext(adminKey, {
          lastProductId: null,
          lastProductName: null,
          pendingProductName: null,
          pendingProductSlug: null,
          pendingProductCategory: null,
        });
      } catch(e) { actionResult = { ok: false, error: e.message }; }
    }

    else if (response.action === 'BULK_ACTION') {
      try {
        let targets = allProducts;
        const filter = response.data.filter || '';
        if (filter === 'sin_imagen') targets = allProducts.filter(p => !p.image_url);
        else if (filter === 'inactivos') targets = allProducts.filter(p => !p.active);
        else if (filter.startsWith('categoria:')) targets = allProducts.filter(p => p.category === filter.split(':')[1]);

        if (targets.length === 0) throw new Error('No hay productos que coincidan con el filtro');

        const action = response.data.action;
        if (action === 'delete') {
          await Promise.all(targets.map(p => db.collection('products').doc(p.id).delete()));
        } else if (action === 'deactivate') {
          await Promise.all(targets.map(p => db.collection('products').doc(p.id).update({ active: false, updatedAt: new Date() })));
        } else if (action === 'activate') {
          await Promise.all(targets.map(p => db.collection('products').doc(p.id).update({ active: true, updatedAt: new Date() })));
        }
        actionResult = { ok: true, type: 'bulk', affected: targets.length, filter, action };
      } catch(e) { actionResult = { ok: false, error: e.message }; }
    }

    else if (response.action === 'REMEMBER' && response.data?.entry) {
      const current = ramiro.memory || [];
      const newMemory = [{ text: response.data.entry, date: new Date().toISOString() }, ...current].slice(0, 100);
      await db.collection('settings').doc('ramiro').set({ memory: newMemory }, { merge: true });
      actionResult = { ok: true, type: 'memory' };
    }

    else if (response.action === 'PRODUCT_CREATE' && response.data?.product) {
      try {
        const prod = response.data.product;
        if (!prod.name) throw new Error('Falta nombre del producto');
        if (!prod.category || !['mac', 'iphone', 'ipad', 'airpods'].includes(prod.category.toLowerCase())) 
          throw new Error(`Categoría inválida: ${prod.category}. Usa: mac, iphone, ipad, airpods`);
        
        const price = Number(prod.price) || 0;
        if (price <= 0) throw new Error('Precio debe ser > 0');

        const slug = prod.slug || slugify(prod.name);
        const existing = allProducts.find(p => p.slug === slug);
        if (existing) {
          const updates = { updatedAt: new Date() };
          if (Number.isFinite(price) && price > 0) updates.price = price;
          if (prod.description) updates.description = String(prod.description).slice(0, 2000);
          if (Array.isArray(prod.variants)) updates.variants = prod.variants;
          if (Array.isArray(prod.color_variants)) {
            const normalized = prod.color_variants
              .map(c => typeof c === 'string' ? c : String(c?.label || c?.name || ''))
              .map(c => c ? c.charAt(0).toUpperCase() + c.slice(1).toLowerCase() : '')
              .filter(Boolean);
            updates.color_variants = Array.from(new Set(normalized.map(c => c.toLowerCase())))
              .map(k => normalized.find(c => c.toLowerCase() === k));
          }
          if (prod.image_url) updates.image_url = String(prod.image_url);
          if (prod.specs && typeof prod.specs === 'object') updates.specs = prod.specs;
          if (prod.badge) updates.badge = String(prod.badge);
          if (prod.stock !== undefined) updates.stock = Number(prod.stock) || 0;

          await db.collection('products').doc(existing.id).update(updates);
          actionResult = { ok: true, type: 'upsert-update', id: existing.id, name: existing.name, price: updates.price || existing.price };
          rememberFacts(adminKey, [
            { key: 'last_action_type', value: 'PRODUCT_CREATE', reason: 'Decisión ejecutada recientemente' },
            { key: 'last_product_id', value: String(existing.id), reason: 'Último producto afectado' },
            { key: 'last_product_name', value: String(existing.name || ''), reason: 'Último producto afectado' },
          ]).catch(() => {});
          setRamiroSessionContext(adminKey, {
            lastProductId: existing.id,
            lastProductName: prod.name,
            pendingProductName: null,
            pendingProductSlug: null,
            pendingProductCategory: null,
          });
        } else {
          const ref = await db.collection('products').add({
            name: String(prod.name || '').trim().slice(0, 160),
            slug,
            category: String(prod.category).toLowerCase(),
            price,
            description: String(prod.description || `${prod.name} disponible en MacStore.`).slice(0, 2000),
            variants: Array.isArray(prod.variants) ? prod.variants : [],
            color_variants: Array.isArray(prod.color_variants) ? prod.color_variants : [],
            specs: typeof prod.specs === 'object' ? prod.specs : {},
            stock: Number(prod.stock) || 0,
            active: true,
            badge: prod.badge || '',
            image_url: prod.image_url || '',
            createdAt: new Date(),
            updatedAt: new Date()
          });
          actionResult = { ok: true, type: 'create', id: ref.id, name: prod.name, price };
          rememberFacts(adminKey, [
            { key: 'last_action_type', value: 'PRODUCT_CREATE', reason: 'Decisión ejecutada recientemente' },
            { key: 'last_product_id', value: String(ref.id), reason: 'Último producto afectado' },
            { key: 'last_product_name', value: String(prod.name || ''), reason: 'Último producto afectado' },
          ]).catch(() => {});
          setRamiroSessionContext(adminKey, {
            lastProductId: ref.id,
            lastProductName: prod.name,
            pendingProductName: null,
            pendingProductSlug: null,
            pendingProductCategory: null,
          });
        }
      } catch(e) { actionResult = { ok: false, error: e.message }; }
    }

    else if (response.action === 'SYNC_FROM_URL' && response.data?.url) {
      try {
        const url = cleanText(response.data.url, 2000);
        // Usar el nuevo ramiroUrlReader con cheerio para mejor extracción
        const extracted = await extractProductsFromUrl(url);
        let syncResult;
        if (extracted.length) {
          // syncProductsFromArray hace el upsert por slug directamente
          syncResult = await syncProductsFromArray(extracted, url);
        } else {
          // Fallback: leer contenido de la página y pasarlo a Gemini
          const { rawText } = await readUrlContent(url);
          throw new Error('URL processing requires external API call - not implemented in this scope');
        }
        actionResult = { ok: true, type: 'sync', ...syncResult };
      } catch(e) {
        actionResult = { ok: false, error: e.message };
      }
    }

    // ── APRENDIZAJE AUTOMÁTICO DE PATRONES ───────────────────────────────
    // Limpiar entrada expirada
    const clarPending = ramiroLastClarification.get(adminKey);
    if (clarPending && clarPending.expiresAt < Date.now()) {
      ramiroLastClarification.delete(adminKey);
    }

    if (actionResult?.ok) {
      // Si había una aclaración pendiente y la acción salió bien → aprender el patrón
      const pendingClar = ramiroLastClarification.get(adminKey);
      if (pendingClar && pendingClar.expiresAt >= Date.now()) {
        const learnedEntry = buildLearnedMemoryEntry(pendingClar.originalMessage, response.action, response.data, actionResult, allProducts);
        if (learnedEntry) {
          // Guardar en nueva colección ramiro_memory por userId (módulo nuevo)
          learnPattern(adminKey, pendingClar.originalMessage, learnedEntry).catch(() => {});
          // Guardar también en colección settings/ramiro legada (fire-and-forget)
          (async () => {
            try {
              const ramiroRef = db.collection('settings').doc('ramiro');
              const ramiroSnap = await ramiroRef.get();
              const existingMemory = ramiroSnap.exists ? (ramiroSnap.data().memory || []) : [];
              const alreadyLearned = existingMemory.some(m =>
                String(m?.text || m).includes(`"${pendingClar.originalMessage.slice(0, 40)}`)
              );
              if (!alreadyLearned) {
                const newMemory = [
                  { text: learnedEntry, date: new Date().toISOString(), auto: true },
                  ...existingMemory
                ].slice(0, 100);
                await ramiroRef.set({ memory: newMemory }, { merge: true });
              }
            } catch(e) { console.error('[Ramiro] Error guardando patrón aprendido:', e.message); }
          })();
          const patterns = ramiroLearnedPatterns.get(adminKey) || [];
          patterns.unshift({ trigger: pendingClar.originalMessage, meaning: learnedEntry });
          ramiroLearnedPatterns.set(adminKey, patterns.slice(0, 50));
        }
        ramiroLastClarification.delete(adminKey);
      }
    } else {
      // No hubo acción exitosa → si Ramiro hizo una pregunta, guardar el mensaje original del usuario
      const isRamiroAsking = !response.action && String(response.message || '').includes('?');
      if (isRamiroAsking) {
        ramiroLastClarification.set(adminKey, {
          originalMessage: String(message || '').trim(),
          expiresAt: Date.now() + RAMIRO_CLARIF_TTL_MS
        });
      }
    }

    // Persistir toda la conversación (usuario y asistente)
    await appendRamiroTranscript(db, {
      role: 'user',
      text: String(message || ''),
      pageContext: pageContext || '',
      conversationId,
      adminEmail: req.admin?.email || ''
    });

    // Enriquecer mensaje con feedback de acción si hubo error
    let finalMessage = response.message || 'OK';
    if (actionResult?.ok === false && actionResult?.error) {
      finalMessage = `No se pudo completar la acción solicitada.\n\n⚠️ Error: ${actionResult.error}`;
    }

    await appendRamiroTranscript(db, {
      role: 'assistant',
      text: finalMessage,
      conversationId,
      action: response.action || null,
      actionResult: actionResult || null,
      adminEmail: req.admin?.email || ''
    });

    await db.collection('ramiro_chats').add({
      userId: adminKey,
      conversationId,
      message: String(message || ''),
      decision: brainDecision || null,
      intentType: plan?.intentType || response.intentType || null,
      resultType: actionResult?.type || (response.action ? 'action_attempt' : 'message'),
      legacyAction: response.action || null,
      needsClarification: false,
      needsConfirmation: Boolean(plan?.needsConfirmation),
      autoExecuted: false,
      actionOk: actionResult?.ok ?? null,
      createdAt: new Date().toISOString(),
    });

    res.json({
      message: finalMessage,
      conversationId,
      action: response.action,
      data: response.data,
      actionResult,
      intentType: plan?.intentType || response.intentType || null,
      plan: plan ? {
        goal: plan.goal || '',
        needsResearch: plan.needsResearch,
        needsConfirmation: plan.needsConfirmation,
        steps: plan.steps || []
      } : null
    });

  } catch(e) { res.status(500).json({ error: e.message, message: 'Error interno de Ramiro.' }); }
});

router.get('/eval/summary', requireAdminAPI, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 20), 1000);
    const userId = String(req.query.userId || req.admin?.email || req.admin?.id || '').toLowerCase();
    const db = getFirestore();

    let snap;
    if (userId) {
      snap = await db.collection('ramiro_chats').where('userId', '==', userId).limit(limit).get();
    } else {
      snap = await db.collection('ramiro_chats').limit(limit).get();
    }

    let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    rows = rows.sort((a, b) => toEpoch(b.createdAt) - toEpoch(a.createdAt)).slice(0, limit);

    const summary = buildEvalSummary(rows);
    return res.json({
      ok: true,
      userId: userId || null,
      sampleSize: rows.length,
      summary,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/history', requireAdminAPI, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 1200, 100), 3000);
    const adminEmail = String(req.admin?.email || '').toLowerCase();
    const db = getFirestore();
    const snap = await db.collection('ramiro_transcripts').orderBy('createdAt', 'desc').limit(limit).get();
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(r => String(r.adminEmail || '').toLowerCase() === adminEmail);

    const grouped = new Map();
    for (const row of rows) {
      const convId = sanitizeConversationId(row.conversationId) || `legacy_${row.id}`;
      if (!grouped.has(convId)) {
        grouped.set(convId, {
          conversationId: convId,
          lastAt: row.createdAt,
          messageCount: 0,
          firstUserMessage: '',
          lastAssistantMessage: '',
        });
      }
      const g = grouped.get(convId);
      g.messageCount += 1;
      if (!g.firstUserMessage && row.role === 'user') g.firstUserMessage = String(row.text || '').slice(0, 180);
      if (row.role === 'assistant') g.lastAssistantMessage = String(row.text || '').slice(0, 220);
      if (toEpoch(row.createdAt) > toEpoch(g.lastAt)) g.lastAt = row.createdAt;
    }

    const conversations = [...grouped.values()]
      .sort((a, b) => toEpoch(b.lastAt) - toEpoch(a.lastAt))
      .slice(0, 80)
      .map(c => ({
        conversationId: c.conversationId,
        title: c.firstUserMessage || 'Conversación sin título',
        preview: c.lastAssistantMessage || c.firstUserMessage || '',
        messageCount: c.messageCount,
        lastAt: c.lastAt,
      }));

    return res.json({ ok: true, conversations });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/history/:conversationId', requireAdminAPI, async (req, res) => {
  try {
    const conversationId = sanitizeConversationId(req.params.conversationId);
    if (!conversationId) return res.status(400).json({ ok: false, error: 'conversationId inválido' });

    const limit = Math.min(Math.max(Number(req.query.limit) || 1200, 100), 3000);
    const adminEmail = String(req.admin?.email || '').toLowerCase();
    const db = getFirestore();
    const snap = await db.collection('ramiro_transcripts').orderBy('createdAt', 'desc').limit(limit).get();
    const messages = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(r => String(r.adminEmail || '').toLowerCase() === adminEmail)
      .filter(r => sanitizeConversationId(r.conversationId) === conversationId)
      .sort((a, b) => toEpoch(a.createdAt) - toEpoch(b.createdAt))
      .map(r => ({
        role: r.role,
        text: r.text,
        createdAt: r.createdAt,
        action: r.action || null,
        actionResult: r.actionResult || null,
      }));

    return res.json({ ok: true, conversationId, messages });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
