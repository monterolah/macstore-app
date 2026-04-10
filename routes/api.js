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

// Guardar memoria de Ramiro
router.post('/ramiro/memory', requireAdminAPI, async (req, res) => {
  try {
    const { entry } = req.body;
    if (!entry) return res.status(400).json({ error: 'Falta entry' });
    const db = getFirestore();
    const doc = await db.collection('settings').doc('ramiro').get();
    const current = doc.exists ? (doc.data().memory || []) : [];
    const newMemory = [
      { text: entry, date: new Date().toISOString() },
      ...current
    ].slice(0, 100); // máximo 100 memorias
    await db.collection('settings').doc('ramiro').set({ memory: newMemory }, { merge: true });
    res.json({ ok: true, total: newMemory.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Borrar una memoria específica
router.delete('/ramiro/memory/:index', requireAdminAPI, async (req, res) => {
  try {
    const idx = parseInt(req.params.index);
    const db = getFirestore();
    const doc = await db.collection('settings').doc('ramiro').get();
    const memory = doc.exists ? (doc.data().memory || []) : [];
    memory.splice(idx, 1);
    await db.collection('settings').doc('ramiro').set({ memory }, { merge: true });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Leer URL externa (para que Ramiro lea fichas de Apple, etc.)
router.post('/ramiro/fetch-url', requireAdminAPI, async (req, res) => {
  try {
    const { url } = req.body;
    const text = await fetchExternalUrlText(url);
    res.json({ ok: true, text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Chat principal de Ramiro — con contexto completo, memoria y acciones
router.post('/ramiro/chat', requireAdminAPI, async (req, res) => {
  try {
    const { message, history, pageContext } = req.body;
    if (!message) return res.status(400).json({ error: 'Falta mensaje' });

    const db = getFirestore();

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
      .limit(80)
      .get();
    const transcriptRows = transcriptSnap.docs.map(d => d.data()).reverse();
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
      image_url: d.data().image_url || '', stock: d.data().stock || 0,
      specs: d.data().specs || {}, color_variants: d.data().color_variants || [],
      variants: d.data().variants || []
    }));

    // Cargar settings de la tienda
    const settDoc = await db.collection('settings').doc('main').get();
    const storeSettings = settDoc.exists ? settDoc.data() : {};

    // Cargar cotizaciones recientes
    const quotSnap = await db.collection('quotations').orderBy('createdAt', 'desc').limit(10).get();
    const recentQuotations = quotSnap.docs.map(d => ({
      id: d.id, client: d.data().client, total: d.data().total,
      createdAt: d.data().createdAt?.toDate?.()?.toLocaleDateString('es-SV') || 'reciente'
    }));

    // Construir catálogo detallado para el prompt
    const catalogoDetallado = allProducts.map(p => 
      `[${p.id}] ${p.name} (${p.category}): $${p.price}`
    ).join('\n');

    // Construir prompt de sistema - CONCISO y DIRECTO
    const systemPrompt = `Eres Ramiro, asistente de MacStore (tienda Apple).

📦 CATÁLOGO (${allProducts.length} productos):
${catalogoDetallado}

⚡ ACCIONES - Responde SOLO JSON válido, sin markdown:

1. PRODUCT_UPDATE: Modificar producto
   {"message":"✅ actualizado","action":"PRODUCT_UPDATE","data":{"productId":"ID","updates":{"price":999,"color_variants":["Rojo"]}}}

2. PRODUCT_CREATE: Crear producto
   {"message":"✅ creado","action":"PRODUCT_CREATE","data":{"product":{"name":"...","category":"mac|iphone|ipad|airpods","price":999}}}

3. PRODUCT_DELETE: Borrar producto
   {"message":"✅ borrado","action":"PRODUCT_DELETE","data":{"productId":"ID"}}

4. INFO: Solo responder
   {"message":"Tu respuesta aquí","action":null}

REGLAS CRÍTICAS:
- Busca productId por nombre exacto en el catálogo
- Si no encuentras producto, pregunta antes de actuar
- Responde SIEMPRE con JSON válido, JAMÁS con markdown
- En "updates" incluye SOLO los campos que cambian
- Campos permitidos: price, description, variants, color_variants, stock, active, specs, badge, image_url

Estilo: Responde en español, conversacional y conciso.`;



    // Construir historial de conversación como texto para incluir en el prompt
    const recentHistory = (history || []).slice(-10)
      .map(m => `${m.role === 'user' ? 'Admin' : 'Ramiro'}: ${String(m.text || '').slice(0, 300)}`)
      .join('\n');

    // Prompt completo para callGemini (función probada)
    const fullPrompt = `${systemPrompt}

CONVERSACIÓN ACTUAL:
${recentHistory ? recentHistory + '\n' : ''}Admin: ${message}`;

    let rawText;
    try {
      rawText = await callGemini(fullPrompt);
    } catch(geminiErr) {
      console.error('[Ramiro] Error Gemini:', geminiErr.message);
      return res.status(500).json({ error: geminiErr.message, message: 'Error al llamar a la IA.' });
    }

    rawText = cleanGeminiJson(rawText);

    let response;
    try { response = JSON.parse(rawText); }
    catch(e) { response = { message: rawText || 'No pude responder.', action: null, data: null }; }

    // Ejecutar acción si viene
    let actionResult = null;
    const ALLOWED_UPDATE_FIELDS = ['price', 'active', 'description', 'variants', 'color_variants', 'stock', 'specs', 'badge', 'image_url'];

    if (response.action === 'PRODUCT_UPDATE' && response.data?.productId) {
      try {
        const targetProd = allProducts.find(p => p.id === response.data.productId);
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
          if (key === 'color_variants' && !Array.isArray(val)) val = [];
          if (key === 'specs' && typeof val !== 'object') val = {};
          cleanUpdates[key] = val;
        }

        if (Object.keys(cleanUpdates).length === 0) throw new Error('No hay cambios válidos para aplicar');

        await db.collection('products').doc(response.data.productId).update({ ...cleanUpdates, updatedAt: new Date() });
        const changes = Object.keys(cleanUpdates).map(k => `${k}: ${JSON.stringify(cleanUpdates[k]).slice(0, 30)}`).join(' | ');
        actionResult = { ok: true, type: 'update', productId: response.data.productId, changes };
      } catch(e) { actionResult = { ok: false, error: e.message }; }
    }

    else if (response.action === 'PRODUCT_DELETE' && response.data?.productId) {
      try {
        const targetProd = allProducts.find(p => p.id === response.data.productId);
        if (!targetProd) throw new Error(`Producto no encontrado: ${response.data.productId}`);
        
        await db.collection('products').doc(response.data.productId).delete();
        actionResult = { ok: true, type: 'delete', productId: response.data.productId, name: targetProd.name };
      } catch(e) { actionResult = { ok: false, error: e.message }; }
    }

    else if (response.action === 'BULK_ACTION' && response.data?.confirm) {
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
        if (existing) throw new Error(`Producto ya existe con slug: ${slug} (${existing.name})`);

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
      } catch(e) { actionResult = { ok: false, error: e.message }; }
    }

    else if (response.action === 'SYNC_FROM_URL' && response.data?.url) {
      try {
        const url = cleanText(response.data.url, 2000);
        const text = await fetchExternalUrlText(url);
        const existingBySlug = new Map(allProducts.map(p => [p.slug, p]));

        const syncPrompt = `Extrae productos de este texto de catálogo y devuelve SOLO JSON válido.
Formato estricto:
{
  "products": [
    {
      "name": "Nombre",
      "category": "mac|iphone|ipad|airpods",
      "price": 0,
      "description": "texto corto",
      "variants": [{"label":"...","price":0}],
      "specs": {"clave":"valor"}
    }
  ]
}
Reglas:
- No inventes campos si no aparecen.
- price siempre número.
- category solo mac|iphone|ipad|airpods.
- Si no detectas un dato, omítelo.

TEXTO FUENTE:\n${text}`;

        const syncRaw = await callGemini(syncPrompt);
        let parsedSync;
        try {
          parsedSync = JSON.parse(cleanGeminiJson(syncRaw));
        } catch {
          throw new Error('No se pudo interpretar JSON de sincronización');
        }

        const productsToSync = Array.isArray(parsedSync.products) ? parsedSync.products : [];
        let created = 0;
        let updated = 0;

        for (const p of productsToSync) {
          const name = cleanText(p.name, 160);
          if (!name) continue;
          const slug = slugify(name);
          const category = ['mac', 'iphone', 'ipad', 'airpods'].includes(String(p.category || '').toLowerCase())
            ? String(p.category).toLowerCase()
            : 'mac';
          const price = Number(p.price);
          const payload = {
            name,
            slug,
            category,
            description: cleanText(p.description || `${name} disponible en MacStore.`, 2000),
            price: Number.isFinite(price) && price > 0 ? price : 1,
            variants: Array.isArray(p.variants) ? p.variants : [],
            specs: p.specs && typeof p.specs === 'object' ? p.specs : {},
            ficha: {
              modelo: name,
              marca: 'Apple',
              capacidad: 'Consultar disponibilidad',
              colores: 'Consultar disponibilidad',
              garantia: 'Consultar garantía',
              notas: `Sincronizado desde URL: ${url}`
            },
            active: true,
            updatedAt: new Date()
          };

          const existing = existingBySlug.get(slug);
          if (existing) {
            await db.collection('products').doc(existing.id).update(payload);
            updated += 1;
          } else {
            await db.collection('products').add({ ...payload, createdAt: new Date(), stock: 0, sort_order: 0 });
            created += 1;
          }
        }

        actionResult = { ok: true, type: 'sync', created, updated, source: url, total: productsToSync.length };
      } catch(e) {
        actionResult = { ok: false, error: e.message };
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
      finalMessage += `\n\n⚠️ Error: ${actionResult.error}`;
    }

    await appendRamiroTranscript(db, {
      role: 'assistant',
      text: finalMessage,
      action: response.action || null,
      actionResult: actionResult || null,
      adminEmail: req.admin?.email || ''
    });

    res.json({ message: finalMessage, action: response.action, data: response.data, actionResult });

  } catch(e) { res.status(500).json({ error: e.message, message: 'Error interno de Ramiro.' }); }
});

// Ruta de configuración de Ramiro en el admin
