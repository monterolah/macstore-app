'use strict';

const { getFirestore } = require('../../db/firebase');

const COLLECTION = 'ramiro_memory';
const MAX_FACTS = 120;

/**
 * Lee la memoria de un usuario específico.
 * @param {string} userId - email del admin
 */
async function getUserMemory(userId) {
  try {
    const db = getFirestore();
    const ref = db.collection(COLLECTION).doc(String(userId).toLowerCase());
    const snap = await ref.get();
    if (!snap.exists) return { preferences: {}, aliases: {}, notes: [] };
    return snap.data();
  } catch {
    return { preferences: {}, aliases: {}, notes: [] };
  }
}

/**
 * Guarda hechos aprendidos en la memoria del usuario.
 * @param {string} userId
 * @param {Array<{key:string, value:string, reason?:string}>} facts
 */
async function rememberFacts(userId, facts = []) {
  if (!facts?.length) return;
  try {
    const db = getFirestore();
    const ref = db.collection(COLLECTION).doc(String(userId).toLowerCase());
    const snap = await ref.get();
    const current = snap.exists ? snap.data() : { preferences: {}, aliases: {}, notes: [] };
    const preferences = { ...(current.preferences || {}) };

    for (const fact of facts) {
      if (!fact?.key) continue;
      preferences[fact.key] = {
        value: fact.value,
        reason: fact.reason || '',
        updatedAt: new Date().toISOString(),
      };
      // Limitar a MAX_FACTS claves
      const keys = Object.keys(preferences);
      if (keys.length > MAX_FACTS) {
        // Eliminar la más antigua
        const oldest = keys.sort((a, b) =>
          new Date(preferences[a].updatedAt || 0) - new Date(preferences[b].updatedAt || 0)
        )[0];
        delete preferences[oldest];
      }
    }

    await ref.set({ ...current, preferences, updatedAt: new Date().toISOString() }, { merge: true });
  } catch (e) {
    console.error('[RamiroMemory] Error guardando hechos:', e.message);
  }
}

/**
 * Devuelve un resumen de texto de la memoria para inyectar en el prompt.
 */
function formatMemoryForPrompt(memory = {}) {
  const prefs = memory.preferences || {};
  const keys = Object.keys(prefs);
  if (!keys.length) return null;
  return keys
    .map(k => `• [${k}] ${prefs[k].value}${prefs[k].reason ? ` (${prefs[k].reason})` : ''}`)
    .join('\n');
}

/**
 * Guarda un patrón aprendido directamente como facto.
 * trigger = mensaje original, meaning = lo que quiso decir.
 */
async function learnPattern(userId, trigger, meaning) {
  if (!trigger || !meaning) return;
  const key = `pattern_${trigger.trim().toLowerCase().slice(0, 40).replace(/\s+/g, '_')}`;
  await rememberFacts(userId, [{
    key,
    value: meaning,
    reason: `Aprendido del contexto: "${trigger.slice(0, 60)}"`,
  }]);
}

module.exports = {
  getUserMemory,
  rememberFacts,
  formatMemoryForPrompt,
  learnPattern,
};
