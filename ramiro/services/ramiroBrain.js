'use strict';

const https = require('https');
const { buildRamiroSystemPrompt } = require('../config/ramiroSystemPrompt');
const { safeJsonParse, translateBrainToLegacy } = require('../utils/ramiroHelpers');
const { getUserMemory, rememberFacts, formatMemoryForPrompt } = require('./ramiroMemory');

const CANDIDATE_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-pro',
];

function getGeminiApiKeys() {
  const candidates = [
    process.env.GOOGLE_AI_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.CLAVE_API_IA_GOOGLE,
    process.env.CLAVE_API_GEMINIS,
    process.env['CLAVE_API_GÉMINIS'],
  ]
    .map(v => String(v || '').trim())
    .filter(Boolean);

  return [...new Set(candidates)];
}

/**
 * Llama a la API de Gemini con el prompt dado y devuelve el texto bruto.
 * @param {string} prompt
 * @param {number} [temperature=0.25] - 0.25 para JSON estructurado, 0.8 para conversación libre
 */
async function callGeminiBrain(prompt, temperature = 0.25) {
  const geminiApiKeys = getGeminiApiKeys();
  if (!geminiApiKeys.length) {
    throw new Error('Faltan GOOGLE_AI_API_KEY y GEMINI_API_KEY en variables de entorno');
  }

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens: 4096 },
  });

  let lastError = null;
  for (const apiKey of geminiApiKeys) {
    for (const model of CANDIDATE_MODELS) {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      try {
        const text = await new Promise((resolve, reject) => {
          const u = new URL(geminiUrl);
          const req = https.request({
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                if (parsed.error?.message) return reject(new Error(parsed.error.message));
                const out = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                resolve(out);
              } catch (e) { reject(e); }
            });
          });
          req.on('error', reject);
          req.write(body);
          req.end();
        });

        if (text) return text;
        lastError = new Error(`Respuesta vacía del modelo ${model}`);
      } catch (e) {
        lastError = e;
        const msg = String(e?.message || '').toLowerCase();
        if (!msg.includes('not found') && !msg.includes('not supported') && !msg.includes('model')) break;
      }
    }
  }
  throw lastError || new Error('No fue posible obtener respuesta de Gemini');
}

/**
 * Fallback seguro cuando Gemini no retorna JSON válido o la confianza es muy baja.
 */
function buildFallbackDecision(userMessage, question = null, rawResponse = null) {
  const cleanRaw = String(rawResponse || '').trim();
  const hasUsefulRaw = cleanRaw.length >= 12 && !isLowValueConversationText(cleanRaw);
  let fallbackText;
  if (hasUsefulRaw) {
    fallbackText = cleanRaw.slice(0, 2200);
  } else if (question) {
    fallbackText = question;
  } else {
    const msgLower = String(userMessage || '').toLowerCase();
    const isOperational = isLikelyOperationalMessage(userMessage);
    const hasPriceSignal = msgLower.includes('precio')
      || /\$\s*[0-9]{2,6}/.test(msgLower)
      || /[0-9]{2,6}\s*(usd|dolares|dólares)/.test(msgLower);
    if (isOperational && hasPriceSignal) {
      fallbackText = 'Disculpa, no pude cerrar bien el cambio de precio. Dime el producto y el monto, por ejemplo: cambiar precio de iPhone 15 a $899.';
    } else if (isOperational && (msgLower.includes('imagen') || msgLower.includes('foto') || msgLower.match(/https?:\/\//))) {
      fallbackText = 'Disculpa, el cambio de imagen quedó incompleto. Dime primero el producto y luego me mandas el URL.';
    } else if (isOperational && (msgLower.includes('crear') || msgLower.includes('nuevo'))) {
      fallbackText = 'Para crear el producto necesito al menos nombre, categoría y precio. Si quieres, te lo voy pidiendo paso a paso.';
    } else if (!isOperational || isLikelyGeneralConversation(userMessage)) {
      fallbackText = buildOfflineGeneralConversationText(userMessage)
        || 'No te voy a responder con relleno. En este momento no salió una respuesta útil de la IA; vuelve a enviarme la pregunta y la rehago de forma directa.';
    } else {
      fallbackText = 'Entendí que quieres hacer un cambio, pero me faltó contexto para ejecutarlo. Dime qué producto quieres tocar y qué campo quieres cambiar.';
    }
  }

  return {
    mode: hasUsefulRaw ? 'general' : 'clarification',
    intent: 'fallback_no_parse',
    confidence: 0,
    requiresConfirmation: false,
    needsClarification: !hasUsefulRaw,
    understood: hasUsefulRaw
      ? 'Respuesta conversacional recuperada de salida no estructurada.'
      : 'No pude interpretar la intención con seguridad.',
    entity: { type: 'unknown', id: null, name: null, filters: {}, matches: [] },
    action: hasUsefulRaw ? { type: 'answer', payload: {} } : { type: 'ask', payload: {} },
    question: hasUsefulRaw ? null : fallbackText,
    response: fallbackText,
    memory: { shouldRemember: false, facts: [] },
  };
}

function isGenericClarificationText(text = '') {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return true;
  return t.includes('en que te puedo ayudar')
    || t.includes('que quieres hacer exactamente')
    || t.includes('no pude procesar bien ese mensaje')
    || t.includes('no entendi bien tu solicitud');
}

function isLowValueConversationText(text = '') {
  const t = String(text || '').trim();
  if (!t) return true;
  const n = normalizeForIntent(t);
  if (!n) return true;

  if (isGenericClarificationText(t)) return true;

  const fillerOnlyPatterns = [
    /^te leo\.? sobre .+ te respondo directo\.?$/i,
    /^entiendo tu punto sobre .+ vamos al grano\.?$/i,
    /^buen tema\:? .+ te doy una respuesta clara\.?$/i,
    /^va\,? hablemos de .+ respuesta directa\:?$/i,
    /^claro\.? si quieres\,? te hablo de .+ en corto y directo\.?$/i,
  ];

  if (fillerOnlyPatterns.some((re) => re.test(n))) return true;

  const looksLikeShortMetaPrefix = /^(te leo|entiendo tu punto|buen tema|va hablemos)/i.test(n)
    && n.split(' ').length <= 14;
  if (looksLikeShortMetaPrefix) return true;

  return false;
}

function normalizeForIntent(text = '') {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findProductByRef(products = [], ref = '', fallbackProduct = null) {
  const raw = String(ref || '').trim();
  if (!raw) return fallbackProduct || null;

  const byId = products.find(p => String(p?.id || '') === raw);
  if (byId) return byId;

  const q = normalizeForIntent(raw);
  const bySlug = products.find(p => normalizeForIntent(String(p?.slug || '')) === q);
  if (bySlug) return bySlug;

  const byExactName = products.find(p => normalizeForIntent(String(p?.name || '')) === q);
  if (byExactName) return byExactName;

  const byContains = products.find(p => normalizeForIntent(String(p?.name || '')).includes(q));
  if (byContains) return byContains;

  return fallbackProduct || null;
}

function buildDeterministicGuidanceDecision(userMessage = '', allProducts = [], implicitProduct = null) {
  const msg = String(userMessage || '').trim();
  if (!msg) return null;
  const n = normalizeForIntent(msg);

  const importByLinkIntent = /(te paso).*(link|url|enlace).*(catalogo|catalogo|productos?)|importas?.*(catalogo|catalogo|productos?)/i.test(n)
    || /(revisa|mira|lee).*(catalogo|catalogo).*(enlace|link|url)/i.test(n);
  if (importByLinkIntent && !/https?:\/\//i.test(msg)) {
    return {
      mode: 'general',
      intent: 'deterministic_catalog_url_guidance',
      confidence: 0.99,
      requiresConfirmation: false,
      needsClarification: false,
      understood: 'El usuario quiere importar/revisar catálogo por URL y aún no envía enlace.',
      entity: { type: 'unknown', id: null, name: null, filters: {}, matches: [] },
      action: { type: 'answer', payload: {} },
      question: null,
      response: 'Pásame la URL completa del catálogo y lo reviso. Debe ser una URL pública (no localhost ni IP privada).',
      memory: { shouldRemember: false, facts: [] },
    };
  }

  const imageChangeIntent = /(quiero\s+cambiar\s+la\s+imagen\s+de|cambiar\s+imagen\s+de|actualizar\s+imagen\s+de|poner\s+imagen\s+de)/i.test(n);
  if (imageChangeIntent) {
    const refMatch = msg.match(/(?:quiero\s+cambiar\s+la\s+imagen\s+de|cambiar\s+imagen\s+de|actualizar\s+imagen\s+de|poner\s+imagen\s+de)\s+(.+)$/i);
    const ref = refMatch ? String(refMatch[1] || '').trim() : '';
    let targetProd = findProductByRef(allProducts, ref, implicitProduct);
    if (!targetProd && ref) {
      const refTokens = normalizeForIntent(ref)
        .split(' ')
        .map(t => t.trim())
        .filter(t => t && t.length >= 2 && !['de', 'del', 'la', 'el', 'los', 'las'].includes(t));

      if (refTokens.length) {
        const ranked = allProducts
          .map(p => {
            const nameNorm = normalizeForIntent(String(p?.name || ''));
            let score = 0;
            for (const tk of refTokens) {
              if (nameNorm.includes(tk)) score += 1;
            }
            return { p, score };
          })
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score);
        if (ranked.length && ranked[0].score >= Math.min(2, refTokens.length)) {
          targetProd = ranked[0].p;
        }
      }
    }
    if (targetProd) {
      return {
        mode: 'general',
        intent: 'deterministic_image_url_guidance',
        confidence: 0.99,
        requiresConfirmation: false,
        needsClarification: false,
        understood: `Solicitar URL para cambiar imagen de ${targetProd.name}`,
        entity: { type: 'product', id: targetProd.id, name: targetProd.name, filters: {}, matches: [] },
        action: { type: 'answer', payload: {} },
        question: null,
        response: `¿Cuál es la URL de la imagen que quieres agregar a **${targetProd.name}**?`,
        memory: { shouldRemember: false, facts: [] },
      };
    }

    const fallbackRef = ref || 'ese producto';
    return {
      mode: 'general',
      intent: 'deterministic_image_url_guidance_fallback',
      confidence: 0.9,
      requiresConfirmation: false,
      needsClarification: false,
      understood: `Solicitar URL para cambiar imagen de ${fallbackRef}`,
      entity: { type: 'unknown', id: null, name: fallbackRef, filters: {}, matches: [] },
      action: { type: 'answer', payload: {} },
      question: null,
      response: `Entendido. ¿Cuál es la URL de la imagen para ${fallbackRef}?`,
      memory: { shouldRemember: false, facts: [] },
    };
  }

  return null;
}

function buildDeterministicOperationalDecision(userMessage = '', allProducts = [], implicitProduct = null) {
  const msg = String(userMessage || '').trim();
  if (!msg) return null;

  const pricePatterns = [
    /precio\s+(?:de|del)\s+(.+?)\s+(?:a|en)\s*\$?\s*([0-9]{2,6}(?:[\.,][0-9]{1,2})?)/i,
    /(?:pon|poner|ponle|cambia|actualiza|sube|baja)\s+(?:el\s+)?precio\s+(?:de|del)?\s*([0-9]{2,6}(?:[\.,][0-9]{1,2})?)\s+(?:a|al|para)\s+(.+?)$/i,
    /(?:pon|poner|ponle|cambia|actualiza|sube|baja)\s+(?:el\s+)?precio\s+(?:de|del)?\s*(.+?)\s*(?:a|en|,)\s*\$?\s*([0-9]{2,6}(?:[\.,][0-9]{1,2})?)/i,
  ];

  for (const re of pricePatterns) {
    const m = msg.match(re);
    if (!m) continue;

    let targetRef = '';
    let price = NaN;
    const num1 = Number(String(m[1]).replace(',', '.'));
    const num2 = Number(String(m[2]).replace(',', '.'));

    if (Number.isFinite(num1) && num1 > 0 && !Number.isFinite(num2)) {
      price = num1;
      targetRef = String(m[2] || '');
    } else if (Number.isFinite(num2) && num2 > 0) {
      price = num2;
      targetRef = String(m[1] || '');
    }

    const targetProd = findProductByRef(allProducts, targetRef, implicitProduct);
    if (targetProd && Number.isFinite(price) && price > 0) {
      return {
        mode: 'operational',
        intent: 'deterministic_price_update',
        confidence: 0.98,
        requiresConfirmation: false,
        needsClarification: false,
        understood: `Actualizar precio de ${targetProd.name} a ${price}`,
        entity: { type: 'product', id: targetProd.id, name: targetProd.name, filters: {}, matches: [] },
        action: {
          type: 'update',
          payload: {
            productId: targetProd.id,
            updates: { price },
          },
        },
        question: null,
        response: `✅ actualizado precio de ${targetProd.name} a $${price}`,
        memory: { shouldRemember: false, facts: [] },
      };
    }

  }

  const capCmd = msg.match(/(?:habilita|habilitar|activa|activar)\s+([0-9]{2,4}\s?gb)\s+para\s+(.+)$/i);
  if (capCmd) {
    const capacity = String(capCmd[1]).replace(/\s+/g, '').toUpperCase();
    const targetRaw = String(capCmd[2] || '').trim();
    let targetProd = findProductByRef(allProducts, targetRaw, implicitProduct);
    let colorName = '';

    if (!targetProd) {
      const colors = ['negro', 'blanco', 'azul', 'verde', 'lavanda', 'rosa', 'rojo', 'dorado', 'plata', 'morado', 'amarillo'];
      const targetNorm = normalizeForIntent(targetRaw);
      const colorTail = colors.find(c => targetNorm.endsWith(` ${c}`) || targetNorm === c);
      if (colorTail) {
        const productPart = targetRaw.slice(0, Math.max(0, targetRaw.length - colorTail.length)).trim();
        targetProd = findProductByRef(allProducts, productPart, implicitProduct);
        colorName = colorTail;
      }
    } else {
      const rawNorm = normalizeForIntent(targetRaw);
      const prodNorm = normalizeForIntent(targetProd.name || '');
      colorName = rawNorm.replace(prodNorm, '').trim();
    }

    if (targetProd) {
      const updates = {};
      const currentVariants = Array.isArray(targetProd.variants) ? [...targetProd.variants] : [];
      const hasCap = currentVariants.some(v => String(v?.label || '').toUpperCase() === capacity);
      if (!hasCap) {
        currentVariants.push({ label: capacity, price: Number(targetProd.price) || 1, stock: 0 });
      }
      updates.variants = currentVariants;

      const currentColors = Array.isArray(targetProd.color_variants) ? [...targetProd.color_variants] : [];
      const hasObjectColors = currentColors.some(c => c && typeof c === 'object');
      if (hasObjectColors && colorName) {
        const normalizedColor = colorName.charAt(0).toUpperCase() + colorName.slice(1).toLowerCase();
        let found = false;
        const updatedColors = currentColors.map(c => {
          if (!c || typeof c !== 'object') return c;
          const nameNorm = normalizeForIntent(String(c.name || ''));
          if (nameNorm === normalizeForIntent(normalizedColor)) {
            found = true;
            const caps = Array.isArray(c.available_caps) ? [...c.available_caps] : [];
            if (!caps.some(x => String(x).toUpperCase() === capacity)) caps.push(capacity);
            return { ...c, enabled: true, available_caps: caps };
          }
          return c;
        });
        if (!found) {
          updatedColors.push({ name: normalizedColor, enabled: true, available_caps: [capacity] });
        }
        updates.color_variants = updatedColors;
      }

      return {
        mode: 'operational',
        intent: 'deterministic_capacity_enable',
        confidence: 0.97,
        requiresConfirmation: false,
        needsClarification: false,
        understood: `Habilitar ${capacity} en ${targetProd.name}${colorName ? ` (${colorName})` : ''}`,
        entity: { type: 'product', id: targetProd.id, name: targetProd.name, filters: {}, matches: [] },
        action: {
          type: 'update',
          payload: {
            productId: targetProd.id,
            updates,
          },
        },
        question: null,
        response: `✅ habilitado ${capacity}${colorName ? ` para ${colorName}` : ''} en ${targetProd.name}`,
        memory: { shouldRemember: false, facts: [] },
      };
    }
  }

  return null;
}

function hasOperationalSignals(text = '') {
  const n = normalizeForIntent(text);
  if (!n) return false;

  const hasUrl = /https?:\/\//i.test(String(text || ''));
  const actionVerbs = [
    'crear', 'crea', 'agregar', 'agrega', 'anadir', 'anade',
    'editar', 'edita', 'actualizar', 'actualiza', 'cambiar', 'cambia', 'modificar', 'modifica',
    'eliminar', 'elimina', 'borrar', 'borra', 'activar', 'activa', 'desactivar', 'desactiva',
    'ocultar', 'oculta', 'mostrar', 'muestra',
    'poner', 'pon', 'ponle', 'subir', 'sube', 'quitar', 'quita',
    'importar', 'importa', 'sincronizar', 'sincroniza', 'extraer', 'extrae',
    'completar', 'completa', 'rellenar', 'rellena', 'cotizar'
  ];
  const catalogTargets = [
    'producto', 'productos', 'catalogo', 'categoria', 'precio', 'imagen', 'foto',
    'color', 'colores', 'stock', 'variante', 'variantes', 'banner', 'anuncio',
    'cotizacion', 'cotizaciones'
  ];

  const hasAction = actionVerbs.some(k => n.includes(k));
  const hasTarget = catalogTargets.some(k => n.includes(k));
  const hasStrongCatalogCommand = /(pon|poner|ponle|cambia|cambiar|actualiza|actualizar|edita|editar|modifica|modificar|agrega|agregar|anade|añade|crea|crear|elimina|eliminar|borra|borrar|quita|quitar|activa|activar|desactiva|desactivar|oculta|ocultar|muestra|mostrar|importa|importar|sincroniza|sincronizar|extrae|extraer|habilita|habilitar).*(producto|productos|catalogo|precio|imagen|foto|color|colores|stock|variante|variantes|cotizacion|cotizaciones)|(?:precio|imagen|foto|color|stock)\s+(?:de|del)\s+/i.test(n);
  const isQuestionLike = /[?¿]/.test(String(text || ''))
    || /(como|que|cual|cuanto|por que|me ayudas|puedes ayudar|ayudame|ayudarme|explica|opinas|te parece|entiendo|entender|diferencia|recomiendas)/i.test(n);
  const isExplainerQuestion = /(me ayudas a entender|ayudame a entender|explicame|explica|que te parece|que opinas|como funciona|como hago|no se como)/i.test(n);

  if (isQuestionLike && isExplainerQuestion && !hasStrongCatalogCommand) return false;

  if (hasUrl && /(import|sincron|extra|leer|imagen|foto|producto)/.test(n)) return true;
  if (hasStrongCatalogCommand) return true;

  const hasSearchCommand = /(busca|buscar|encuentra|filtra|lista|listar)\s+/.test(n) && hasTarget;
  if (hasSearchCommand && !isExplainerQuestion) return true;

  return hasAction && hasTarget && !isExplainerQuestion;
}

function buildHumanFallbackReply(userMessage = '') {
  const topic = String(userMessage || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const n = normalizeForIntent(topic);
  if (!topic) return '';

  if (/^(si|sí|ok|dale|va|aja|aj[aá]|correcto|claro)\s*[.!?]*$/i.test(topic)) {
    return 'Sí. Dime qué quieres que haga o de qué tema quieres que te hable, y te respondo directo.';
  }

  if (/^(?:me\s+)?(?:puedes\s+)?ayuda(?:r|s|rme|me)?\s*[.!?]*$/i.test(n) || /^(ayuda|ayudame|ayudame)\s*[.!?]*$/i.test(n)) {
    return 'Aquí estoy para ayudarte de verdad. Puedo buscar productos, cambiar precio, imagen, colores o stock, activar o desactivar, crear productos, borrar con confirmación y ayudarte con cotizaciones. Dime qué necesitas y lo hago.';
  }

  if (/habla(?:me)?\s+de|cuentame\s+de|explica(?:me)?\s+/i.test(n)) {
    const subject = topic.replace(/^(habla(?:me)?\s+de|cuentame\s+de|explica(?:me)?\s+)/i, '').trim();
    return subject ? `Puedo hablarte de ${subject}, pero si la IA no devuelve contenido útil prefiero intentarlo de nuevo antes que responderte con relleno.` : '';
  }

  return '';
}

function isLikelyGeneralConversation(text = '') {
  const n = normalizeForIntent(text);
  if (!n) return false;
  return !hasOperationalSignals(text);
}

function isLikelyOperationalMessage(text = '') {
  return hasOperationalSignals(text);
}

function buildOfflineGeneralConversationText(userMessage = '') {
  return buildHumanFallbackReply(userMessage);
}

function buildOfflineGeneralDecision(userMessage = '') {
  const text = buildOfflineGeneralConversationText(userMessage);
  if (!text) return null;
  return {
    mode: 'general',
    intent: 'offline_general_fallback',
    confidence: 0.35,
    requiresConfirmation: false,
    needsClarification: false,
    understood: 'Pregunta general atendida con fallback local por indisponibilidad temporal del modelo.',
    entity: { type: 'unknown', id: null, name: null, filters: {}, matches: [] },
    action: { type: 'answer', payload: {} },
    question: null,
    response: text,
    memory: { shouldRemember: false, facts: [] },
  };
}

async function buildGeneralConversationText({ storeName = 'MacStore', userMessage = '', recentHistory = '' }) {
  const msg = String(userMessage || '').trim();
  if (!msg) return '';

  const prompt = `Eres Ramiro, asistente conversacional de ${storeName}.
Responde en español, de forma natural, útil, específica y directa a este mensaje del usuario.
Prohibido responder con frases de relleno como: "entiendo tu punto", "buen tema", "vamos al grano", "te respondo directo" sin desarrollar la respuesta.
Responde entrando al contenido en la primera oración.
Si el usuario hace una pregunta abierta, dale una respuesta real de al menos 2 oraciones con información concreta.
Si el usuario dice algo breve como "sí", usa el contexto reciente para continuar con sentido.
No uses JSON, no menciones reglas internas, no pidas formato especial.

${recentHistory ? `Contexto reciente:\n${recentHistory}\n` : ''}

Usuario: ${msg}`;

  const retryPrompt = `Eres Ramiro, asistente conversacional de ${storeName}.
Tu respuesta anterior fue descartada por genérica o vacía.
Ahora responde SOLO con contenido útil y específico, sin introducciones tipo "entiendo tu punto", "buen tema" o "vamos al grano".
Empieza respondiendo el contenido del mensaje en la primera línea.
Si el usuario pide explicación, explícale de verdad.
Si el usuario dice "sí" o algo corto, continúa la conversación usando el contexto reciente.

${recentHistory ? `Contexto reciente:\n${recentHistory}\n` : ''}
Usuario: ${msg}`;

  try {
    const text = await callGeminiBrain(prompt);
    const out = String(text || '').trim();
    if (!isLowValueConversationText(out)) return out;

    const retryText = await callGeminiBrain(retryPrompt, 0.85);
    const retryOut = String(retryText || '').trim();
    return isLowValueConversationText(retryOut) ? '' : retryOut;
  } catch {
    return '';
  }
}

/**
 * Función principal del brain. Recibe contexto completo y devuelve decisión estructurada.
 *
 * @param {object} opts
 * @param {string} opts.userMessage - Mensaje del usuario
 * @param {string} opts.userId - Email del admin (para memoria por usuario)
 * @param {string} opts.storeName
 * @param {string} opts.personality
 * @param {string} opts.notes
 * @param {boolean} opts.autonomousMode
 * @param {Array}  opts.allProducts - Array de todos los productos [{id, name, category, price, active, ...}]
 * @param {object|null} opts.implicitProduct - Producto en contexto actual
 * @param {string} opts.persistentHistory - Historial de conversación como texto
 * @param {string} opts.quoteSummary - Resumen de cotizaciones
 * @param {string} opts.recentHistory - Historial de la sesión actual
 */
async function thinkRamiro(opts) {
  const {
    userMessage = '',
    userId = 'admin',
    storeName = 'MacStore',
    personality = '',
    notes = '',
    autonomousMode = true,
    allProducts = [],
    implicitProduct = null,
    persistentHistory = '',
    quoteSummary = '',
    recentHistory = '',
    projectContext = '',
  } = opts;

  // Cargar memoria del usuario
  let userMemory;
  try { userMemory = await getUserMemory(userId); } catch { userMemory = {}; }
  const memorySummary = formatMemoryForPrompt(userMemory) || '';

  // Catálogo resumido
  const catalogSummary = allProducts.map(p =>
    `ID=${p.id} | ${p.name} (${p.category}): $${p.price} | activo:${p.active ? 'si' : 'no'} | imagen:${p.image_url ? 'si' : 'no'}`
  ).join('\n');

  const deterministicDecision = buildDeterministicOperationalDecision(userMessage, allProducts, implicitProduct);
  const deterministicGuidanceDecision = buildDeterministicGuidanceDecision(userMessage, allProducts, implicitProduct);
  const deterministicFallbackDecision = deterministicDecision || deterministicGuidanceDecision || null;

  // Atajo conversacional por defecto: cualquier mensaje no operacional va por respuesta natural.
  if (!isLikelyOperationalMessage(userMessage)) {
    try {
      const text = await buildGeneralConversationText({ storeName, userMessage, recentHistory });
      if (text && !isLowValueConversationText(text)) {
        const fb = buildFallbackDecision(userMessage, null, text);
        fb.mode = 'general';
        fb.intent = 'general_chat';
        return { decision: fb, legacy: translateBrainToLegacy(fb) };
      }
    } catch {
      // Si falla, intentamos fallback humano seguro y luego continuamos con el brain completo.
    }

    const humanFallback = buildHumanFallbackReply(userMessage);
    if (humanFallback) {
      const fb = buildFallbackDecision(userMessage, null, humanFallback);
      fb.mode = 'general';
      fb.intent = 'general_chat_fallback';
      return { decision: fb, legacy: translateBrainToLegacy(fb) };
    }
  }

  const systemPrompt = buildRamiroSystemPrompt({
    storeName, personality, notes, memorySummary,
    catalogSummary, quoteSummary, persistentHistory,
    implicitProduct, autonomousMode, projectContext,
  });

  const fullPrompt = `${systemPrompt}

CONVERSACIÓN RECIENTE EN ESTA SESIÓN:
${recentHistory || '(ninguna)'}

Admin: ${userMessage}

Responde SOLO en JSON válido según el esquema indicado.`;

  let rawText;
  try {
    rawText = await callGeminiBrain(fullPrompt);
  } catch (e) {
    console.error('[RamiroBrain] Error llamando a Gemini:', e.message);
    if (!isLikelyOperationalMessage(userMessage)) {
      const generalText = await buildGeneralConversationText({ storeName, userMessage, recentHistory });
      if (generalText && !isLowValueConversationText(generalText)) {
        const fb = buildFallbackDecision(userMessage, null, generalText);
        fb.mode = 'general';
        fb.intent = 'general_chat';
        return {
          decision: fb,
          legacy: translateBrainToLegacy(fb),
        };
      }

      const humanFallback = buildHumanFallbackReply(userMessage);
      if (humanFallback) {
        const fb = buildFallbackDecision(userMessage, null, humanFallback);
        fb.mode = 'general';
        fb.intent = 'general_chat_fallback';
        return {
          decision: fb,
          legacy: translateBrainToLegacy(fb),
        };
      }
    }

    if (deterministicFallbackDecision) {
      return {
        decision: deterministicFallbackDecision,
        legacy: translateBrainToLegacy(deterministicFallbackDecision),
      };
    }

    return {
      decision: buildFallbackDecision(userMessage),
      legacy: translateBrainToLegacy(buildFallbackDecision(userMessage)),
    };
  }

  const parsed = safeJsonParse(rawText);
  if (!parsed.ok || !parsed.data || typeof parsed.data !== 'object') {
    console.warn('[RamiroBrain] JSON inválido de Gemini:', String(rawText).slice(0, 300));
    if (deterministicFallbackDecision && isLikelyOperationalMessage(userMessage)) {
      return {
        decision: deterministicFallbackDecision,
        legacy: translateBrainToLegacy(deterministicFallbackDecision),
      };
    }

    let generalText = String(rawText || '').trim();
    if (!generalText || isLowValueConversationText(generalText)) {
      generalText = await buildGeneralConversationText({ storeName, userMessage, recentHistory });
      if ((!generalText || isLowValueConversationText(generalText)) && !isLikelyOperationalMessage(userMessage)) {
        generalText = buildHumanFallbackReply(userMessage);
      }
    }
    const rawCandidate = !isLowValueConversationText(rawText) ? rawText : '';
    const fb = buildFallbackDecision(userMessage, null, generalText || rawCandidate);
    return { decision: fb, legacy: translateBrainToLegacy(fb) };
  }

  const decision = parsed.data;

  // Si el modelo devolvió una aclaración genérica en temas abiertos, pedir una respuesta conversacional real.
  const actionType = String(decision?.action?.type || '').toLowerCase();
  const isNonOperationalAsk = !actionType || actionType === 'ask' || actionType === 'none';
  if ((decision?.needsClarification || decision?.mode === 'clarification')
    && isNonOperationalAsk
    && (isLowValueConversationText(decision?.question || decision?.response) || isLikelyGeneralConversation(userMessage))) {
    let generalText = await buildGeneralConversationText({ storeName, userMessage, recentHistory });
    if (!generalText || isLowValueConversationText(generalText)) {
      generalText = buildHumanFallbackReply(userMessage);
    }
    if (generalText) {
      decision.mode = 'general';
      decision.intent = decision.intent || 'general_chat';
      decision.needsClarification = false;
      decision.requiresConfirmation = false;
      decision.action = { type: 'answer', payload: {} };
      decision.question = null;
      decision.response = generalText;
    }
  }

  if (deterministicFallbackDecision
    && isLikelyOperationalMessage(userMessage)
    && (decision?.needsClarification || decision?.mode === 'clarification')
    && isGenericClarificationText(decision?.question || decision?.response)) {
    return {
      decision: deterministicFallbackDecision,
      legacy: translateBrainToLegacy(deterministicFallbackDecision),
    };
  }

  // Guardar memoria en background si aplica
  if (decision?.memory?.shouldRemember && Array.isArray(decision?.memory?.facts) && decision.memory.facts.length) {
    rememberFacts(userId, decision.memory.facts).catch(e =>
      console.error('[RamiroBrain] Error guardando memoria:', e.message)
    );
  }

  const legacy = translateBrainToLegacy(decision);

  return { decision, legacy };
}

module.exports = { thinkRamiro, callGeminiBrain };
