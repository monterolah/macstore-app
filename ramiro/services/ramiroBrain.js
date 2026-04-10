'use strict';

const https = require('https');
const { safeJsonParse, translateBrainToLegacy } = require('../utils/ramiroHelpers');
const { getUserMemory, rememberFacts, formatMemoryForPrompt } = require('./ramiroMemory');
const { buildRamiroSystemPrompt } = require('../config/ramiroSystemPrompt');

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
    process.env.CLAVE_API_GÉMINIS,
    process.env['CLAVE_API_GÉMINIS'],
  ]
    .map(v => String(v || '').trim())
    .filter(Boolean);
  return [...new Set(candidates)];
}

/**
 * Llama a Gemini y devuelve el texto bruto de la respuesta.
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
 * Función principal: TODO pasa por Gemini.
 * Devuelve { decision, legacy, source }
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

  // Memoria del usuario
  let userMemory;
  try { userMemory = await getUserMemory(userId); } catch { userMemory = {}; }
  const memorySummary = formatMemoryForPrompt(userMemory) || '';

  // Catálogo resumido
  const catalogSummary = allProducts.map(p =>
    `ID=${p.id} | ${p.name} (${p.category}): $${p.price} | activo:${p.active ? 'si' : 'no'} | imagen:${p.image_url ? 'si' : 'no'}`
  ).join('\n');

  // Construir prompt completo
  const systemPrompt = buildRamiroSystemPrompt({
    storeName, personality, notes, memorySummary,
    catalogSummary, quoteSummary, persistentHistory,
    implicitProduct, autonomousMode, projectContext,
  });

  const fullPrompt = `${systemPrompt}

CONVERSACIÓN RECIENTE EN ESTA SESIÓN:
${recentHistory || '(ninguna)'}

Admin: ${userMessage}

Responde SOLO en JSON válido según el esquema indicado. Sin markdown, sin texto extra.`;

  // Llamar a Gemini — TODO pasa por aquí
  let rawText;
  try {
    rawText = await callGeminiBrain(fullPrompt);
  } catch (e) {
    console.error('[RamiroBrain] Error llamando a Gemini:', e.message);
    // Si Gemini falla, devolver error claro sin inventar respuesta
    const fallback = {
      mode: 'general',
      intent: 'gemini_error',
      confidence: 0,
      requiresConfirmation: false,
      needsClarification: false,
      understood: 'Error de conexión con Gemini',
      entity: { type: 'unknown', id: null, name: null, filters: {}, matches: [] },
      action: { type: 'answer', payload: {} },
      question: null,
      response: 'No pude conectarme con la IA en este momento. Intenta de nuevo en unos segundos.',
      memory: { shouldRemember: false, facts: [] },
      source: 'ramiro',
    };
    return { decision: fallback, legacy: translateBrainToLegacy(fallback) };
  }

  // Parsear JSON de Gemini
  const parsed = safeJsonParse(rawText);

  let decision;
  if (parsed.ok && parsed.data && typeof parsed.data === 'object') {
    // Gemini devolvió JSON válido
    decision = parsed.data;
    decision.source = 'gemini';
  } else {
    // Gemini respondió en texto libre (conversación general) — usar el texto tal cual
    const responseText = String(rawText || '').trim();
    decision = {
      mode: 'general',
      intent: 'general_chat',
      confidence: 0.9,
      requiresConfirmation: false,
      needsClarification: false,
      understood: 'Respuesta conversacional de Gemini',
      entity: { type: 'general', id: null, name: null, filters: {}, matches: [] },
      action: { type: 'answer', payload: {} },
      question: null,
      response: responseText || 'No obtuve una respuesta clara. ¿Puedes repetirlo?',
      memory: { shouldRemember: false, facts: [] },
      source: 'gemini',
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
