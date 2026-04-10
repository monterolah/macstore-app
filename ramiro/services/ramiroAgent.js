'use strict';

const { readUrlContent, extractProductsFromUrl } = require('./ramiroUrlReader');
const {
  syncProductsFromArray,
  searchCatalogProducts,
  updateCatalogProduct,
  createCatalogProduct,
  deleteCatalogProduct,
  hideCatalogProduct,
  showProduct,
  bulkCatalogAction,
} = require('./ramiroCatalogTools');

async function runRamiroTool(decision, extra = {}) {
  const actionType = decision?.action?.type || 'none';
  const payload = decision?.action?.payload || {};

  switch (actionType) {
    case 'answer':
    case 'guide':
    case 'ask':
    case 'confirm':
    case 'none':
      return {
        type: 'message',
        ok: true,
        response: decision?.response || 'Listo.',
        decision,
      };

    case 'search': {
      const results = await searchCatalogProducts(payload.query || payload.filters || payload || {});
      return {
        type: 'search_results',
        ok: true,
        results,
        decision,
      };
    }

    case 'create': {
      const created = await createCatalogProduct(payload.product || payload || {});
      return {
        type: 'action_done',
        ok: true,
        result: created,
        decision,
      };
    }

    case 'update': {
      const updated = await updateCatalogProduct(payload.productId, payload.updates || {});
      return {
        type: 'action_done',
        ok: true,
        result: updated,
        decision,
      };
    }

    case 'delete': {
      const deleted = await deleteCatalogProduct(payload.productId);
      return {
        type: 'action_done',
        ok: true,
        result: deleted,
        decision,
      };
    }

    case 'hide': {
      const hidden = await hideCatalogProduct(payload.productId);
      return {
        type: 'action_done',
        ok: true,
        result: hidden,
        decision,
      };
    }

    case 'show': {
      const shown = await showProduct(payload.productId);
      return {
        type: 'action_done',
        ok: true,
        result: shown,
        decision,
      };
    }

    case 'extract': {
      const data = await readUrlContent(payload.url);
      return {
        type: 'url_read',
        ok: true,
        data,
        decision,
      };
    }

    case 'import': {
      const extracted = await extractProductsFromUrl(payload.url);
      if (payload.previewOnly !== false) {
        return {
          type: 'import_preview',
          ok: true,
          found: extracted.length,
          products: extracted.slice(0, 30),
          decision,
        };
      }

      const synced = await syncProductsFromArray(extracted, payload.url || payload.source || '');
      return {
        type: 'import_done',
        ok: true,
        result: { ...synced, importedBy: extra.userId || 'ramiro' },
        decision,
      };
    }

    case 'bulk': {
      const result = await bulkCatalogAction({
        ids: Array.isArray(payload.ids) ? payload.ids : [],
        operation: payload.operation || payload.action,
      });
      return {
        type: 'action_done',
        ok: true,
        result,
        decision,
      };
    }

    default:
      return {
        type: 'message',
        ok: true,
        response: decision?.response || 'Entendí la intención, pero todavía no hay herramienta conectada para esa acción.',
        decision,
      };
  }
}

module.exports = { runRamiroTool };
