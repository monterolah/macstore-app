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

function getGeminiApiKey() {
  return process.env.GOOGLE_AI_API_KEY
    || process.env.GEMINI_API_KEY
    || process.env.CLAVE_API_IA_GOOGLE
    || process.env.CLAVE_API_GEMINIS
    || process.env['CLAVE_API_GÉMINIS']
    || '';
}

/**
 * Llama a la API de Gemini con el prompt dado y devuelve el texto bruto.
 */
async function callGeminiBrain(prompt) {
  const geminiApiKey = getGeminiApiKey();
  if (!geminiApiKey) {
    throw new Error('Faltan GOOGLE_AI_API_KEY y GEMINI_API_KEY en variables de entorno');
  }

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.25, maxOutputTokens: 4096 },
  });

  let lastError = null;
  for (const model of CANDIDATE_MODELS) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
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
  throw lastError || new Error('No fue posible obtener respuesta de Gemini');
}

/**
 * Fallback seguro cuando Gemini no retorna JSON válido o la confianza es muy baja.
 */
function buildFallbackDecision(userMessage, question = null, rawResponse = null) {
  const cleanRaw = String(rawResponse || '').trim();
  const hasUsefulRaw = cleanRaw.length >= 12;
  const fallbackText = hasUsefulRaw
    ? cleanRaw.slice(0, 2200)
    : (question || 'No pude procesar bien ese mensaje. ¿Qué quieres hacer exactamente? Ejemplos: "editar precio", "cambiar imagen", "crear producto", "activar producto".');

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
    || t.includes('no pude procesar bien ese mensaje');
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

function isLikelyOperationalMessage(text = '') {
  const n = normalizeForIntent(text);
  if (!n) return false;
  return [
    'precio', 'producto', 'catalogo', 'categoria', 'imagen', 'color', 'stock', 'variante',
    'crear', 'agregar', 'anadir', 'editar', 'actualizar', 'eliminar', 'borrar',
    'activar', 'desactivar', 'ocultar', 'mostrar', 'importar', 'url', 'link', 'cotizacion'
  ].some(k => n.includes(k));
}

function buildOfflineGeneralConversationText(userMessage = '') {
  const n = normalizeForIntent(userMessage);
  if (!n) return '';

  if (n.includes('guerra fria') || n.includes('guerra fria')) {
    return 'Claro. La Guerra Fria fue una rivalidad geopolitica (1947-1991) entre Estados Unidos y la URSS. No fue una guerra directa entre ambas potencias, sino un conflicto de influencia global con carrera armamentista nuclear, espionaje, propaganda y guerras indirectas (Corea, Vietnam, Afganistan). En Europa simbolizo la division entre bloques (OTAN y Pacto de Varsovia), con episodios criticos como Berlin y la Crisis de los Misiles en Cuba (1962). Termino con la crisis del bloque sovietico y la disolucion de la URSS en 1991.';
  }

  if (n.includes('que es la ia') || n.includes('inteligencia artificial')) {
    return 'La inteligencia artificial es el campo que desarrolla sistemas capaces de realizar tareas cognitivas, como comprender lenguaje, reconocer patrones, predecir resultados y apoyar decisiones, usando modelos entrenados con datos.';
  }

  return '';
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

async function buildGeneralConversationText({ storeName = 'MacStore', userMessage = '' }) {
  const msg = String(userMessage || '').trim();
  if (!msg) return '';

  const prompt = `Eres Ramiro, asistente conversacional de ${storeName}.
Responde en español, de forma natural, útil y directa a este mensaje del usuario.
No uses JSON, no menciones reglas internas, no pidas formato especial.

Usuario: ${msg}`;

  try {
    const text = await callGeminiBrain(prompt);
    return String(text || '').trim();
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
      const offlineDecision = buildOfflineGeneralDecision(userMessage);
      if (offlineDecision) {
        return {
          decision: offlineDecision,
          legacy: translateBrainToLegacy(offlineDecision),
        };
      }
    }
    return {
      decision: buildFallbackDecision(userMessage),
      legacy: translateBrainToLegacy(buildFallbackDecision(userMessage)),
    };
  }

  const parsed = safeJsonParse(rawText);
  if (!parsed.ok || !parsed.data || typeof parsed.data !== 'object') {
    console.warn('[RamiroBrain] JSON inválido de Gemini:', String(rawText).slice(0, 300));
    let generalText = String(rawText || '').trim();
    if (!generalText || isGenericClarificationText(generalText)) {
      generalText = await buildGeneralConversationText({ storeName, userMessage });
      if (!generalText && !isLikelyOperationalMessage(userMessage)) {
        generalText = buildOfflineGeneralConversationText(userMessage);
      }
    }
    const fb = buildFallbackDecision(userMessage, null, generalText || rawText);
    return { decision: fb, legacy: translateBrainToLegacy(fb) };
  }

  const decision = parsed.data;

  // Si el modelo devolvió una aclaración genérica en temas abiertos, pedir una respuesta conversacional real.
  const actionType = String(decision?.action?.type || '').toLowerCase();
  const isNonOperationalAsk = !actionType || actionType === 'ask' || actionType === 'none';
  if (decision?.needsClarification && isNonOperationalAsk && isGenericClarificationText(decision?.question || decision?.response)) {
    const generalText = await buildGeneralConversationText({ storeName, userMessage });
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
