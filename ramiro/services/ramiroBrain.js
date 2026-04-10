'use strict';

const https = require('https');
const { buildRamiroSystemPrompt } = require('../config/ramiroSystemPrompt');
const { safeJsonParse, translateBrainToLegacy } = require('../utils/ramiroHelpers');
const { getUserMemory, rememberFacts, formatMemoryForPrompt } = require('./ramiroMemory');

const GEMINI_API_KEY = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY || '';
const CANDIDATE_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-pro',
];

/**
 * Llama a la API de Gemini con el prompt dado y devuelve el texto bruto.
 */
async function callGeminiBrain(prompt) {
  if (!GEMINI_API_KEY) throw new Error('Falta GOOGLE_AI_API_KEY en variables de entorno');

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.25, maxOutputTokens: 4096 },
  });

  let lastError = null;
  for (const model of CANDIDATE_MODELS) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
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
function buildFallbackDecision(userMessage, question = null) {
  return {
    mode: 'clarification',
    intent: 'fallback_no_parse',
    confidence: 0,
    requiresConfirmation: false,
    needsClarification: true,
    understood: 'No pude interpretar la intención con seguridad.',
    entity: { type: 'unknown', id: null, name: null, filters: {}, matches: [] },
    action: { type: 'ask', payload: {} },
    question: question || '¿En qué te puedo ayudar?',
    response: question || '¿En qué te puedo ayudar?',
    memory: { shouldRemember: false, facts: [] },
  };
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
    implicitProduct, autonomousMode,
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
    return {
      decision: buildFallbackDecision(userMessage),
      legacy: translateBrainToLegacy(buildFallbackDecision(userMessage)),
    };
  }

  const parsed = safeJsonParse(rawText);
  if (!parsed.ok || !parsed.data || typeof parsed.data !== 'object') {
    console.warn('[RamiroBrain] JSON inválido de Gemini:', String(rawText).slice(0, 300));
    const fb = buildFallbackDecision(userMessage);
    return { decision: fb, legacy: translateBrainToLegacy(fb) };
  }

  const decision = parsed.data;

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
