'use strict';

function safeJsonParse(text) {
  try {
    // Limpiar markdown fencing si Gemini lo agrega
    const clean = String(text || '')
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    return { ok: true, data: JSON.parse(clean) };
  } catch (error) {
    return { ok: false, error };
  }
}

function normalizeText(text = '') {
  return String(text)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function looksLikeUrl(text = '') {
  return /(https?:\/\/[^\s]+)/i.test(String(text));
}

function extractFirstUrl(text = '') {
  const match = String(text).match(/(https?:\/\/[^\s]+)/i);
  return match ? match[1].replace(/[),.;]+$/, '') : null;
}

function isDestructiveActionType(actionType = '') {
  return ['delete', 'hide', 'import'].includes(String(actionType).toLowerCase());
}

/**
 * Traduce el action.type del nuevo schema a los action codes del sistema existente.
 */
function translateActionType(brainAction, brainMode) {
  if (!brainAction?.type || brainAction.type === 'none' || brainAction.type === 'answer' || brainAction.type === 'guide') return null;
  if (brainAction.type === 'ask') return null;
  if (brainAction.type === 'create') return 'PRODUCT_CREATE';
  if (brainAction.type === 'update') return 'PRODUCT_UPDATE';
  if (brainAction.type === 'delete') return 'PRODUCT_DELETE';
  if (brainAction.type === 'hide') return 'PRODUCT_UPDATE'; // active: false
  if (brainAction.type === 'show') return 'PRODUCT_UPDATE'; // active: true
  if (brainAction.type === 'import' || brainAction.type === 'extract') return 'SYNC_FROM_URL';
  if (brainAction.type === 'search') return null; // respuesta informativa
  return null;
}

/**
 * Construye el data dict compatible con el formato existente a partir de la decisión del brain.
 */
function translateBrainToLegacy(decision) {
  const actionType = translateActionType(decision?.action, decision?.mode);
  const payload = decision?.action?.payload || {};

  let data = null;
  if (actionType === 'PRODUCT_CREATE') {
    data = { product: payload.product || payload };
  } else if (actionType === 'PRODUCT_UPDATE') {
    const updates = payload.updates || {};
    // hide/show
    if (decision.action.type === 'hide') updates.active = false;
    if (decision.action.type === 'show') updates.active = true;
    data = { productId: payload.productId || decision.entity?.id, updates };
  } else if (actionType === 'PRODUCT_DELETE') {
    data = { productId: payload.productId || decision.entity?.id };
  } else if (actionType === 'SYNC_FROM_URL') {
    data = { url: payload.url || extractFirstUrl(JSON.stringify(payload)) };
  }

  return {
    message: decision?.response || decision?.question || '¿En qué te puedo ayudar?',
    action: actionType,
    data,
    needsClarification: !!(decision?.needsClarification || decision?.question),
    requiresConfirmation: !!(decision?.requiresConfirmation),
    understood: decision?.understood || '',
    intent: decision?.intent || '',
    mode: decision?.mode || 'general',
    confidence: decision?.confidence ?? 0,
    question: decision?.question || null,
    memoryFacts: decision?.memory?.facts || [],
    shouldRemember: !!(decision?.memory?.shouldRemember),
    entityMatches: decision?.entity?.matches || [],
  };
}

module.exports = {
  safeJsonParse,
  normalizeText,
  looksLikeUrl,
  extractFirstUrl,
  isDestructiveActionType,
  translateActionType,
  translateBrainToLegacy,
};
