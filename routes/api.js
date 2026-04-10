const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { getFirestore } = require('../db/firebase');
const { uploadToStorage } = require('../utils/storageUpload');
const { requireAdminAPI } = require('../middleware/auth');
const { importCatalogFromWorkbook, importInventoryWorkbook } = require('../utils/catalogImport');
const { thinkRamiro } = require('../ramiro/services/ramiroBrain');
const { readUrlContent, extractProductsFromUrl } = require('../ramiro/services/ramiroUrlReader');
const { syncProductsFromArray } = require('../ramiro/services/ramiroCatalogTools');
const { learnPattern } = require('../ramiro/services/ramiroMemory');

const PDFDocument = require('pdfkit');

const router = express.Router();

// ── MULTER CONFIG — memoria para subir a Firebase Storage ─────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!file || !file.originalname) return cb(new Error('Archivo inválido'));
    return file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Solo imágenes'));
  }
});

const excelStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../temp_uploads');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.xlsx';
    cb(null, `catalog-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const excelUpload = multer({
  storage: excelStorage,
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /sheet|excel|spreadsheetml|csv/i.test(file.mimetype) || /\.(xlsx|xls|csv)$/i.test(file.originalname || '');
    ok ? cb(null, true) : cb(new Error('Solo archivos Excel o CSV'));
  }
});

function slugify(str) {
  return String(str).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
}

function docToObj(doc) {
  return { id: doc.id, ...doc.data() };
}


function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function parseJsonField(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('JSON inválido en uno de los campos enviados');
  }
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return value === '1' || value === 'true' || value === 'on';
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanText(value, max = 5000) {
  return String(value || '').trim().slice(0, max);
}


// ══════════════════════════════════════════════════════════════════════════
// PDF NATIVO CON PDFKIT — SIN PUPPETEER
// ══════════════════════════════════════════════════════════════════════════

const C = {
  black:    '#1d1d1f',
  white:    '#ffffff',
  grey:     '#515154',
  lightG:   '#86868b',
  bg:       '#f5f5f7',
  border:   '#e8e8ed',
  blue:     '#0071e3',
  blueBg:   '#e8f0fe',
  green:    '#1a7f37',
  greenBg:  '#e8f4e8',
};

function parseBase64Image(b64) {
  if (!b64) return null;
  try {
    const match = b64.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return null;
    return Buffer.from(match[2], 'base64');
  } catch { return null; }
}

function buildPdfBuffer(q) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 40, bottom: 40, left: 44, right: 44 }
      });

      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width - 88;
      const LM = 44;
      let y = 40;

      const drawLine = (x1, yL, x2, color, width) => {
        doc.strokeColor(color || C.black).lineWidth(width || 1).moveTo(x1, yL).lineTo(x2, yL).stroke();
      };

      const drawRect = (x, yR, w, h, fill) => {
        doc.rect(x, yR, w, h).fill(fill);
      };

      const checkPage = (needed) => {
        if (y + needed > doc.page.height - 50) {
          doc.addPage();
          y = 40;
        }
      };

      // ── DATOS ──
      const items    = Array.isArray(q.items) ? q.items : [];
      const ivaMode  = q.ivaMode || 'con';
      const options  = q.options || {};
      const settings = q.settings || {};
      const payMethods = Array.isArray(q.paymentMethods) ? q.paymentMethods : [];

      const storeName    = settings.store_name || 'MacStore';
      const storeTagline = settings.store_tagline || 'Distribuidor Autorizado Apple';

      const createdAt = new Date();
      const dateStr   = createdAt.toLocaleDateString('es-SV', { year: 'numeric', month: 'long', day: 'numeric' });
      const validText = q.validity === '0' ? 'Sin vencimiento' : `Válida por ${q.validity || 7} días`;

      // ── HEADER ──
      doc.font('Helvetica-Bold').fontSize(26).fillColor(C.black).text(storeName, LM, y);
      y += 30;
      doc.font('Helvetica').fontSize(10).fillColor(C.lightG).text(storeTagline, LM, y);
      y += 18;
      drawLine(LM, y, LM + W, C.black, 2.5);
      y += 16;

      // ── META: CLIENTE + INFO ──
      const metaW = (W - 14) / 2;

      // Caja cliente
      doc.save();
      doc.roundedRect(LM, y, metaW, 64, 6).fill(C.bg);
      doc.restore();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(C.lightG).text('COTIZACIÓN PARA', LM + 14, y + 10);
      doc.font('Helvetica-Bold').fontSize(14).fillColor(C.black).text(q.client || '—', LM + 14, y + 24, { width: metaW - 28 });
      if (q.company) {
        doc.font('Helvetica').fontSize(10).fillColor(C.grey).text(q.company, LM + 14, y + 42, { width: metaW - 28 });
      }

      // Caja info
      const infoX = LM + metaW + 14;
      doc.save();
      doc.roundedRect(infoX, y, metaW, 64, 6).fill(C.bg);
      doc.restore();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(C.lightG).text('INFORMACIÓN', infoX + 14, y + 10);
      doc.font('Helvetica-Bold').fontSize(14).fillColor(C.black).text(q.qNum || '', infoX + 14, y + 24, { width: metaW - 28 });
      doc.font('Helvetica').fontSize(9).fillColor(C.grey).text(`Emitida: ${dateStr}`, infoX + 14, y + 42);
      doc.font('Helvetica').fontSize(9).fillColor(C.grey).text(validText, infoX + 14, y + 53);

      y += 72;

      // Vendedor badge
      if (q.seller) {
        checkPage(20);
        const badgeLabel = `Vendedor: ${q.seller}`;
        doc.font('Helvetica-Bold').fontSize(9);
        const bw = doc.widthOfString(badgeLabel) + 20;
        doc.save();
        doc.roundedRect(infoX + 14, y, bw, 18, 9).fill(C.blueBg);
        doc.restore();
        doc.font('Helvetica-Bold').fontSize(9).fillColor(C.blue).text(badgeLabel, infoX + 24, y + 4);
        y += 26;
      }

      y += 6;

      // ── TABLA DE PRODUCTOS ──
      checkPage(40);

      const colX  = [LM, LM + W * 0.55, LM + W * 0.7, LM + W * 0.85];
      const colW  = [W * 0.55, W * 0.15, W * 0.15, W * 0.15];
      const ivaHeader = ivaMode === 'con' ? 'Precio c/IVA' : 'Precio s/IVA';

      drawRect(LM, y, W, 26, C.black);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.white);
      doc.text('PRODUCTO Y ESPECIFICACIONES', colX[0] + 12, y + 8);
      doc.text('CANT.', colX[1], y + 8, { width: colW[1], align: 'center' });
      doc.text(ivaHeader.toUpperCase(), colX[2], y + 8, { width: colW[2], align: 'right' });
      doc.text('TOTAL', colX[3], y + 8, { width: colW[3], align: 'right' });
      y += 26;

      // Filas de productos
      items.forEach((item, idx) => {
        const price = parseFloat(item.price) || 0;
        const qty   = parseInt(item.qty) || 1;
        const disc  = parseFloat(item.discount) || 0;
        const gross = price * qty;
        const discAmt = gross * (disc / 100);
        const net   = gross - discAmt;

        let unitShow, lineTotal;
        if (ivaMode === 'exento' || ivaMode === 'desglosado') {
          unitShow  = price / 1.13;
          lineTotal = net / 1.13;
        } else {
          unitShow  = price;
          lineTotal = net;
        }

        const hasSpecs = options.showSpecs && item.specs && typeof item.specs === 'object' && Object.keys(item.specs).length > 0;
        const hasFicha = options.showFichaGlobal && item.ficha && typeof item.ficha === 'object' && Object.keys(item.ficha).length > 0;
        const specEntries = hasSpecs ? Object.entries(item.specs).filter(([k, v]) => v !== null && v !== undefined && String(v).trim() !== '') : [];
        const fichaEntries = hasFicha ? Object.entries(item.ficha).filter(([k, v]) => v !== null && v !== undefined && String(v).trim() !== '') : [];
        const colors = Array.isArray(item.selectedColors) ? item.selectedColors.filter(Boolean) : [];

        let rowH = 28;
        if (specEntries.length)  rowH += specEntries.length * 14 + 8;
        if (fichaEntries.length) rowH += fichaEntries.length * 22 + 14;
        if (disc > 0)   rowH += 14;
        if (colors.length) rowH += 16;
        rowH = Math.max(rowH, 50);

        const imgBuf = parseBase64Image(item.image_base64);
        if (imgBuf) rowH = Math.max(rowH, 70);

        checkPage(rowH + 4);

        if (idx > 0) {
          drawLine(LM, y, LM + W, '#f0f0f2', 0.5);
        }
        y += 4;

        const rowStartY = y;
        let contentX = colX[0] + 12;

        // Imagen del producto
        if (imgBuf) {
          try {
            doc.image(imgBuf, contentX, y, { width: 50, height: 50, fit: [50, 50] });
          } catch (e) { /* imagen inválida */ }
          contentX += 60;
        }

        // Nombre + variante
        const nameText = item.variant ? `${item.name || ''} — ${item.variant}` : (item.name || '');
        doc.font('Helvetica-Bold').fontSize(11).fillColor(C.black);
        const nameW = colW[0] - (contentX - colX[0]) - 8;
        doc.text(nameText, contentX, y, { width: nameW });
        y += doc.heightOfString(nameText, { width: nameW }) + 4;

        // Colores
        if (colors.length) {
          doc.font('Helvetica').fontSize(8).fillColor(C.grey);
          doc.text(`Colores: ${colors.join(', ')}`, contentX, y, { width: nameW });
          y += 12;
        }

        // Specs (tabla corta)
        if (specEntries.length) {
          const specW = nameW;
          specEntries.forEach(([k, v], si) => {
            if (si % 2 === 0) drawRect(contentX, y - 1, specW, 13, '#f9f9f9');
            doc.font('Helvetica-Bold').fontSize(8).fillColor(C.grey).text(k, contentX + 4, y + 1, { width: specW * 0.38 });
            doc.font('Helvetica').fontSize(8).fillColor(C.black).text(String(v), contentX + specW * 0.4, y + 1, { width: specW * 0.58 });
            y += 14;
          });
          y += 4;
        }

        // Ficha técnica completa
        if (fichaEntries.length) {
          const fichaW = nameW;
          doc.font('Helvetica-Bold').fontSize(7).fillColor(C.lightG).text('FICHA TÉCNICA', contentX, y);
          y += 10;
          fichaEntries.forEach(([k, v], fi) => {
            const valStr = String(v);
            const valH = doc.font('Helvetica').fontSize(8).heightOfString(valStr, { width: fichaW * 0.57 });
            const rH = Math.max(valH, 10) + 8;
            if (fi % 2 === 0) drawRect(contentX, y - 2, fichaW, rH + 2, '#f9f9f9');
            doc.font('Helvetica-Bold').fontSize(8).fillColor(C.grey).text(String(k), contentX + 4, y + 3, { width: fichaW * 0.37 });
            doc.font('Helvetica').fontSize(8).fillColor(C.black).text(valStr, contentX + fichaW * 0.4, y + 3, { width: fichaW * 0.57 });
            y += rH + 2;
          });
          y += 6;
        }

        // Descuento
        if (disc > 0) {
          doc.font('Helvetica').fontSize(8).fillColor(C.green);
          doc.text(`Descuento ${disc}% aplicado (−$${discAmt.toFixed(2)})`, contentX, y);
          y += 14;
        }

        // Columnas numéricas
        const numY = rowStartY + Math.max((y - rowStartY) / 2 - 6, 4);
        doc.font('Helvetica').fontSize(11).fillColor(C.black);
        doc.text(String(qty), colX[1], numY, { width: colW[1], align: 'center' });
        doc.text(`$${unitShow.toFixed(2)}`, colX[2], numY, { width: colW[2], align: 'right' });
        doc.font('Helvetica-Bold').fontSize(11).fillColor(C.black);
        doc.text(`$${lineTotal.toFixed(2)}`, colX[3], numY, { width: colW[3], align: 'right' });

        if (imgBuf) y = Math.max(y, rowStartY + 54);
        y += 6;
      });

      // ── TOTALES ──
      y += 8;
      checkPage(80);

      let sub = 0, iva = 0;
      items.forEach(item => {
        const price = parseFloat(item.price) || 0;
        const qty   = parseInt(item.qty) || 1;
        const disc  = parseFloat(item.discount) || 0;
        const gross = price * qty;
        const discAmt = gross * (disc / 100);
        const net   = gross - discAmt;

        if (ivaMode === 'exento') {
          sub += net / 1.13;
        } else if (ivaMode === 'desglosado') {
          const s = net / 1.13;
          sub += s;
          iva += net - s;
        } else {
          sub += net;
        }
      });
      const total = sub + iva;

      const totX = LM + W - 220;
      const totW = 220;

      if (ivaMode !== 'con') {
        doc.font('Helvetica').fontSize(11).fillColor(C.grey);
        doc.text('Subtotal sin IVA', totX, y, { width: totW * 0.55 });
        doc.text(`$${sub.toFixed(2)}`, totX + totW * 0.55, y, { width: totW * 0.45, align: 'right' });
        y += 18;
      }

      if (ivaMode === 'desglosado') {
        doc.font('Helvetica').fontSize(11).fillColor(C.grey);
        doc.text('IVA (13%)', totX, y, { width: totW * 0.55 });
        doc.text(`$${iva.toFixed(2)}`, totX + totW * 0.55, y, { width: totW * 0.45, align: 'right' });
        y += 18;
      }

      if (ivaMode === 'exento') {
        doc.font('Helvetica').fontSize(11).fillColor(C.grey);
        doc.text('IVA', totX, y, { width: totW * 0.4 });
        const exText = 'EXENTO';
        doc.font('Helvetica-Bold').fontSize(8);
        const exW = doc.widthOfString(exText) + 14;
        doc.save();
        doc.roundedRect(totX + totW - exW, y - 2, exW, 16, 5).fill(C.greenBg);
        doc.restore();
        doc.font('Helvetica-Bold').fontSize(8).fillColor(C.green).text(exText, totX + totW - exW + 7, y + 1);
        y += 18;
      }

      drawLine(totX, y, totX + totW, C.black, 1.5);
      y += 8;
      doc.font('Helvetica-Bold').fontSize(18).fillColor(C.black);
      doc.text('Total', totX, y, { width: totW * 0.45 });
      doc.text(`$${total.toFixed(2)}`, totX + totW * 0.45, y, { width: totW * 0.55, align: 'right' });
      y += 28;

      // ── CUOTAS ──
      if (options.showCuotasPDF) {
        checkPage(80);
        const div1 = parseInt(q.div1) || 6;
        const div2 = parseInt(q.div2) || 10;
        const lbl1 = q.lbl1 || '6 cuotas sin intereses';
        const lbl2 = q.lbl2 || '10 cuotas sin intereses';

        doc.font('Helvetica-Bold').fontSize(9).fillColor(C.grey).text('OPCIONES DE FINANCIAMIENTO', LM, y);
        y += 16;

        const cuotaW = (W - 14) / 2;
        const cuotaH = 56;

        doc.save();
        doc.roundedRect(LM, y, cuotaW, cuotaH, 8).lineWidth(1.5).strokeColor(C.border).stroke();
        doc.restore();
        doc.font('Helvetica').fontSize(9).fillColor(C.lightG).text(lbl1, LM, y + 10, { width: cuotaW, align: 'center', lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(20).fillColor(C.black).text(`$${(total / div1).toFixed(2)}`, LM, y + 24, { width: cuotaW, align: 'center', lineBreak: false });
        doc.font('Helvetica').fontSize(8).fillColor(C.lightG).text('por mes', LM, y + 46, { width: cuotaW, align: 'center', lineBreak: false });

        const c2x = LM + cuotaW + 14;
        doc.save();
        doc.roundedRect(c2x, y, cuotaW, cuotaH, 8).lineWidth(1.5).strokeColor(C.border).stroke();
        doc.restore();
        doc.font('Helvetica').fontSize(9).fillColor(C.lightG).text(lbl2, c2x, y + 10, { width: cuotaW, align: 'center', lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(20).fillColor(C.black).text(`$${(total / div2).toFixed(2)}`, c2x, y + 24, { width: cuotaW, align: 'center', lineBreak: false });
        doc.font('Helvetica').fontSize(8).fillColor(C.lightG).text('por mes', c2x, y + 46, { width: cuotaW, align: 'center', lineBreak: false });

        y += cuotaH + 24;
      }

      // ── MÉTODOS DE PAGO ──
      if (options.showPMs && payMethods.length) {
        checkPage(60);
        doc.font('Helvetica-Bold').fontSize(9).fillColor(C.grey).text('MÉTODOS DE PAGO', LM, y);
        y += 14;

        const pmPerRow = 3;
        const pmW = (W - (pmPerRow - 1) * 10) / pmPerRow;
        const pmH = 40;
        let pmRowY = y;

        payMethods.forEach((pm, pi) => {
          const col = pi % pmPerRow;
          if (col === 0 && pi > 0) {
            pmRowY += pmH + 8;
            checkPage(pmH + 8);
          }

          const pmX = LM + col * (pmW + 10);

          doc.save();
          doc.roundedRect(pmX, pmRowY, pmW, pmH, 6).fill(C.bg);
          doc.restore();

          const logoBuf = parseBase64Image(pm.logo_base64);
          let textX = pmX + 10;
          if (logoBuf) {
            try {
              doc.image(logoBuf, pmX + 8, pmRowY + 8, { height: 24, fit: [40, 24] });
              textX = pmX + 52;
            } catch { /* logo inválido */ }
          }

          doc.font('Helvetica-Bold').fontSize(9).fillColor(C.black).text(pm.name || '', textX, pmRowY + 10, { width: pmW - (textX - pmX) - 8 });
          if (pm.description) {
            doc.font('Helvetica').fontSize(7).fillColor(C.lightG).text(pm.description, textX, pmRowY + 24, { width: pmW - (textX - pmX) - 8 });
          }
        });

        const totalRows = Math.ceil(payMethods.length / pmPerRow);
        y = pmRowY + pmH + 12;
      }

      // ── NOTAS ──
      if (q.notes) {
        checkPage(50);
        doc.font('Helvetica').fontSize(10);
        const noteContent = `Notas: ${q.notes}`;
        const notesH = doc.heightOfString(noteContent, { width: W - 28 }) + 20;
        doc.save();
        doc.roundedRect(LM, y, W, notesH, 6).fill(C.bg);
        doc.restore();
        doc.font('Helvetica-Bold').fontSize(10).fillColor(C.grey).text('Notas:', LM + 14, y + 8);
        doc.font('Helvetica').fontSize(10).fillColor(C.grey).text(q.notes, LM + 56, y + 8, { width: W - 78, lineGap: 3 });
        y += notesH + 8;
      }

      // ── NOTA AL PIE ──
      const footNotes = q.footNotes || q.foot_notes || '';
      if (footNotes) {
        checkPage(40);
        drawLine(LM, y, LM + W, C.border, 0.5);
        y += 10;
        doc.font('Helvetica').fontSize(9).fillColor(C.lightG);
        doc.text(footNotes, LM, y, { width: W, lineGap: 4 });
        y += doc.heightOfString(footNotes, { width: W }) + 10;
      }

      // ── FOOTER ──
      checkPage(30);
      drawLine(LM, y, LM + W, C.border, 0.5);
      y += 10;
      doc.font('Helvetica').fontSize(9).fillColor(C.lightG);
      doc.text('• Precios en USD', LM, y);
      y += 12;
      if (options.showCuotasPDF) {
        doc.text('• Cuotas con tarjetas participantes', LM, y);
        y += 12;
      }
      doc.text(`• ${validText} a partir de emisión`, LM, y);

      doc.font('Helvetica').fontSize(9).fillColor(C.lightG).text(q.qNum || '', LM + W - 120, y, { width: 120, align: 'right' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}


// ── AUTH ──────────────────────────────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
    const db   = getFirestore();
    const snap = await db.collection('admins').where('email','==',email).limit(1).get();
    const admin = snap.empty ? null : snap.docs[0].data();
    const valid = admin && bcrypt.compareSync(password, admin.password);
    if (!valid) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const token = jwt.sign({ id: snap.docs[0].id, email: admin.email, name: admin.name }, process.env.JWT_SECRET, { expiresIn: '8h' });
    if (req.session) req.session.adminToken = token;
    res.json({ token, admin: { email: admin.email, name: admin.name } });
  } catch(e) { console.error('API login error:', e.message, e.stack); res.status(500).json({ error: 'Error al iniciar sesión', detail: process.env.NODE_ENV !== 'production' ? e.message : undefined }); }
});

router.post('/auth/logout', (req, res) => { req.session.adminToken = null; res.json({ ok:true }); });

// ── UPLOAD → Firebase Storage ─────────────────────────────────────────────────
router.post('/upload', requireAdminAPI, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió imagen' });
  try {
    const url = await uploadToStorage(req.file.buffer, req.file.originalname, 'uploads');
    res.json({ url });
  } catch (err) {
    console.error('Error subiendo imagen:', err);
    res.status(500).json({ error: 'Error al subir imagen' });
  }
});

router.post('/products/import', requireAdminAPI, excelUpload.single('catalogo'), async (req, res) => {
  let filePath = '';
  try {
    if (!req.file) return res.status(400).json({ error: 'Debes subir un archivo Excel' });
    filePath = req.file.path;
    const hideMissing = String(req.body.hideMissing || '0') === '1';
    const importKind = String(req.body.importKind || 'catalog').toLowerCase();
    const result = importKind === 'inventory'
      ? await importInventoryWorkbook(filePath, { sourceFileName: req.file.originalname })
      : await importCatalogFromWorkbook(filePath, { hideMissing, sourceFileName: req.file.originalname });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
  }
});

// ── PRODUCTS ──────────────────────────────────────────────────────────────────
router.get('/products', async (req, res) => {
  try {
    const db = getFirestore();
    let query = db.collection('products').orderBy('sort_order','asc');
    const snap = await query.get();
    let prods  = snap.docs.map(docToObj);
    if (req.query.category) prods = prods.filter(p => p.category === req.query.category);
    if (req.query.featured)  prods = prods.filter(p => p.featured);
    if (!req.query.all)      prods = prods.filter(p => p.active !== false);
    res.json(prods);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/products/:id', async (req, res) => {
  try {
    const db = getFirestore();
    let doc = await db.collection('products').doc(req.params.id).get();
    if (!doc.exists) {
      const snap = await db.collection('products').where('slug','==',req.params.id).limit(1).get();
      if (snap.empty) return res.status(404).json({ error:'No encontrado' });
      doc = snap.docs[0];
    }
    res.json(docToObj(doc));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/products', requireAdminAPI, upload.single('image'), async (req, res) => {
  try {
    const db = getFirestore();
    const name = cleanText(req.body.name, 160);
    const description = cleanText(req.body.description, 5000);
    const category = cleanText(req.body.category || 'accesorios', 80);
    const price = toNumber(req.body.price, NaN);
    if (!name || !Number.isFinite(price) || price <= 0) {
      return badRequest(res, 'Nombre y precio válidos son requeridos');
    }

    let image_url = cleanText(req.body.image_url, 2000);
    if (req.file) image_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'products');

    const payload = {
      name,
      slug: slugify(name),
      description,
      price,
      original_price: req.body.original_price !== undefined && req.body.original_price !== '' ? toNumber(req.body.original_price, null) : null,
      category,
      badge: cleanText(req.body.badge, 120) || null,
      featured: toBool(req.body.featured, false),
      active: req.body.active !== '0',
      stock: Math.max(0, parseInt(req.body.stock, 10) || 0),
      sort_order: Math.max(0, parseInt(req.body.sort_order, 10) || 0),
      enable_installments: req.body.enable_installments !== undefined ? req.body.enable_installments !== '0' : true,
      image_url,
      img_fit: cleanText(req.body.img_fit || 'contain', 30),
      img_pos: cleanText(req.body.img_pos || 'center', 30),
      img_scale: Math.max(0.2, Math.min(3, toNumber(req.body.img_scale, 1))),
      detail_img_scale: Math.max(0.2, Math.min(3, toNumber(req.body.detail_img_scale, toNumber(req.body.img_scale, 1)))),
      color_variants: parseJsonField(req.body.color_variants, []),
      variants: parseJsonField(req.body.variants, []),
      logos: parseJsonField(req.body.logos, []),
      ficha_tecnica: cleanText(req.body.ficha_tecnica, 12000),
      ficha: parseJsonField(req.body.ficha, {}),
      createdAt: new Date()
    };

    const ref = await db.collection('products').add(payload);
    res.status(201).json({ id: ref.id, slug: payload.slug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/products/:id', requireAdminAPI, upload.single('image'), async (req, res) => {
  try {
    const db  = getFirestore();
    const ref = db.collection('products').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error:'No encontrado' });
    const ex  = doc.data();

    let image_url = req.body.image_url !== undefined ? cleanText(req.body.image_url, 2000) : ex.image_url;
    if (req.file) image_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'products');

    const name = cleanText(req.body.name, 160) || ex.name;
    const payload = {
      name,
      slug: slugify(name),
      description: req.body.description !== undefined ? cleanText(req.body.description, 5000) : (ex.description || ''),
      price: req.body.price !== undefined && req.body.price !== '' ? toNumber(req.body.price, ex.price) : ex.price,
      original_price: req.body.original_price !== undefined ? (req.body.original_price === '' ? null : toNumber(req.body.original_price, ex.original_price || null)) : (ex.original_price || null),
      category: req.body.category !== undefined ? cleanText(req.body.category, 80) : ex.category,
      badge: req.body.badge !== undefined ? (cleanText(req.body.badge, 120) || null) : (ex.badge || null),
      featured: req.body.featured !== undefined ? toBool(req.body.featured, false) : !!ex.featured,
      active: req.body.active !== undefined ? req.body.active !== '0' : ex.active,
      stock: req.body.stock !== undefined ? Math.max(0, parseInt(req.body.stock, 10) || 0) : (ex.stock || 0),
      sort_order: req.body.sort_order !== undefined ? Math.max(0, parseInt(req.body.sort_order, 10) || 0) : (ex.sort_order || 0),
      image_url,
      img_fit: req.body.img_fit !== undefined ? cleanText(req.body.img_fit, 30) : (ex.img_fit || 'contain'),
      img_pos: req.body.img_pos !== undefined ? cleanText(req.body.img_pos, 30) : (ex.img_pos || 'center'),
      img_scale: req.body.img_scale !== undefined ? Math.max(0.2, Math.min(3, toNumber(req.body.img_scale, ex.img_scale || 1))) : (ex.img_scale || 1),
      detail_img_scale: req.body.detail_img_scale !== undefined
        ? Math.max(0.2, Math.min(3, toNumber(req.body.detail_img_scale, ex.detail_img_scale || ex.img_scale || 1)))
        : (ex.detail_img_scale || ex.img_scale || 1),
      color_variants: req.body.color_variants !== undefined ? parseJsonField(req.body.color_variants, []) : (ex.color_variants || []),
      variants: req.body.variants !== undefined ? parseJsonField(req.body.variants, []) : (ex.variants || []),
      logos: req.body.logos !== undefined ? parseJsonField(req.body.logos, []) : (ex.logos || []),
      specs: req.body.specs !== undefined ? parseJsonField(req.body.specs, {}) : (ex.specs || {}),
      ficha_tecnica: req.body.ficha_tecnica !== undefined ? cleanText(req.body.ficha_tecnica, 12000) : (ex.ficha_tecnica || ''),
      ficha: req.body.ficha !== undefined ? parseJsonField(req.body.ficha, {}) : (ex.ficha || {}),
      updatedAt: new Date()
    };

    await ref.update(payload);
    res.json({ ok:true, slug: payload.slug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/products/:id', requireAdminAPI, async (req, res) => {
  try {
    await getFirestore().collection('products').doc(req.params.id).delete();
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/products/bulk-delete', requireAdminAPI, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'No se recibieron productos para eliminar' });
    const db = getFirestore();
    await Promise.all(ids.map(id => db.collection('products').doc(id).delete()));
    res.json({ ok:true, affected: ids.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/inventory-entries', requireAdminAPI, async (req, res) => {
  try {
    const snap = await getFirestore().collection('inventory_entries').orderBy('createdAt','desc').limit(100).get();
    res.json(snap.docs.map(docToObj));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/inventory-entries/:id/cancel', requireAdminAPI, async (req, res) => {
  try {
    const db = getFirestore();
    const ref = db.collection('inventory_entries').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error:'Ingreso no encontrado' });
    const entry = { id: doc.id, ...doc.data() };
    if (entry.status === 'cancelled') return res.status(400).json({ error:'Este ingreso ya fue anulado' });

    const items = Array.isArray(entry.items) ? entry.items : [];
    for (const item of items) {
      if (!item.productId) continue;
      const productRef = db.collection('products').doc(item.productId);
      const productDoc = await productRef.get();
      if (!productDoc.exists) continue;
      const restoreStock = Math.max(0, Number(item.previousStock ?? 0));
      const payload = {
        stock: restoreStock,
        active: item.createdProduct ? false : (item.previousActive !== false),
        updatedAt: new Date(),
        last_entry_cancelled_at: new Date()
      };
      await productRef.set(payload, { merge:true });
    }

    await ref.set({ status:'cancelled', cancelledAt:new Date(), updatedAt:new Date() }, { merge:true });
    res.json({ ok:true, reverted: items.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CATEGORIES ────────────────────────────────────────────────────────────────
router.get('/categories', async (req, res) => {
  try {
    const snap = await getFirestore().collection('categories').where('active','==',true).orderBy('sort_order','asc').get();
    res.json(snap.docs.map(docToObj));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/categories', requireAdminAPI, async (req, res) => {
  try {
    const { name, description, sort_order, bg_color } = req.body;
    if (!name) return res.status(400).json({ error:'Nombre requerido' });
    const ref = await getFirestore().collection('categories').add({ name, slug:slugify(name), description:description||'', sort_order:parseInt(sort_order)||0, bg_color:bg_color||'', active:true, createdAt:new Date() });
    res.status(201).json({ id: ref.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/categories/:id', requireAdminAPI, upload.single('image'), async (req, res) => {
  try {
    const db  = getFirestore();
    const ref = db.collection('categories').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error:'No encontrado' });
    const ex  = doc.data();
    const { name, description, sort_order, active, bg_color, share_whatsapp } = req.body;
    let image_url = req.body.image_url !== undefined ? req.body.image_url : ex.image_url;
    if (req.file) image_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'products');
    await ref.update({
      name: name || ex.name,
      description: description || '',
      image_url: image_url || '',
      sort_order: parseInt(sort_order) || 0,
      bg_color: bg_color || ex.bg_color || '',
      share_whatsapp: share_whatsapp !== undefined ? share_whatsapp !== '0' : (ex.share_whatsapp !== false),
      active: active !== undefined ? active !== '0' : ex.active
    });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/categories/:id', requireAdminAPI, async (req, res) => {
  try {
    await getFirestore().collection('categories').doc(req.params.id).delete();
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── BANNERS ───────────────────────────────────────────────────────────────────
router.get('/banners', async (req, res) => {
  try {
    const snap = await getFirestore().collection('banners').orderBy('sort_order','asc').get();
    const all  = snap.docs.map(docToObj);
    res.json(req.query.all ? all : all.filter(b => b.active !== false));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/banners', requireAdminAPI, upload.single('image'), async (req, res) => {
  try {
    const { title, subtitle, cta_text, cta_url, bg_color, text_color, sort_order } = req.body;
    let image_url = req.body.image_url || '';
    if (req.file) image_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'products');
    const ref = await getFirestore().collection('banners').add({ title:title||'', subtitle:subtitle||'', cta_text:cta_text||'', cta_url:cta_url||'all', image_url, bg_color:bg_color||'#1d1d1f', text_color:text_color||'#ffffff', sort_order:parseInt(sort_order)||0, active:true, createdAt:new Date() });
    res.status(201).json({ id: ref.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/banners/:id', requireAdminAPI, upload.single('image'), async (req, res) => {
  try {
    const db  = getFirestore();
    const ref = db.collection('banners').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error:'No encontrado' });
    const ex = doc.data();
    const { title, subtitle, cta_text, cta_url, bg_color, text_color, active, sort_order } = req.body;
    let image_url = req.body.image_url || ex.image_url;
    if (req.file) image_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'products');
    await ref.update({ title:title||ex.title||'', subtitle:subtitle||ex.subtitle||'', cta_text:cta_text||ex.cta_text||'', cta_url:cta_url||ex.cta_url||'', image_url:image_url||ex.image_url||'', bg_color:bg_color||ex.bg_color||'#1d1d1f', text_color:text_color||ex.text_color||'#ffffff', active:active!==undefined?active==='1':ex.active, sort_order:parseInt(sort_order)||0, updatedAt:new Date() });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/banners/:id', requireAdminAPI, async (req, res) => {
  try {
    await getFirestore().collection('banners').doc(req.params.id).delete();
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────
router.put('/settings/sellers', requireAdminAPI, async (req, res) => {
  try {
    const sellers = Array.isArray(req.body.sellers) ? req.body.sellers : [];
    const cuota_logos = Array.isArray(req.body.cuota_logos) ? req.body.cuota_logos : [];
    const cuotas_active = req.body.cuotas_active !== undefined ? !!req.body.cuotas_active : true;
    await getFirestore().collection('settings').doc('main').set({ sellers, cuota_logos, cuotas_active }, { merge:true });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/settings', async (req, res) => {
  try {
    const doc = await getFirestore().collection('settings').doc('main').get();
    res.json(doc.exists ? doc.data() : {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SITE VERSION (auto-refresh) ───────────────────────────────────────────
router.get('/site-version', async (_req, res) => {
  try {
    const doc = await getFirestore().collection('settings').doc('main').get();
    const v = doc.exists ? (doc.data().site_version || 1) : 1;
    res.json({ version: v });
  } catch(e) { res.json({ version: 1 }); }
});

router.post('/site-version/bump', requireAdminAPI, async (_req, res) => {
  try {
    const v = Date.now();
    await getFirestore().collection('settings').doc('main').set({ site_version: v }, { merge: true });
    res.json({ ok: true, version: v });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/settings', requireAdminAPI, upload.single('logo'), async (req, res) => {
  try {
    const updates = { ...req.body };
    if (req.file) updates.logo_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'logos');
    if (updates.promo_bar_active !== undefined) updates.promo_bar_active = updates.promo_bar_active === '1';
    if (updates.auth_section_active !== undefined) updates.auth_section_active = updates.auth_section_active === '1';
    if (updates.auth_hero_badge_active !== undefined) updates.auth_hero_badge_active = updates.auth_hero_badge_active === '1';
    if (updates.support_section_active !== undefined) updates.support_section_active = updates.support_section_active === '1';
    if (updates.show_ramiro !== undefined) updates.show_ramiro = updates.show_ramiro === '1';
    if (updates.show_admin_icon !== undefined) updates.show_admin_icon = updates.show_admin_icon === '1';
    if (updates.support_cards) try { updates.support_cards = JSON.parse(updates.support_cards); } catch { delete updates.support_cards; }
    if (updates.footer_cols)   try { updates.footer_cols   = JSON.parse(updates.footer_cols);   } catch { delete updates.footer_cols; }
    delete updates.sellers;
    await getFirestore().collection('settings').doc('main').set(updates, { merge:true });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ANNOUNCEMENTS ─────────────────────────────────────────────────────────────
router.get('/announcements', async (req, res) => {
  try {
    const snap = await getFirestore().collection('announcements').get();
    const all  = snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
    res.json(req.query.all ? all : all.filter(a=>a.active!==false));
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post('/announcements', requireAdminAPI, upload.single('image'), async (req, res) => {
  try {
    const { title, link, sort_order, logo_height } = req.body;
    let image_url = req.body.image_url||'';
    if (req.file) image_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'banners');
    const ref = await getFirestore().collection('announcements').add({ title:title||'', link:link||'', image_url, sort_order:parseInt(sort_order)||0, logo_height:parseInt(logo_height)||64, active:true, createdAt:new Date() });
    res.status(201).json({id:ref.id});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.put('/announcements/:id', requireAdminAPI, upload.single('image'), async (req, res) => {
  try {
    const db=getFirestore(); const ref=db.collection('announcements').doc(req.params.id);
    const doc=await ref.get(); if(!doc.exists) return res.status(404).json({error:'No encontrado'});
    const ex=doc.data();
    const { title, link, sort_order, logo_height } = req.body;
    let image_url = req.body.image_url!==undefined ? req.body.image_url : ex.image_url;
    if (req.file) image_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'announcements');
    await ref.update({ title:title||ex.title||'', link:link||'', image_url:image_url||'', sort_order:parseInt(sort_order)||0, logo_height:parseInt(logo_height)||64, updatedAt:new Date() });
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post('/announcements/:id/toggle', requireAdminAPI, async (req, res) => {
  try {
    const ref=getFirestore().collection('announcements').doc(req.params.id);
    const doc=await ref.get(); if(!doc.exists) return res.status(404).json({error:'No encontrado'});
    await ref.update({active:doc.data().active===false});
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.delete('/announcements/:id', requireAdminAPI, async (req, res) => {
  try {
    await getFirestore().collection('announcements').doc(req.params.id).delete();
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── PAYMENT METHODS ───────────────────────────────────────────────────────
router.get('/payment-methods', async (req, res) => {
  try {
    const snap = await getFirestore().collection('payment_methods').orderBy('sort_order','asc').get();
    res.json(snap.docs.map(d=>({id:d.id,...d.data()})));
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post('/payment-methods', requireAdminAPI, upload.single('logo'), async (req, res) => {
  try {
    const {name,description,sort_order} = req.body;
    if(!name) return res.status(400).json({error:'Nombre requerido'});
    let logo_url = req.body.logo_url||'';
    if (req.file) logo_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'logos');
    const ref = await getFirestore().collection('payment_methods').add({
      name, description:description||'', logo_url, sort_order:parseInt(sort_order)||0,
      active:true, createdAt:new Date()
    });
    res.status(201).json({id:ref.id});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.put('/payment-methods/:id', requireAdminAPI, upload.single('logo'), async (req, res) => {
  try {
    const ref = getFirestore().collection('payment_methods').doc(req.params.id);
    const doc = await ref.get(); if(!doc.exists) return res.status(404).json({error:'No encontrado'});
    const ex  = doc.data();
    const {name,description,sort_order,active} = req.body;
    let logo_url = req.body.logo_url!==undefined ? req.body.logo_url : ex.logo_url;
    if (req.file) logo_url = await uploadToStorage(req.file.buffer, req.file.originalname, 'logos');
    await ref.update({name:name||ex.name,description:description||'',logo_url,sort_order:parseInt(sort_order)||0,active:active!=='0'});
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.delete('/payment-methods/:id', requireAdminAPI, async (req, res) => {
  try {
    await getFirestore().collection('payment_methods').doc(req.params.id).delete();
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── QUOTATIONS HISTORY ────────────────────────────────────────────────────
router.get('/quotations', requireAdminAPI, async (req, res) => {
  try {
    const snap = await getFirestore().collection('quotations').orderBy('createdAt','desc').limit(500).get();
    let quotes = snap.docs.map(d=>({id:d.id,...d.data()}));
    const {client,company,seller,product,from,to,ivaMode} = req.query;
    if(client)  quotes=quotes.filter(q=>(q.client||'').toLowerCase().includes(client.toLowerCase()));
    if(company) quotes=quotes.filter(q=>(q.company||'').toLowerCase().includes(company.toLowerCase()));
    if(seller)  quotes=quotes.filter(q=>(q.seller||'').toLowerCase().includes(seller.toLowerCase()));
    if(product) quotes=quotes.filter(q=>(q.items||[]).some(i=>(i.name||'').toLowerCase().includes(product.toLowerCase())));
    if(ivaMode) quotes=quotes.filter(q=>q.ivaMode===ivaMode);
    if(from){const d=new Date(from);quotes=quotes.filter(q=>q.createdAt?.toDate?.()>=d);}
    if(to){const d=new Date(to);d.setHours(23,59,59);quotes=quotes.filter(q=>q.createdAt?.toDate?.()<=d);}
    res.json(quotes);
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post('/quotations', requireAdminAPI, async (req, res) => {
  try {
    const {client,company,seller,notes,validity,ivaMode,items,total,lbl1,lbl2,div1,div2,qNum,client_phone,client_email,foot_notes} = req.body;
    if(!client&&!company) return res.status(400).json({error:'Ingresa al menos cliente o empresa'});
    const ref = await getFirestore().collection('quotations').add({
      client:client||'', company:company||'', seller:seller||'', notes:notes||'',
      validity:String(validity||'7'), ivaMode:ivaMode||'con',
      items: Array.isArray(items) ? items : [],
      total:parseFloat(total)||0,
      lbl1:lbl1||'6 cuotas', lbl2:lbl2||'10 cuotas',
      div1:parseInt(div1)||6, div2:parseInt(div2)||10,
      qNum:qNum||'',
      client_phone:client_phone||'',
      client_email:client_email||'',
      foot_notes:foot_notes||'',
      createdAt:new Date()
    });
    res.status(201).json({id:ref.id});
  } catch(e) { res.status(500).json({error:e.message}); }
});


// ══════════════════════════════════════════════════════════════════════════
// EXPORT PDF — PDF NATIVO CON PDFKIT
// Guarda UNA sola vez en historial (eliminado el doble guardado del original)
// ══════════════════════════════════════════════════════════════════════════
router.post('/quotations/export-pdf', async (req, res) => {

  try {
    const {
      client, company, seller, notes, validity, ivaMode,
      items, total, lbl1, lbl2, div1, div2, qNum,
      client_phone, client_email, foot_notes, footNotes,
      saveHistory, settings, options, paymentMethods
    } = req.body;

    if (!client && !company) return res.status(400).json({ error: 'Ingresa al menos cliente o empresa' });

    const quotation = {
      client: client || '',
      company: company || '',
      seller: seller || '',
      notes: notes || '',
      validity: String(validity || '7'),
      ivaMode: ivaMode || 'con',
      items: Array.isArray(items) ? items : [],
      total: parseFloat(total) || 0,
      lbl1: lbl1 || '6 cuotas sin intereses',
      lbl2: lbl2 || '10 cuotas sin intereses',
      div1: parseInt(div1) || 6,
      div2: parseInt(div2) || 10,
      qNum: qNum || ('COT-' + Date.now().toString().slice(-6)),
      client_phone: client_phone || '',
      client_email: client_email || '',
      foot_notes: foot_notes || '',
      footNotes: footNotes || foot_notes || '',
      settings: settings || {},
      options: options || {},
      paymentMethods: Array.isArray(paymentMethods) ? paymentMethods : [],
      createdAt: new Date()
    };

    // Guardar en historial UNA SOLA VEZ
    if (saveHistory !== false) {
      try {
        await getFirestore().collection('quotations').add({
          client: quotation.client,
          company: quotation.company,
          seller: quotation.seller,
          notes: quotation.notes,
          validity: quotation.validity,
          ivaMode: quotation.ivaMode,
          items: quotation.items.map(i => ({
            name: i.name, price: i.price, qty: i.qty,
            discount: i.discount || 0, variant: i.variant || '',
            specs: i.specs || {}, image_url: i.image_url || ''
          })),
          total: quotation.total,
          lbl1: quotation.lbl1, lbl2: quotation.lbl2,
          div1: quotation.div1, div2: quotation.div2,
          qNum: quotation.qNum,
          client_phone: quotation.client_phone,
          client_email: quotation.client_email,
          foot_notes: quotation.footNotes,
          createdAt: new Date()
        });
      } catch (e) {
        console.warn('No se pudo guardar historial:', e.message);
      }
    }

    if (!quotation.footNotes) {
      try {
        const sDoc = await getFirestore().collection('settings').doc('main').get();
        if (sDoc.exists && sDoc.data().pdf_foot_notes) quotation.footNotes = sDoc.data().pdf_foot_notes;
      } catch(e) {}
    }
    const pdfBuffer = await buildPdfBuffer(quotation);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${quotation.qNum}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) {
    console.error('Error generando PDF:', e);
    res.status(500).json({ error: e.message });
  }
});

// Regenerar PDF desde historial (admin)
router.get('/quotations/:id/pdf', requireAdminAPI, async (req, res) => {
  try {
    const doc = await getFirestore().collection('quotations').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Cotización no encontrada' });

    const data = doc.data();
    const quotation = {
      ...data,
      id: doc.id,
      options: data.options || { showSpecs: true, showFichaGlobal: false, showCuotasPDF: true, showPMs: false },
      settings: data.settings || {},
      paymentMethods: data.paymentMethods || [],
      footNotes: data.foot_notes || data.footNotes || ''
    };

    const pdfBuffer = await buildPdfBuffer(quotation);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${quotation.qNum || 'cotizacion'}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/quotations/:id', requireAdminAPI, async (req, res) => {
  try {
    await getFirestore().collection('quotations').doc(req.params.id).delete();
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── VENDEDORES (público) ──────────────────────────────────────────────────
router.get('/sellers', async (req, res) => {
  try {
    const doc = await getFirestore().collection('settings').doc('main').get();
    const data = doc.exists ? doc.data() : {};
    const sellers = Array.isArray(data.sellers) ? data.sellers
      : (typeof data.sellers === 'string' ? JSON.parse(data.sellers || '[]') : []);
    res.json(sellers);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── CLIENTES PARA AUTOCOMPLETAR ───────────────────────────────────────────
router.get('/clients-public', requireAdminAPI, async (req, res) => {
  try {
    const snap = await getFirestore().collection('quotations')
      .orderBy('createdAt','desc').limit(300).get();
    const seen = new Map();
    snap.docs.forEach(d=>{
      const q = d.data();
      const key = (q.client||'').toLowerCase()+(q.company||'').toLowerCase();
      if(key && !seen.has(key)) seen.set(key, {
        client:  q.client||'',
        company: q.company||'',
        phone:   q.client_phone||''
      });
    });
    res.json([...seen.values()]);
  } catch(e) { res.status(500).json({error:e.message}); }
});

module.exports = router;

// ── GEMINI ASSISTANT ──────────────────────────────────────────────────────
const crypto = require('crypto');
const GEMINI_API_KEY = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || '';
const GEMINI_MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
const geminiModelCache = { models: null, loadedAt: 0 };

async function fetchGeminiCandidateModels() {
  const now = Date.now();
  if (Array.isArray(geminiModelCache.models) && geminiModelCache.models.length && now - geminiModelCache.loadedAt < GEMINI_MODEL_CACHE_TTL_MS) {
    return geminiModelCache.models;
  }

  const https = require('https');
  const discovered = await new Promise((resolve, reject) => {
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
    const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error?.message) return reject(new Error(parsed.error.message));
          const models = (parsed.models || [])
            .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
            .map(m => String(m.name || '').replace(/^models\//, ''))
            .filter(Boolean);
          resolve(models);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });

  const defaults = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  const merged = [GEMINI_MODEL, ...discovered, ...defaults].filter((m, i, arr) => m && arr.indexOf(m) === i);
  geminiModelCache.models = merged;
  geminiModelCache.loadedAt = now;
  return merged;
}

const FRONT_ALLOWED_FILES = [
  'views/home.ejs',
  'views/category.ejs',
  'views/product.ejs',
  'views/partials/header.ejs',
  'views/partials/footer.ejs',
  'public/css/macstore.css',
  'public/js/macstore.js'
];

const FRONT_TARGET_GROUPS = {
  home: ['views/home.ejs', 'views/partials/header.ejs', 'views/partials/footer.ejs', 'public/css/macstore.css'],
  catalogo: ['views/category.ejs', 'views/partials/header.ejs', 'views/partials/footer.ejs', 'public/css/macstore.css'],
  producto: ['views/product.ejs', 'views/partials/header.ejs', 'views/partials/footer.ejs', 'public/css/macstore.css'],
  layout: ['views/partials/header.ejs', 'views/partials/footer.ejs', 'public/css/macstore.css'],
  todo: FRONT_ALLOWED_FILES
};

const frontPreviewStore = new Map();
const ramiroPendingConfirmations = new Map();
const RAMIRO_CONFIRM_TTL_MS = 5 * 60 * 1000;
// Guarda el mensaje del turno anterior cuando Ramiro pidió aclaración
const ramiroLastClarification = new Map();
const RAMIRO_CLARIF_TTL_MS = 3 * 60 * 1000;
// Cache en memoria de patrones ya aprendidos (persisten en Firestore, aquí es acceso rápido)
const ramiroLearnedPatterns = new Map();

function cleanGeminiJson(rawText) {
  let text = String(rawText || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  
  // Reparar JSON incompleto (falta llave final)
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

function findDuplicateWithoutImage(products, baseProduct) {
  if (!baseProduct || !Array.isArray(products)) return null;
  const baseName = String(baseProduct.name || '').trim();
  if (!baseName) return null;
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

  return candidates.length ? candidates[0].p : null;
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

function findDuplicateWithoutImageByRef(products, ref) {
  const base = findProductByRef(products, ref);
  if (!base) return null;
  return findDuplicateWithoutImage(products, base);
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

function parsePlanJson(rawText) {
  try {
    const parsed = JSON.parse(cleanGeminiJson(rawText));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      intentType: cleanText(parsed.intentType || 'unknown', 60) || 'unknown',
      targetEntity: cleanText(parsed.targetEntity || '', 60) || null,
      targetName: cleanText(parsed.targetName || '', 140) || null,
      goal: cleanText(parsed.goal || '', 300) || '',
      needsResearch: parsed.needsResearch === true,
      needsConfirmation: parsed.needsConfirmation === true,
      steps: Array.isArray(parsed.steps)
        ? parsed.steps.map(s => cleanText(s, 140)).filter(Boolean).slice(0, 12)
        : [],
      clarificationQuestion: cleanText(parsed.clarificationQuestion || '', 260) || ''
    };
  } catch {
    return null;
  }
}

function isExplicitConfirmation(message) {
  const norm = normalizeForMatch(message);
  return /^(si|sí|confirmo|confirmado|dale|hazlo|hace lo|ejecuta|procede|ok(?:ay)?|de una)$/.test(norm)
    || /^(si confirma|sí confirma|elimina|borra)$/.test(norm)
    || /\b(confirma|confirmado|hazlo|ejecuta|procede)\b/.test(norm);
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
  if (action === 'PRODUCT_CREATE') return true; // siempre pedir confirmación antes de crear
  if (action === 'PRODUCT_UPDATE' && data?.updates) {
    const keys = Object.keys(data.updates || {});
    // Cambios mixtos grandes: pedimos confirmación cuando toca varios campos de una sola vez.
    return keys.length >= 5;
  }
  return false;
}

function isAmbiguousShortCommand(message) {
  const raw = String(message || '').trim();
  if (!raw) return false;
  return /^(?:hey\s+)?(?:quitalo|quitala|quitale|cambialo|cambiala|arreglalo|arreglala|dejalo|dejala|ponlo|ponla|borralo|eliminalo|edita eso|cambia eso)$/i.test(raw)
    || /^(?:hey\s+)?(?:quita|cambia|edita|arregla|pon|borra|elimina)\s+(?:eso|esto|ese|esa|aquel|aquello)$/i.test(raw);
}

function buildFrontFilesSnapshot(target) {
  const rootDir = path.join(__dirname, '..');
  const selected = FRONT_TARGET_GROUPS[target] || FRONT_TARGET_GROUPS.todo;
  return selected.map(relPath => {
    const absPath = path.join(rootDir, relPath);
    const content = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';
    return { relPath, absPath, content };
  });
}

function validateFrontChanges(changes) {
  if (!Array.isArray(changes) || !changes.length) {
    throw new Error('Gemini no devolvió cambios válidos');
  }
  const unique = new Set();
  changes.forEach(change => {
    if (!change || typeof change !== 'object') throw new Error('Formato de cambio inválido');
    if (!FRONT_ALLOWED_FILES.includes(change.path)) throw new Error(`Archivo no permitido: ${change.path}`);
    if (unique.has(change.path)) throw new Error(`Archivo repetido: ${change.path}`);
    if (typeof change.content !== 'string') throw new Error(`Contenido inválido para ${change.path}`);
    if (change.content.length < 10) throw new Error(`Contenido demasiado corto para ${change.path}`);
    unique.add(change.path);
  });
}

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) {
    throw new Error('Falta GOOGLE_AI_API_KEY (o GEMINI_API_KEY) en variables de entorno');
  }
  const https = require('https');
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096 }
  });

  let candidateModels = [];
  try {
    candidateModels = await fetchGeminiCandidateModels();
  } catch {
    candidateModels = [GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']
      .filter((m, i, arr) => m && arr.indexOf(m) === i);
  }

  let lastError = null;
  for (const model of candidateModels) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    try {
      const text = await new Promise((resolve, reject) => {
        const url = new URL(geminiUrl);
        const options = {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        };
        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error?.message) return reject(new Error(parsed.error.message));
              const out = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
              resolve(out);
            } catch(e) { reject(e); }
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
      const shouldTryNext = msg.includes('not found') || msg.includes('not supported') || msg.includes('model');
      if (!shouldTryNext) break;
    }
  }

  throw lastError || new Error('No fue posible obtener respuesta de Gemini');
}

// Respuesta general del chatbot
router.post('/gemini/ask', requireAdminAPI, async (req, res) => {
  try {
    const { message, context } = req.body;
    if(!message) return res.status(400).json({ error: 'Falta mensaje' });
    const prompt = `${context || 'Eres el asistente de MacStore.'}\n\nAdmin dice: "${message}"\n\nResponde de forma útil, concisa y en español.`;
    const reply = await callGemini(prompt);
    res.json({ reply: reply.trim() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Buscar productos para el selector
router.get('/gemini/search', requireAdminAPI, async (req, res) => {
  try {
    const { q } = req.query;
    const snap = await getFirestore().collection('products').get();
    let products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (q) {
      const term = q.toLowerCase();
      products = products.filter(p => (p.name||'').toLowerCase().includes(term));
    }
    res.json(products.slice(0, 20).map(p => ({
      id: p.id,
      name: p.name,
      category: p.category,
      active: p.active !== false,
      price: p.price,
      image_url: p.image_url || ''
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Obtener producto completo
router.get('/gemini/product/:id', requireAdminAPI, async (req, res) => {
  try {
    const doc = await getFirestore().collection('products').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'No encontrado' });
    res.json({ id: doc.id, ...doc.data() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Chat con Gemini — interpretar instrucción y ejecutar
router.post('/gemini/chat', requireAdminAPI, async (req, res) => {
  try {
    const { productId, instruction, productData } = req.body;
    if (!productId || !instruction) return res.status(400).json({ error: 'Faltan datos' });

    const product = productData || {};

    const prompt = `Eres un asistente de gestión de inventario para MacStore, una tienda Apple en El Salvador.
Tienes el siguiente producto en la base de datos:
${JSON.stringify(product, null, 2)}

El administrador dice: "${instruction}"

Tu tarea es interpretar la instrucción y devolver ÚNICAMENTE un objeto JSON con los campos del producto que deben actualizarse.
No inventes datos que no estén en la instrucción.
Si la instrucción es pegar una ficha técnica, extrae: nombre, descripción, variantes de capacidad (variants), colores (color_variants con solo el nombre), specs técnicas (specs_table como array de {label, value}), precio si se menciona.
Si dice "desactiva", devuelve {"active": false}.
Si dice "activa", devuelve {"active": true}.
Si dice "cambia precio a X", devuelve {"price": X}.

Responde SOLO con el JSON, sin explicaciones, sin markdown, sin bloques de código.`;

    const geminiResponse = await callGemini(prompt);

    let updates;
    try {
      updates = JSON.parse(cleanGeminiJson(geminiResponse));
    } catch(e) {
      return res.json({ success: false, message: 'Gemini respondió: ' + geminiResponse, raw: true });
    }

    await getFirestore().collection('products').doc(productId).update({
      ...updates,
      updatedAt: new Date()
    });

    res.json({ success: true, updates, message: 'Producto actualizado correctamente' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GEMINI FRONT EDITOR (preview + apply) ────────────────────────────────
router.post('/gemini/front-preview', requireAdminAPI, async (req, res) => {
  try {
    const instruction = cleanText(req.body.instruction, 6000);
    const target = cleanText(req.body.target || 'todo', 40).toLowerCase();
    if (!instruction) return res.status(400).json({ error: 'Escribe una instrucción' });

    const fileSnapshot = buildFrontFilesSnapshot(target);
    const filesPrompt = fileSnapshot.map(f => `### FILE: ${f.relPath}\n${f.content}`).join('\n\n');

    const prompt = `Eres un experto en frontend (EJS + CSS + JS vanilla).
Debes proponer cambios sobre estos archivos del proyecto.

INSTRUCCIÓN DEL ADMIN:
${instruction}

ARCHIVOS DISPONIBLES:
${fileSnapshot.map(f => `- ${f.relPath}`).join('\n')}

CONTENIDO ACTUAL:
${filesPrompt}

Reglas estrictas:
1) Devuelve SOLO JSON válido.
2) Formato exacto:
{
  "summary": "resumen corto",
  "changes": [
    { "path": "ruta/archivo", "content": "contenido completo final del archivo" }
  ]
}
3) Solo puedes usar rutas listadas en ARCHIVOS DISPONIBLES.
4) Cada content debe ser el archivo COMPLETO, no fragmentos.
5) No cambies texto de negocio (precios, teléfonos, datos comerciales) salvo que la instrucción lo pida.
6) Mantén compatibilidad responsive (desktop y mobile).
7) Conserva sintaxis EJS válida.
8) Si no necesitas editar un archivo, no lo incluyas.`;

    const geminiResponse = await callGemini(prompt);
    let parsed;
    try {
      parsed = JSON.parse(cleanGeminiJson(geminiResponse));
    } catch {
      return res.status(400).json({ error: 'Gemini no devolvió JSON válido', raw: geminiResponse });
    }

    const changes = Array.isArray(parsed.changes) ? parsed.changes : [];
    validateFrontChanges(changes);

    const rootDir = path.join(__dirname, '..');
    const normalizedChanges = changes.map(c => {
      const absPath = path.join(rootDir, c.path);
      const before = fs.readFileSync(absPath, 'utf8');
      return {
        path: c.path,
        absPath,
        before,
        after: c.content,
        changed: before !== c.content
      };
    }).filter(c => c.changed);

    if (!normalizedChanges.length) {
      return res.json({ ok: true, summary: parsed.summary || 'No hubo cambios necesarios', token: null, files: [] });
    }

    const token = crypto.randomUUID();
    const expiresAt = Date.now() + (30 * 60 * 1000);
    frontPreviewStore.set(token, { expiresAt, changes: normalizedChanges });

    res.json({
      ok: true,
      summary: parsed.summary || 'Vista previa generada',
      token,
      files: normalizedChanges.map(c => ({
        path: c.path,
        beforeSize: c.before.length,
        afterSize: c.after.length,
        preview: c.after.slice(0, 2400)
      }))
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/gemini/front-apply', requireAdminAPI, async (req, res) => {
  try {
    const token = cleanText(req.body.token, 120);
    if (!token) return res.status(400).json({ error: 'Token requerido' });

    const preview = frontPreviewStore.get(token);
    if (!preview) return res.status(404).json({ error: 'Preview no encontrado o expirado' });
    if (Date.now() > preview.expiresAt) {
      frontPreviewStore.delete(token);
      return res.status(410).json({ error: 'Preview expirado, genera uno nuevo' });
    }

    const rootDir = path.join(__dirname, '..');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(rootDir, '.ai-front-backups', `${stamp}-${token.slice(0, 8)}`);

    for (const c of preview.changes) {
      const backupPath = path.join(backupDir, c.path);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.writeFileSync(backupPath, c.before, 'utf8');
    }

    for (const c of preview.changes) {
      fs.writeFileSync(c.absPath, c.after, 'utf8');
    }

    frontPreviewStore.delete(token);

    res.json({
      ok: true,
      changedFiles: preview.changes.map(c => c.path),
      backupDir: path.relative(rootDir, backupDir)
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════
// RAMIRO — Asistente IA completo de MacStore
// ══════════════════════════════════════════════

function isBlockedPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|0\.0\.0\.0|169\.254\.)/.test(h);
}

async function fetchExternalUrlText(url) {
  if (!url) throw new Error('Falta URL');

  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error('URL inválida'); }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Protocolo no permitido');
  }
  if (isBlockedPrivateHost(parsed.hostname)) {
    throw new Error('URL no permitida');
  }

  const https = require('https');
  const http = require('http');
  const lib = parsed.protocol === 'https:' ? https : http;

  const content = await new Promise((resolve, reject) => {
    const request = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (resp) => {
      if (resp.statusCode === 301 || resp.statusCode === 302) {
        return resolve(`REDIRECT:${resp.headers.location || ''}`);
      }
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => resolve(data));
    });
    request.on('error', reject);
    request.setTimeout(12000, () => { request.destroy(); reject(new Error('Timeout')); });
  });

  return String(content || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{3,}/g, '\n')
    .slice(0, 12000);
}

async function appendRamiroTranscript(db, payload) {
  await db.collection('ramiro_transcripts').add({
    ...payload,
    createdAt: new Date()
  });
}

function buildStyleHintsFromMessages(messages) {
  const msgs = (messages || []).slice(-20).map(m => String(m || '').trim()).filter(Boolean);
  if (!msgs.length) return '';
  return msgs
    .map(t => `- ${t.slice(0, 220)}`)
    .join('\n');
}

// Obtener configuración y memoria de Ramiro
router.get('/ramiro/config', requireAdminAPI, async (req, res) => {
  try {
    const db = getFirestore();
    const doc = await db.collection('settings').doc('ramiro').get();
    const defaults = {
      name: 'Ramiro',
      personality: 'Soy Ramiro, tu asistente personal de MacStore. Conozco tu tienda, tus productos y estoy aquí para facilitarte el trabajo.',
      greeting: '¡Hola! Soy Ramiro, tu asistente de MacStore. ¿En qué te ayudo hoy?',
      avatar_color: '#0071e3',
      autonomous_mode: true,
      memory: [],
      notes: ''
    };
    res.json(doc.exists ? { ...defaults, ...doc.data() } : defaults);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Guardar configuración de Ramiro
router.put('/ramiro/config', requireAdminAPI, async (req, res) => {
  try {
    const { name, personality, greeting, avatar_color, notes, autonomous_mode } = req.body;
    await getFirestore().collection('settings').doc('ramiro').set(
      {
        name,
        personality,
        greeting,
        avatar_color,
        notes,
        autonomous_mode: autonomous_mode !== false,
        updatedAt: new Date()
      },
      { merge: true }
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RAMIRO ENDPOINTS MOVED TO routes/ramiro.js ────────────────────────────
// POST /ramiro/chat, /ramiro/memory, /ramiro/fetch-url are now in dedicated route
//
// Routes have been extracted for better modularity and scalability.
// See routes/ramiro.js for the Ramiro AI assistant implementation.

// Ruta de configuración de Ramiro en el admin
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
    const hasCapacityEnableCommand = /(?:habilita|habilitar|activa|activar)\s+[0-9]{2,4}\s?gb\s+para\s+/i.test(String(message || ''));
    const shouldForceDeterministic = !response.action || response.action === 'INFO' || invalidUpdateAction || invalidCreateAction || hasCapacityEnableCommand || isTemplatePlaceholder;

    if (shouldForceDeterministic) {
      response = { message: response.message || '', action: null, data: null };
      const msg = String(message || '').trim();
      const msgNorm = normalizeForMatch(msg);
      const targetFromRef = (ref) => resolveTargetProduct(allProducts, ref, implicitTargetProduct);

      const complaintIntent = /(equivoc|no era|no es|te pasaste|la cagaste|mala|mal|incorrect)/i.test(msgNorm);
      if (complaintIntent) {
        response = {
          message: 'Entendido. No ejecutaré cambios destructivos ahora. Dime exactamente cuál quieres mantener y cuál eliminar, y lo hago con confirmación.',
          action: null,
          data: null
        };
      }

      // -2) Saludo o mensaje genérico sin contexto de acción
      if (!response.action) {
        const greetIntent = /^(ayuda(me)?|me ayudas?|hola|hey( ramiro)?|buenas?|qu[eé] puedes?|para qu[eé] sirves?|qu[eé] haces?)\s*[.!?]*$/i.test(msg.trim());
        if (greetIntent || isTemplatePlaceholder) {
          response = {
            message: '¿En qué te puedo ayudar?',
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
        const createCmd = msg.match(/^(?:me\s+)?(?:agrega|agregar|crea|crear|anade|añade)\s+(?:producto\s+)?(.+)$/i);
        if (createCmd && !/(colores?|imagen|foto|precio)/i.test(msgNorm)) {
          const rawName = cleanText(createCmd[1], 160).replace(/[.,;]+$/, '').trim();
          const cleanName = rawName.replace(/^(unos?|unas?)\s+/i, '').trim();
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
          message: '¿En qué te puedo ayudar?',
          action: null,
          data: null
        };
      }
    }

    // Guardrails por intención: evita que Gemini meta cambios no pedidos
    const userMsg = String(message || '');
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
      const intentFields =
        /(?:habilita|habilitar|activa|activar)\s+[0-9]{2,4}\s?gb\s+para\s+/i.test(userMsg) ? ['variants', 'color_variants'] :
        /(colores?|color)/i.test(userMsgNorm) ? ['color_variants'] :
        /(imagen|foto)/i.test(userMsgNorm) ? ['image_url'] :
        /(precio|\$|sube|subir|subilo|subile|baja|bajar|bajalo|bajale|aumenta|descuenta|rebaja)/i.test(userMsgNorm) ? ['price'] :
        /(stock|inventario)/i.test(userMsgNorm) ? ['stock'] :
        /(activa|activar|desactiva|desactivar|inactivo|activo)/i.test(userMsgNorm) ? ['active'] :
        null;

      if (intentFields) {
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
    const complaintGuard = /(equivoc|no era|incorrect|mal|error)/i.test(normalizeForMatch(String(message || '')));
    if (complaintGuard && (response.action === 'PRODUCT_DELETE' || response.action === 'BULK_ACTION' || response.action === 'SYNC_FROM_URL')) {
      response = {
        message: 'Entendido, no ejecuto más borrados por ahora. Dime cuál producto exacto quieres conservar y cuál eliminar.',
        action: null,
        data: null
      };
    }

    // Si el admin confirma una acción sensible pendiente, la reutilizamos tal cual.
    const freshPending = ramiroPendingConfirmations.get(adminKey);
    if (isExplicitConfirmation(String(message || '')) && freshPending && freshPending.expiresAt >= Date.now()) {
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
    const mustConfirmRisk = (plan?.needsConfirmation === true) || isPotentiallyRiskyAction(response.action, response.data);
    if (mustConfirmRisk && !isExplicitConfirmation(String(message || ''))) {
      ramiroPendingConfirmations.set(adminKey, {
        response: {
          action: response.action,
          data: response.data,
          intentType: plan?.intentType || response.intentType || null,
          message: response.message || 'Acción sensible pendiente de confirmación.'
        },
        plan: plan || null,
        expiresAt: Date.now() + RAMIRO_CONFIRM_TTL_MS
      });
      const summary = buildRiskSummary(response.action, response.data);
      const plannedSteps = Array.isArray(plan?.steps) && plan.steps.length
        ? `\nPlan:\n- ${plan.steps.join('\n- ')}`
        : '';
      const confirmWord = response.action === 'PRODUCT_CREATE' ? 'Confirmá para crear o dame más datos.' : 'Confirmá para ejecutar.';
      return res.json({
        message: `${summary}${plannedSteps}\n\n${confirmWord}`,
        action: null,
        data: null,
        intentType: plan?.intentType || response.intentType || null,
        needsConfirmation: true
      });
    }

    // Ejecutar acción si viene
    let actionResult = null;
    const ALLOWED_UPDATE_FIELDS = ['price', 'active', 'description', 'variants', 'color_variants', 'stock', 'specs', 'badge', 'image_url'];

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
          const syncPrompt = `Extrae productos de este texto de catálogo y devuelve SOLO JSON válido.
Formato: {"products":[{"name":"Nombre","category":"mac|iphone|ipad|airpods","price":0,"description":"texto"}]}
Reglas: price siempre número, category solo mac|iphone|ipad|airpods, no inventes campos.
TEXTO:\n${rawText}`;
          const syncRaw = await callGemini(syncPrompt);
          let parsedSync;
          try { parsedSync = JSON.parse(cleanGeminiJson(syncRaw)); }
          catch { throw new Error('No se pudo interpretar JSON de sincronización'); }
          const productsToSync = Array.isArray(parsedSync.products) ? parsedSync.products : [];
          syncResult = await syncProductsFromArray(productsToSync, url);
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
      action: response.action || null,
      actionResult: actionResult || null,
      adminEmail: req.admin?.email || ''
    });

    res.json({
      message: finalMessage,
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

// Ruta de configuración de Ramiro en el admin
