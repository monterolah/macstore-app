'use strict';

const https = require('https');
const http = require('http');
const { load: cheerioLoad } = require('cheerio');

const BLOCKED_HOSTS = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  '10.0.0.1', '192.168.0.1', '169.254.169.254',
]);

function isBlockedHost(hostname = '') {
  const h = String(hostname).toLowerCase();
  if (BLOCKED_HOSTS.has(h)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)) return true;
  return false;
}

/**
 * Descarga el HTML de una URL y lo devuelve como string limpio.
 */
async function fetchHtml(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('URL inválida'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Protocolo no permitido');
  if (isBlockedHost(parsed.hostname)) throw new Error('Host no permitido');

  const lib = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 RamiroBot/2.0' },
      timeout: 14000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (loc) return resolve(fetchHtml(loc)); // seguir redirect una vez
        return reject(new Error('Redirect sin destino'));
      }
      if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > 2_000_000) req.destroy(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout al leer URL')); });
  });
}

/**
 * Lee una URL y devuelve su contenido en texto limpio + metadatos.
 */
async function readUrlContent(url) {
  const html = await fetchHtml(url);
  const $ = cheerioLoad(html);

  // Remover elementos no informativos
  $('script, style, noscript, svg, head > *:not(title):not(meta)').remove();

  const title = $('title').first().text().trim();
  const metaDesc = $('meta[name="description"]').attr('content')
    || $('meta[property="og:description"]').attr('content')
    || '';

  const headings = [];
  $('h1, h2, h3').each((_, el) => {
    const t = $(el).text().trim();
    if (t) headings.push(t);
  });

  const paragraphs = [];
  $('p').each((_, el) => {
    const t = $(el).text().trim();
    if (t.length >= 30) paragraphs.push(t);
  });

  const images = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || '';
    const alt = $(el).attr('alt') || '';
    if (src && !src.startsWith('data:')) images.push({ src, alt });
  });

  const rawText = [title, metaDesc, ...headings, ...paragraphs]
    .join('\n')
    .replace(/\s{3,}/g, '\n')
    .slice(0, 14000);

  return {
    url,
    title,
    metaDescription: metaDesc,
    headings: headings.slice(0, 25),
    paragraphs: paragraphs.slice(0, 25),
    images: images.slice(0, 30),
    rawText,
  };
}

/**
 * Extrae productos de una URL usando heurísticas + selectores comunes.
 * Retorna array de {name, price, image, link}.
 */
async function extractProductsFromUrl(url) {
  const html = await fetchHtml(url);
  const $ = cheerioLoad(html);
  const products = [];

  const PRODUCT_SELECTORS = [
    '.product', '.product-card', '.card', '[data-product]',
    '[itemtype*="Product"]', 'article.item', 'li.product',
    '.item-product', '.catalog-item',
  ];

  $(PRODUCT_SELECTORS.join(', ')).each((_, el) => {
    const root = $(el);

    const name = root.find([
      'h1', 'h2', 'h3', 'h4',
      '.title', '.product-title', '.name', '.product-name',
      '[itemprop="name"]',
    ].join(', ')).first().text().trim();

    const priceRaw = root.find([
      '.price', '.product-price', '[class*="price"]',
      '[itemprop="price"]', '.cost', '.valor',
    ].join(', ')).first().text().trim();

    const image = root.find('img').first().attr('src')
      || root.find('img').first().attr('data-src')
      || root.find('img').first().attr('data-lazy-src')
      || null;

    const href = root.find('a').first().attr('href') || null;
    const link = href ? new URL(href, url).href : null;

    if (name && name.length >= 2 && (priceRaw || image)) {
      const priceNum = parseFloat(String(priceRaw).replace(/[^0-9.]/g, '')) || null;
      products.push({ name, price: priceNum, priceRaw, image, link });
    }
  });

  // Deduplicar por nombre+precio
  const seen = new Set();
  const unique = [];
  for (const p of products) {
    const key = `${p.name}::${p.priceRaw}`;
    if (!seen.has(key)) { seen.add(key); unique.push(p); }
  }

  return unique.slice(0, 200);
}

module.exports = { readUrlContent, extractProductsFromUrl };
