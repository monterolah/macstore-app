/* MacStore — Sistema de Cotización v6 */
/* Precios incluyen IVA 13% */

let _qItems      = [];
let _qSettings   = {};
let _qProducts   = [];
let _qPayMethods = [];
let _qSellers    = [];
let _qClients    = [];
let _ivaMode     = 'con';

// ── CÁLCULOS ──────────────────────────────────────────────────────────────
function calcItem(item) {
  const price = parseFloat(item.price) || 0;
  const qty   = parseInt(item.qty) || 1;
  const disc  = parseFloat(item.discount) || 0;
  const gross = price * qty;
  const discAmt = gross * (disc / 100);
  const net   = gross - discAmt;

  if (_ivaMode === 'exento') {
    return { unitShow: price / 1.13, subtotal: net / 1.13, ivaAmt: 0, discAmt };
  } else if (_ivaMode === 'desglosado') {
    const sinIVA = net / 1.13;
    return { unitShow: price / 1.13, subtotal: sinIVA, ivaAmt: net - sinIVA, discAmt };
  }

  return { unitShow: price, subtotal: net, ivaAmt: 0, discAmt };
}

function calcGrand() {
  let sub = 0, iva = 0;
  _qItems.forEach(i => {
    const c = calcItem(i);
    sub += c.subtotal;
    iva += c.ivaAmt;
  });
  const total = sub + iva;
  return {
    sub,
    iva,
    total,
    c6: (total / 6).toFixed(2),
    c10: (total / 10).toFixed(2)
  };
}

// ── ABRIR MODAL ───────────────────────────────────────────────────────────
async function openQuotationModal(initial) {
  _qSettings = window.SETTINGS_DATA || {};
  _ivaMode   = 'con';
  _qItems    = [];

  if (!_qProducts.length) {
    try {
      const r = await fetch('/api/products');
      _qProducts = await r.json();
    } catch {
      _qProducts = [];
    }
  }

  if (!_qPayMethods.length) {
    try {
      const r = await fetch('/api/payment-methods');
      _qPayMethods = await r.json();
    } catch {
      _qPayMethods = [];
    }
  }

  try {
    const r = await fetch('/api/sellers');
    const data = await r.json();
    _qSellers = Array.isArray(data) ? data : [];
  } catch {
    _qSellers = [];
  }

  try {
    const r = await fetch('/api/clients-public');
    const data = await r.json();
    _qClients = Array.isArray(data) ? data : [];
  } catch {
    _qClients = [];
  }

  if (initial) {
    _qItems.push({
      id: Date.now(),
      name: initial.name,
      price: parseFloat(window._selectedPrice || initial.price),
      variant: window._selectedVariant || '',
      image_url: initial.image_url || '',
      specs: initial.specs || {},
      ficha: initial.ficha || {},
      selectedColors: [],
      qty: 1,
      discount: 0
    });
  }

  document.getElementById('quotModal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'quotModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto;backdrop-filter:blur(8px)';

  const sellerOptions = _qSellers.length
    ? `<option value="">— Seleccionar —</option>${_qSellers.map(s => `<option value="${s}">${s}</option>`).join('')}<option value="__custom__">Otro...</option>`
    : `<option value="">Sin vendedores en admin</option>`;

  modal.innerHTML = `
  <div style="background:#f2f2f7;border-radius:22px;width:100%;max-width:720px;margin:auto;box-shadow:0 32px 100px rgba(0,0,0,.4)">
    <div style="background:#fff;border-radius:22px 22px 0 0;padding:16px 22px;border-bottom:1px solid #e8e8ed;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10">
      <div>
        <div style="font-size:17px;font-weight:700;letter-spacing:-.04em">Nueva cotización</div>
        <div style="font-size:11px;color:#86868b;margin-top:1px">Precios incluyen IVA (13%)</div>
      </div>
      <button id="qX" style="width:30px;height:30px;border-radius:50%;border:1.5px solid #d2d2d7;background:#f5f5f7;cursor:pointer;font-size:17px;color:#515154">×</button>
    </div>
    <div style="padding:12px 14px;display:flex;flex-direction:column;gap:10px">

      <div style="background:#fff;border-radius:14px">
        <div style="padding:11px 16px;border-bottom:1px solid #f0f0f5">
          <span style="font-size:11px;font-weight:700;color:#86868b;text-transform:uppercase;letter-spacing:.05em">① Datos del cliente</span>
        </div>
        <div style="padding:14px 16px;display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div style="position:relative">
            <label style="font-size:11px;color:#86868b;display:block;margin-bottom:3px">Cliente</label>
            <div style="display:flex;gap:6px">
              <input id="q_client" placeholder="Nombre (opcional)" autocomplete="off" style="flex:1;border:1.5px solid #e8e8ed;border-radius:9px;padding:8px 10px;font-size:13px;outline:none;font-family:inherit;box-sizing:border-box" oninput="filterClientSugg(this.value,'name')" onfocus="showClientSugg(this,'name')" onblur="setTimeout(()=>hideClientSugg(),200)">
              ${_qClients.length ? `<button type="button" onclick="showAllClients()" title="Ver clientes anteriores" style="flex-shrink:0;width:34px;height:34px;border:1.5px solid #e8e8ed;border-radius:9px;background:#f5f5f7;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:14px">👤</button>` : ''}
            </div>
            <div id="q_client_sugg" style="display:none;position:absolute;top:calc(100% + 2px);left:0;right:0;background:#fff;border:1.5px solid #e8e8ed;border-radius:9px;box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:100;max-height:180px;overflow-y:auto"></div>
          </div>

          <div style="position:relative">
            <label style="font-size:11px;color:#86868b;display:block;margin-bottom:3px">Empresa</label>
            <input id="q_company" placeholder="Empresa (opcional)" autocomplete="off" style="width:100%;border:1.5px solid #e8e8ed;border-radius:9px;padding:8px 10px;font-size:13px;outline:none;font-family:inherit;box-sizing:border-box" oninput="filterClientSugg(this.value,'company')" onfocus="showClientSugg(this,'company')" onblur="setTimeout(()=>hideClientSugg(),200)">
            <div id="q_company_sugg" style="display:none;position:absolute;top:calc(100% + 2px);left:0;right:0;background:#fff;border:1.5px solid #e8e8ed;border-radius:9px;box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:100;max-height:160px;overflow-y:auto"></div>
          </div>

          <div>
            <label style="font-size:11px;color:#86868b;display:block;margin-bottom:3px">Teléfono <span style="font-weight:400;color:#aaa">(privado, no sale en PDF)</span></label>
            <input id="q_phone" placeholder="+503 0000-0000" type="tel" style="width:100%;border:1.5px solid #e8e8ed;border-radius:9px;padding:8px 10px;font-size:13px;outline:none;font-family:inherit;box-sizing:border-box">
          </div>

          <div>
            <label style="font-size:11px;color:#86868b;display:block;margin-bottom:3px">Vendedor</label>
            <select id="q_seller_sel" onchange="handleSellerChange(this)" style="width:100%;border:1.5px solid #e8e8ed;border-radius:9px;padding:8px 10px;font-size:13px;outline:none;font-family:inherit;background:#fff;box-sizing:border-box">
              ${sellerOptions}
            </select>
            <input id="q_seller" placeholder="Nombre del vendedor" style="display:none;width:100%;border:1.5px solid #e8e8ed;border-radius:9px;padding:8px 10px;font-size:13px;outline:none;font-family:inherit;box-sizing:border-box;margin-top:6px">
          </div>

          <div>
            <label style="font-size:11px;color:#86868b;display:block;margin-bottom:3px">Vigencia</label>
            <select id="q_validity" style="width:100%;border:1.5px solid #e8e8ed;border-radius:9px;padding:8px 10px;font-size:13px;outline:none;font-family:inherit;background:#fff;box-sizing:border-box">
              <option value="7">7 días</option>
              <option value="15">15 días</option>
              <option value="30">30 días</option>
              <option value="0">Sin vencimiento</option>
            </select>
          </div>

          <div style="grid-column:span 2">
            <label style="font-size:11px;color:#86868b;display:block;margin-bottom:3px">Notas / Condiciones</label>
            <textarea id="q_notes" placeholder="Condiciones de pago, tiempo de entrega, observaciones..." style="width:100%;border:1.5px solid #e8e8ed;border-radius:9px;padding:8px 10px;font-size:13px;outline:none;font-family:inherit;resize:vertical;height:48px;box-sizing:border-box"></textarea>
          </div>
        </div>
      </div>

      <div style="background:#fff;border-radius:14px">
        <div style="padding:11px 16px;border-bottom:1px solid #f0f0f5;display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:11px;font-weight:700;color:#86868b;text-transform:uppercase;letter-spacing:.05em">② Productos</span>
          <div style="display:flex;gap:6px">
            <button id="qAddManual" style="font-size:11px;color:#515154;background:#f5f5f7;border:none;border-radius:6px;padding:5px 11px;cursor:pointer;font-family:inherit;font-weight:500">+ Manual</button>
            <button id="qAddCatalog" style="font-size:11px;color:#0071e3;background:#e8f0fe;border:none;border-radius:6px;padding:5px 11px;cursor:pointer;font-family:inherit;font-weight:500">+ Del catálogo</button>
          </div>
        </div>
        <div style="padding:12px 16px"><div id="q_items"></div></div>
      </div>

      <div style="background:#fff;border-radius:14px">
        <div style="padding:11px 16px;border-bottom:1px solid #f0f0f5">
          <span style="font-size:11px;font-weight:700;color:#86868b;text-transform:uppercase;letter-spacing:.05em">③ Impuestos</span>
        </div>
        <div style="padding:12px 16px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
          <button id="btn_iva_con" onclick="setIVA('con')" style="padding:10px 6px;border-radius:10px;border:2px solid #1d1d1f;background:#1d1d1f;color:#fff;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;text-align:center;line-height:1.5">Con IVA<br><span style="font-size:10px;opacity:.55;font-weight:400">Precio normal</span></button>
          <button id="btn_iva_desglosado" onclick="setIVA('desglosado')" style="padding:10px 6px;border-radius:10px;border:1.5px solid #e8e8ed;background:#fff;color:#1d1d1f;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;text-align:center;line-height:1.5">IVA desglosado<br><span style="font-size:10px;color:#86868b;font-weight:400">Subtotal + 13%</span></button>
          <button id="btn_iva_exento" onclick="setIVA('exento')" style="padding:10px 6px;border-radius:10px;border:1.5px solid #e8e8ed;background:#fff;color:#1d1d1f;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;text-align:center;line-height:1.5">Exento de IVA<br><span style="font-size:10px;color:#86868b;font-weight:400">Se resta 13%</span></button>
        </div>
      </div>

      <div style="background:#fff;border-radius:14px">
        <div style="padding:11px 16px;border-bottom:1px solid #f0f0f5">
          <span style="font-size:11px;font-weight:700;color:#86868b;text-transform:uppercase;letter-spacing:.05em">④ Opciones del PDF</span>
        </div>

        <div style="padding:12px 16px;border-bottom:1px solid #f0f0f5;display:flex;align-items:center;justify-content:space-between">
          <div><div style="font-size:13px;font-weight:500">Especificaciones técnicas</div><div style="font-size:11px;color:#86868b">Tabla corta (Chip, Pantalla...)</div></div>
          <label style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer;flex-shrink:0"><input type="checkbox" id="sw_specs" style="opacity:0;width:0;height:0"><span id="sw_specs_bg" style="position:absolute;inset:0;background:#d2d2d7;border-radius:24px;transition:.3s"></span><span id="sw_specs_dot" style="position:absolute;top:2px;left:2px;width:20px;height:20px;background:#fff;border-radius:50%;transition:.3s;box-shadow:0 1px 4px rgba(0,0,0,.2)"></span></label>
        </div>

        <div style="padding:12px 16px;border-bottom:1px solid #f0f0f5;display:flex;align-items:center;justify-content:space-between">
          <div><div style="font-size:13px;font-weight:500">Ficha técnica completa</div><div style="font-size:11px;color:#86868b">Tabla detallada guardada en el producto</div></div>
          <label style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer;flex-shrink:0"><input type="checkbox" id="sw_ficha" style="opacity:0;width:0;height:0"><span id="sw_ficha_bg" style="position:absolute;inset:0;background:#d2d2d7;border-radius:24px;transition:.3s"></span><span id="sw_ficha_dot" style="position:absolute;top:2px;left:2px;width:20px;height:20px;background:#fff;border-radius:50%;transition:.3s;box-shadow:0 1px 4px rgba(0,0,0,.2)"></span></label>
        </div>

        <div style="padding:12px 16px;border-bottom:1px solid #f0f0f5">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <div><div style="font-size:13px;font-weight:500">Cuotas sin intereses</div><div style="font-size:11px;color:#86868b">Opciones de financiamiento</div></div>
            <label style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer;flex-shrink:0"><input type="checkbox" id="sw_cuotas" style="opacity:0;width:0;height:0"><span id="sw_cuotas_bg" style="position:absolute;inset:0;background:#d2d2d7;border-radius:24px;transition:.3s"></span><span id="sw_cuotas_dot" style="position:absolute;top:2px;left:2px;width:20px;height:20px;background:#fff;border-radius:50%;transition:.3s;box-shadow:0 1px 4px rgba(0,0,0,.2)"></span></label>
          </div>
          <div id="cuotasSection" style="display:none;margin-top:10px">
            <div style="display:grid;grid-template-columns:1fr 58px 1fr 58px;gap:8px">
              <div><label style="font-size:10px;color:#86868b;display:block;margin-bottom:2px">Texto cuota 1</label><input id="q_cuota1_label" value="6 cuotas sin intereses" style="width:100%;border:1.5px solid #e8e8ed;border-radius:7px;padding:6px 8px;font-size:12px;outline:none;font-family:inherit;box-sizing:border-box"></div>
              <div><label style="font-size:10px;color:#86868b;display:block;margin-bottom:2px">N°</label><input id="q_cuota1_div" type="number" value="6" min="1" oninput="renderTotals()" style="width:100%;border:1.5px solid #e8e8ed;border-radius:7px;padding:6px 5px;font-size:12px;outline:none;font-family:inherit;text-align:center;box-sizing:border-box"></div>
              <div><label style="font-size:10px;color:#86868b;display:block;margin-bottom:2px">Texto cuota 2</label><input id="q_cuota2_label" value="10 cuotas sin intereses" style="width:100%;border:1.5px solid #e8e8ed;border-radius:7px;padding:6px 8px;font-size:12px;outline:none;font-family:inherit;box-sizing:border-box"></div>
              <div><label style="font-size:10px;color:#86868b;display:block;margin-bottom:2px">N°</label><input id="q_cuota2_div" type="number" value="10" min="1" oninput="renderTotals()" style="width:100%;border:1.5px solid #e8e8ed;border-radius:7px;padding:6px 5px;font-size:12px;outline:none;font-family:inherit;text-align:center;box-sizing:border-box"></div>
            </div>
          </div>
        </div>

        <div style="padding:12px 16px;border-bottom:1px solid #f0f0f5">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <div><div style="font-size:13px;font-weight:500">Métodos de pago</div><div style="font-size:11px;color:#86868b">Logos de bancos y tarjetas</div></div>
            <label style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer;flex-shrink:0"><input type="checkbox" id="sw_payments" style="opacity:0;width:0;height:0"><span id="sw_payments_bg" style="position:absolute;inset:0;background:#d2d2d7;border-radius:24px;transition:.3s"></span><span id="sw_payments_dot" style="position:absolute;top:2px;left:2px;width:20px;height:20px;background:#fff;border-radius:50%;transition:.3s;box-shadow:0 1px 4px rgba(0,0,0,.2)"></span></label>
          </div>
          <div id="paymentsSection" style="display:none;margin-top:10px">
            <div id="q_pay_methods" style="display:grid;grid-template-columns:1fr 1fr;gap:7px"></div>
          </div>
        </div>

        <div style="padding:12px 16px">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <div><div style="font-size:13px;font-weight:500">Nota al pie</div><div style="font-size:11px;color:#86868b">Texto editable al final del PDF</div></div>
            <label style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer;flex-shrink:0"><input type="checkbox" id="sw_footnotes" style="opacity:0;width:0;height:0"><span id="sw_footnotes_bg" style="position:absolute;inset:0;background:#d2d2d7;border-radius:24px;transition:.3s"></span><span id="sw_footnotes_dot" style="position:absolute;top:2px;left:2px;width:20px;height:20px;background:#fff;border-radius:50%;transition:.3s;box-shadow:0 1px 4px rgba(0,0,0,.2)"></span></label>
          </div>
          <div id="footnotesSection" style="display:none;margin-top:10px">
            <textarea id="q_footnotes" style="width:100%;border:1.5px solid #e8e8ed;border-radius:9px;padding:8px 10px;font-size:12px;outline:none;font-family:inherit;resize:vertical;height:64px;box-sizing:border-box" placeholder="Texto al pie de la cotización">Precios en dólares americanos (USD) · Cuotas disponibles con tarjetas participantes · Válida por 7 días a partir de la fecha de emisión</textarea>
          </div>
        </div>
      </div>

      <div id="q_totals"></div>

      <div style="display:flex;gap:10px;padding-bottom:4px">
        <button id="qGen" style="flex:1;background:#1d1d1f;color:#fff;border:none;padding:14px;border-radius:14px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Descargar PDF
        </button>
        <button id="qCancel" style="padding:14px 20px;border-radius:14px;border:1.5px solid #d2d2d7;background:#fff;font-size:15px;cursor:pointer;font-family:inherit;color:#515154">Cancelar</button>
      </div>
    </div>
  </div>`;

  document.body.appendChild(modal);
  modal.querySelector('#qX').onclick      = () => modal.remove();
  modal.querySelector('#qCancel').onclick = () => modal.remove();
  modal.querySelector('#qGen').onclick    = generatePDF;
  modal.querySelector('#qAddCatalog').onclick = addFromCatalog;
  modal.querySelector('#qAddManual').onclick  = addManual;
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  ['sw_specs','sw_ficha','sw_cuotas','sw_payments','sw_footnotes'].forEach(id => {
    const cb = document.getElementById(id);
    if (!cb) return;

    cb.addEventListener('change', function () {
      updateSwitchUI(id, this.checked);
      if (id === 'sw_cuotas') {
        document.getElementById('cuotasSection').style.display = this.checked ? 'block' : 'none';
        renderTotals();
      }
      if (id === 'sw_payments') {
        document.getElementById('paymentsSection').style.display = this.checked ? 'block' : 'none';
      }
      if (id === 'sw_footnotes') {
        document.getElementById('footnotesSection').style.display = this.checked ? 'block' : 'none';
      }
    });

    updateSwitchUI(id, false);
  });

  renderItems();
  renderPayMethods();
  modal.querySelector('#q_client').focus();
}

// ── SWITCHES ──────────────────────────────────────────────────────────────
function initSwitch(id) {
  const cb = document.getElementById(id);
  if (!cb) return;

  cb.addEventListener('change', function () {
    updateSwitchUI(id, this.checked);
  });

  updateSwitchUI(id, cb.checked);
}

function updateSwitchUI(id, on) {
  const bg  = document.getElementById(id + '_bg');
  const dot = document.getElementById(id + '_dot');
  if (bg) bg.style.background = on ? '#1d1d1f' : '#d2d2d7';
  if (dot) dot.style.left = on ? '22px' : '2px';
}

function toggleSwSection(sectionId, on) {
  const s = document.getElementById(sectionId);
  if (s) s.style.display = on ? 'block' : 'none';
  const id = sectionId === 'cuotasSection' ? 'sw_cuotas' : sectionId === 'paymentsSection' ? 'sw_payments' : null;
  if (id) updateSwitchUI(id, on);
  renderTotals();
}

function swOn(id) {
  const el = document.getElementById(id);
  return el ? el.checked : false;
}

// ── VENDEDOR ──────────────────────────────────────────────────────────────
function handleSellerChange(sel) {
  const custom = document.getElementById('q_seller');
  if (sel.value === '__custom__') {
    custom.style.display = 'block';
    custom.focus();
    sel.value = '';
  } else {
    custom.style.display = 'none';
    custom.value = '';
  }
}

function getSellerValue() {
  const sel = document.getElementById('q_seller_sel');
  const custom = document.getElementById('q_seller');
  if (custom && custom.style.display !== 'none' && custom.value.trim()) return custom.value.trim();
  return sel ? sel.value : '';
}

// ── AUTOCOMPLETAR CLIENTES ────────────────────────────────────────────────
function showClientSugg(input, field) {
  filterClientSugg(input.value, field);
}

function hideClientSugg() {
  document.querySelectorAll('#q_client_sugg,#q_company_sugg').forEach(el => el.style.display = 'none');
}

function filterClientSugg(val, field) {
  const suggId = field === 'name' ? 'q_client_sugg' : 'q_company_sugg';
  const sugg = document.getElementById(suggId);
  if (!sugg) return;

  const q = (val || '').toLowerCase().trim();
  const matches = _qClients.filter(c => {
    const v = field === 'name' ? c.client : c.company;
    return v && v.toLowerCase().includes(q);
  }).slice(0, 8);

  if (!matches.length) {
    sugg.style.display = 'none';
    return;
  }

  sugg.style.display = 'block';
  sugg.innerHTML = matches.map(c => `
    <div class="qcsugg-item" style="padding:9px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #f5f5f7;transition:background .1s"
      onmouseover="this.style.background='#f5f5f7'" onmouseout="this.style.background=''"
      onclick="selectClient(${JSON.stringify(c).replace(/"/g,'&quot;')})">
      <div style="font-weight:500">${field === 'name' ? c.client : c.company}</div>
      ${c.company && field === 'name' ? `<div style="font-size:11px;color:#86868b">${c.company}</div>` : ''}
      ${c.client && field === 'company' ? `<div style="font-size:11px;color:#86868b">${c.client}</div>` : ''}
    </div>`).join('');
}

function selectClient(c) {
  const cl = document.getElementById('q_client');
  const co = document.getElementById('q_company');
  const ph = document.getElementById('q_phone');
  if (cl && c.client) cl.value = c.client;
  if (co && c.company) co.value = c.company;
  if (ph && c.phone) ph.value = c.phone;
  hideClientSugg();
}

function showAllClients() {
  const sugg = document.getElementById('q_client_sugg');
  if (!sugg) return;

  sugg.style.display = 'block';
  sugg.innerHTML = _qClients.length ? _qClients.map(c => `
    <div class="qcsugg-item" style="padding:9px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #f5f5f7;transition:background .1s"
      onmouseover="this.style.background='#f5f5f7'" onmouseout="this.style.background=''"
      onclick="selectClient(${JSON.stringify(c).replace(/"/g,'&quot;')})">
      <div style="font-weight:500">${c.client || '—'}</div>
      <div style="font-size:11px;color:#86868b">${[c.company, c.phone].filter(Boolean).join(' · ')}</div>
    </div>`).join('')
    : '<div style="padding:12px;font-size:12px;color:#86868b;text-align:center">Sin clientes anteriores</div>';
}

function renderPayMethods() {
  const c = document.getElementById('q_pay_methods');
  if (!c) return;

  if (!_qPayMethods.length) {
    c.innerHTML = '<div style="font-size:12px;color:#86868b;font-style:italic">No hay métodos de pago configurados. Ve a Admin → Métodos de pago para agregarlos.</div>';
    return;
  }

  c.innerHTML = _qPayMethods.map(m => `
    <label style="display:flex;align-items:center;gap:8px;background:#f5f5f7;border-radius:10px;padding:8px 12px;cursor:pointer;transition:background .15s;border:1.5px solid transparent" onmouseover="this.style.borderColor='#d2d2d7'" onmouseout="this.style.borderColor='transparent'">
      <input type="checkbox" data-pm-id="${m.id}" checked style="width:15px;height:15px;accent-color:#1d1d1f;cursor:pointer">
      ${m.logo_url ? `<img src="${m.logo_url}" style="height:24px;max-width:60px;object-fit:contain" onerror="this.style.display='none'">` : ''}
      <div>
        <div style="font-size:12px;font-weight:600">${m.name}</div>
        ${m.description ? `<div style="font-size:10px;color:#86868b">${m.description}</div>` : ''}
      </div>
    </label>`).join('');
}

function getSelectedPayMethods() {
  return _qPayMethods.filter(m => {
    const cb = document.querySelector(`input[data-pm-id="${m.id}"]`);
    return cb && cb.checked;
  });
}

// ── IVA MODE ──────────────────────────────────────────────────────────────
function setIVA(mode) {
  _ivaMode = mode;
  const notes = {
    con: 'Los precios ya incluyen IVA — se muestra el total sin cambios',
    desglosado: 'Se mostrará subtotal sin IVA + IVA (13%) por separado',
    exento: 'Se restará el IVA incluido: precio ÷ 1.13 — para clientes exentos'
  };

  ['con','desglosado','exento'].forEach(m => {
    const b = document.getElementById('btn_iva_' + m);
    if (!b) return;
    const on = m === mode;
    b.style.background = on ? '#1d1d1f' : '#fff';
    b.style.color = on ? '#fff' : '#1d1d1f';
    b.style.border = on ? '2px solid #1d1d1f' : '1.5px solid #e8e8ed';
    const sp = b.querySelector('span');
    if (sp) sp.style.color = on ? 'rgba(255,255,255,.55)' : '#86868b';
  });

  const n = document.getElementById('q_iva_note');
  if (n) n.textContent = notes[mode];
  renderItems();
}

// ── RENDER ITEMS ──────────────────────────────────────────────────────────
function renderItems() {
  const c = document.getElementById('q_items');
  if (!c) return;

  if (!_qItems.length) {
    c.innerHTML = '<div style="text-align:center;color:#86868b;font-size:13px;padding:20px;background:#f5f5f7;border-radius:10px">Sin productos — agrega del catálogo o manualmente</div>';
    renderTotals();
    return;
  }

  c.innerHTML = _qItems.map((item, i) => {
    const calc = calcItem(item);
    const showPrice = calc.unitShow.toFixed(2);
    const showTotal = (calc.subtotal + calc.ivaAmt).toFixed(2);
    const colors = (item.selectedColors || []).filter(Boolean);

    return `
    <div style="border:1.5px solid #e8e8ed;border-radius:12px;margin-bottom:8px;background:#fff">
      <div style="display:grid;grid-template-columns:52px 1fr auto;gap:10px;padding:11px 13px;align-items:start">
        <img src="${item.image_url || ''}" style="width:52px;height:52px;object-fit:contain;border-radius:8px;background:#f5f5f7" onerror="this.style.opacity='.15'">
        <div>
          <div style="font-size:14px;font-weight:600;margin-bottom:5px">${item.name}${item.variant ? ` <span style="font-weight:400;color:#86868b;font-size:12px">— ${item.variant}</span>` : ''}</div>
          <div style="display:flex;flex-wrap:wrap;gap:7px;align-items:center">
            <div style="display:flex;align-items:center;gap:3px">
              <span style="font-size:12px;color:#86868b">$</span>
              <input type="number" step="0.01" value="${showPrice}" onchange="updatePrice(${i},this.value)"
                style="width:78px;border:1.5px solid #e8e8ed;border-radius:7px;padding:4px 6px;font-size:13px;font-weight:600;outline:none;font-family:inherit" onfocus="this.style.borderColor='#1d1d1f'" onblur="this.style.borderColor='#e8e8ed'">
              <span style="font-size:10px;color:#86868b">${_ivaMode === 'exento' ? 's/IVA' : 'c/IVA'}</span>
            </div>
            <div style="display:flex;align-items:center;gap:5px;border:1.5px solid #e8e8ed;border-radius:7px;padding:3px 8px">
              <button onclick="chQty(${i},-1)" style="background:none;border:none;cursor:pointer;font-size:17px;color:#515154;padding:0;font-family:inherit;line-height:1">−</button>
              <span style="font-size:13px;font-weight:600;min-width:18px;text-align:center">${item.qty}</span>
              <button onclick="chQty(${i},1)" style="background:none;border:none;cursor:pointer;font-size:17px;color:#515154;padding:0;font-family:inherit;line-height:1">+</button>
            </div>
            <div style="display:flex;align-items:center;gap:3px">
              <input type="number" min="0" max="100" value="${item.discount || 0}" onchange="_qItems[${i}].discount=parseFloat(this.value)||0;renderItems()"
                style="width:40px;border:1.5px solid #e8e8ed;border-radius:7px;padding:4px 5px;font-size:12px;outline:none;font-family:inherit;text-align:center" onfocus="this.style.borderColor='#1d1d1f'" onblur="this.style.borderColor='#e8e8ed'">
              <span style="font-size:11px;color:#86868b">%</span>
            </div>
          </div>
          ${colors.length ? `<div style="display:flex;gap:5px;margin-top:6px;flex-wrap:wrap">
            ${colors.map(col => `<span style="font-size:10px;background:#f0f0f5;padding:2px 8px;border-radius:20px;color:#515154">${col}</span>`).join('')}
          </div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">
          <button onclick="_qItems.splice(${i},1);renderItems()" style="color:#c0392b;background:none;border:none;cursor:pointer;font-size:18px;line-height:1">×</button>
          <div style="font-size:14px;font-weight:700">$${showTotal}</div>
          ${item.discount > 0 ? `<div style="font-size:10px;color:#1a7f37">−${item.discount}%</div>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  renderTotals();
}

function updatePrice(i, val) {
  const p = parseFloat(val) || 0;
  _qItems[i].price = _ivaMode === 'exento' ? p * 1.13 : p;
  renderItems();
}

function chQty(i, d) {
  _qItems[i].qty = Math.max(1, (_qItems[i].qty || 1) + d);
  renderItems();
}

// ── TOTALES ───────────────────────────────────────────────────────────────
function renderTotals() {
  const el = document.getElementById('q_totals');
  if (!el) return;
  if (!_qItems.length) {
    el.innerHTML = '';
    return;
  }

  const { sub, iva, total } = calcGrand();
  const showCuotas = swOn('sw_cuotas');
  const div1 = parseInt(document.getElementById('q_cuota1_div')?.value) || 6;
  const div2 = parseInt(document.getElementById('q_cuota2_div')?.value) || 10;
  const lbl1 = document.getElementById('q_cuota1_label')?.value || '6 cuotas';
  const lbl2 = document.getElementById('q_cuota2_label')?.value || '10 cuotas';

  el.innerHTML = `<div style="background:#1d1d1f;border-radius:14px;padding:16px 18px;color:#fff">
    <div style="display:flex;flex-direction:column;gap:5px;margin-bottom:${showCuotas ? '14px' : '0'}">
      ${_ivaMode !== 'con' ? `<div style="display:flex;justify-content:space-between;font-size:13px;opacity:.7"><span>Subtotal sin IVA</span><span>$${sub.toFixed(2)}</span></div>` : ''}
      ${_ivaMode === 'desglosado' ? `<div style="display:flex;justify-content:space-between;font-size:13px;opacity:.7"><span>IVA (13%)</span><span>$${iva.toFixed(2)}</span></div>` : ''}
      ${_ivaMode === 'exento' ? `<div style="display:flex;justify-content:space-between;font-size:13px;opacity:.5"><span>IVA</span><span style="background:rgba(26,127,55,.3);padding:1px 8px;border-radius:10px;font-size:10px;font-weight:600">EXENTO</span></div>` : ''}
      <div style="display:flex;justify-content:space-between;font-size:20px;font-weight:700;border-top:1px solid rgba(255,255,255,.15);padding-top:10px;margin-top:4px">
        <span>Total</span><span>$${total.toFixed(2)}</span>
      </div>
    </div>
    ${showCuotas ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div style="background:rgba(255,255,255,.1);border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:10px;opacity:.6;margin-bottom:3px">${lbl1}</div>
        <div style="font-size:18px;font-weight:700">$${(total / div1).toFixed(2)}</div>
        <div style="font-size:10px;opacity:.5;margin-top:2px">por mes</div>
      </div>
      <div style="background:rgba(255,255,255,.1);border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:10px;opacity:.6;margin-bottom:3px">${lbl2}</div>
        <div style="font-size:18px;font-weight:700">$${(total / div2).toFixed(2)}</div>
        <div style="font-size:10px;opacity:.5;margin-top:2px">por mes</div>
      </div>
    </div>` : ''}
  </div>`;
}

// ── AGREGAR DEL CATÁLOGO ──────────────────────────────────────────────────
function addFromCatalog() {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10001;display:flex;align-items:center;justify-content:center;padding:20px';

  ov.innerHTML = `
    <div style="background:#fff;border-radius:18px;width:100%;max-width:520px;max-height:80vh;overflow:hidden;display:flex;flex-direction:column">
      <div style="padding:16px 18px;border-bottom:1px solid #e8e8ed;display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
        <span style="font-weight:700;font-size:15px">Seleccionar del catálogo</span>
        <button id="ovX" style="background:none;border:none;cursor:pointer;font-size:20px;color:#86868b">×</button>
      </div>
      <input id="qSearch" placeholder="Buscar producto..." style="margin:10px 14px;border:1.5px solid #e8e8ed;border-radius:9px;padding:8px 12px;font-size:13px;outline:none;font-family:inherit;flex-shrink:0">
      <div id="qPList" style="overflow-y:auto;padding:0 10px 10px;flex:1"></div>
    </div>`;

  document.body.appendChild(ov);
  ov.querySelector('#ovX').onclick = () => ov.remove();
  ov.addEventListener('click', e => {
    if (e.target === ov) ov.remove();
  });

  const list = ov.querySelector('#qPList');

  const selectProduct = (p) => {
    const hasColors   = p.color_variants && p.color_variants.length > 0;
    const hasVariants = p.variants && p.variants.length > 0;

    if (!hasColors && !hasVariants) {
      _qItems.push({
        id: Date.now(),
        name: p.name,
        price: parseFloat(p.price),
        variant: '',
        color: '',
        image_url: p.image_url || '',
        specs: p.specs || {},
        ficha: p.ficha || {},
        qty: 1,
        discount: 0,
        selectedColors: []
      });
      renderItems();
      ov.remove();
      return;
    }

    list.innerHTML = `
      <div style="padding:10px 4px">
        <button onclick="renderProductList()" style="font-size:12px;color:#0071e3;background:none;border:none;cursor:pointer;font-family:inherit;margin-bottom:12px">← Volver al catálogo</button>
        <div style="display:flex;gap:12px;align-items:center;padding:10px;background:#f5f5f7;border-radius:10px;margin-bottom:14px">
          <img src="${p.image_url || ''}" style="width:48px;height:48px;object-fit:contain;border-radius:8px;background:#fff" onerror="this.style.opacity='.2'">
          <div><div style="font-weight:600;font-size:14px">${p.name}</div><div style="font-size:12px;color:#86868b">$${parseFloat(p.price).toFixed(2)}</div></div>
        </div>

        ${hasColors ? `
        <div style="margin-bottom:14px">
          <div style="font-size:11px;font-weight:600;color:#86868b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">Colores (selecciona los que aplican)</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px" id="colorPicker">
            ${p.color_variants.map(c => {
              const sw = c.swatch_url || c.image_url || '';
              return `<label style="display:flex;align-items:center;gap:6px;padding:6px 12px;border:1.5px solid #e8e8ed;border-radius:9px;cursor:pointer;font-size:13px">
                <input type="checkbox" name="qColor" value="${c.name || ''}" data-img="${c.image_url || p.image_url || ''}" style="width:14px;height:14px;accent-color:#1d1d1f;cursor:pointer">
                ${sw ? `<img src="${sw}" style="width:20px;height:20px;border-radius:50%;object-fit:cover">` : ''}
                ${c.name || ''}
              </label>`;
            }).join('')}
          </div>
        </div>` : ''}

        ${hasVariants ? `
        <div style="margin-bottom:14px">
          <div style="font-size:11px;font-weight:600;color:#86868b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">Almacenamiento</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            <label style="display:flex;align-items:center;gap:6px;padding:7px 14px;border:1.5px solid #e8e8ed;border-radius:9px;cursor:pointer;font-size:13px">
              <input type="radio" name="qVariant" value="" data-price="${p.price}" checked style="accent-color:#1d1d1f"> Sin especificar
            </label>
            ${p.variants.map(v => `
            <label style="display:flex;align-items:center;gap:6px;padding:7px 14px;border:1.5px solid #e8e8ed;border-radius:9px;cursor:pointer;font-size:13px">
              <input type="radio" name="qVariant" value="${v.label || ''}" data-price="${v.price || p.price}" style="accent-color:#1d1d1f">
              <span>${v.label}</span>
              ${v.price ? `<span style="color:#86868b;font-size:11px">$${parseFloat(v.price).toFixed(2)}</span>` : ''}
            </label>`).join('')}
          </div>
        </div>` : ''}

        <button id="addToQuot" style="width:100%;background:#1d1d1f;color:#fff;border:none;padding:12px;border-radius:10px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;margin-top:4px">
          Agregar a cotización
        </button>
      </div>`;

    document.getElementById('addToQuot').onclick = () => {
      const checkedColors = [...list.querySelectorAll('input[name="qColor"]:checked')]
        .map(r => r.value)
        .filter(Boolean);

      const variantRadio = list.querySelector('input[name="qVariant"]:checked');
      const firstColorImg = list.querySelector('input[name="qColor"]:checked')?.dataset.img || p.image_url || '';
      const variantName = variantRadio?.value || '';
      const price = parseFloat(variantRadio?.dataset.price || p.price);
      const variantLabel = variantName || '';

      _qItems.push({
        id: Date.now(),
        name: p.name,
        price,
        variant: variantLabel,
        selectedColors: checkedColors,
        image_url: firstColorImg,
        specs: p.specs || {},
        ficha: p.ficha || {},
        qty: 1,
        discount: 0
      });

      renderItems();
      ov.remove();
    };
  };

  const renderProductList = (q = '') => {
    const items = _qProducts.filter(p => !q || p.name.toLowerCase().includes(q.toLowerCase()));

    list.innerHTML = items.length ? items.map(p => {
      const hasC = p.color_variants && p.color_variants.length > 0;
      const hasV = p.variants && p.variants.length > 0;
      return `
      <div data-id="${p.id}" style="display:flex;align-items:center;gap:12px;padding:10px;border-radius:10px;cursor:pointer;transition:background .15s" onmouseover="this.style.background='#f5f5f7'" onmouseout="this.style.background=''">
        <img src="${p.image_url || ''}" style="width:44px;height:44px;object-fit:contain;border-radius:8px;background:#f5f5f7;flex-shrink:0" onerror="this.style.opacity='.2'">
        <div style="flex:1">
          <div style="font-size:14px;font-weight:500">${p.name}</div>
          <div style="font-size:12px;color:#86868b">$${parseFloat(p.price).toFixed(2)}${hasC ? ` · ${p.color_variants.length} colores` : ''}${hasV ? ` · ${p.variants.length} capacidades` : ''}</div>
        </div>
        ${(hasC || hasV) ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#86868b" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>' : ''}
      </div>`;
    }).join('') : '<div style="text-align:center;color:#86868b;padding:20px;font-size:13px">Sin resultados</div>';

    list.querySelectorAll('[data-id]').forEach(row => {
      row.addEventListener('click', () => {
        const p = _qProducts.find(x => String(x.id) === row.dataset.id);
        if (p) selectProduct(p);
      });
    });
  };

  window.renderProductList = () => renderProductList(ov.querySelector('#qSearch')?.value || '');

  renderProductList();
  ov.querySelector('#qSearch').oninput = function () {
    renderProductList(this.value);
  };
}

// ── AGREGAR MANUAL ────────────────────────────────────────────────────────
function addManual() {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10001;display:flex;align-items:center;justify-content:center;padding:20px';

  ov.innerHTML = `
    <div style="background:#fff;border-radius:18px;width:100%;max-width:440px;padding:22px">
      <div style="font-size:16px;font-weight:700;margin-bottom:16px">Producto manual</div>
      <div style="display:grid;gap:10px">
        <div><label style="font-size:11px;color:#86868b;display:block;margin-bottom:3px">Nombre *</label>
          <input id="man_name" placeholder="Nombre del producto" style="width:100%;border:1.5px solid #e8e8ed;border-radius:9px;padding:8px 11px;font-size:13px;outline:none;font-family:inherit"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div><label style="font-size:11px;color:#86868b;display:block;margin-bottom:3px">Precio (con IVA) *</label>
            <input id="man_price" type="number" step="0.01" placeholder="0.00" style="width:100%;border:1.5px solid #e8e8ed;border-radius:9px;padding:8px 11px;font-size:13px;outline:none;font-family:inherit"></div>
          <div><label style="font-size:11px;color:#86868b;display:block;margin-bottom:3px">Cantidad</label>
            <input id="man_qty" type="number" value="1" min="1" style="width:100%;border:1.5px solid #e8e8ed;border-radius:9px;padding:8px 11px;font-size:13px;outline:none;font-family:inherit"></div>
        </div>
        <div><label style="font-size:11px;color:#86868b;display:block;margin-bottom:3px">Especificaciones (Clave: Valor, una por línea)</label>
          <textarea id="man_specs" placeholder="Chip: Apple M4&#10;RAM: 16 GB&#10;Almacenamiento: 512 GB" style="width:100%;border:1.5px solid #e8e8ed;border-radius:9px;padding:8px 11px;font-size:12px;outline:none;font-family:monospace;resize:none;height:80px"></textarea></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button id="manSave" style="flex:1;background:#1d1d1f;color:#fff;border:none;padding:11px;border-radius:10px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit">Agregar</button>
        <button id="manCancel" style="padding:11px 16px;border-radius:10px;border:1.5px solid #e8e8ed;background:none;font-size:14px;cursor:pointer;font-family:inherit">Cancelar</button>
      </div>
    </div>`;

  document.body.appendChild(ov);
  ov.querySelector('#manCancel').onclick = () => ov.remove();
  ov.addEventListener('click', e => {
    if (e.target === ov) ov.remove();
  });

  ov.querySelector('#manSave').onclick = () => {
    const name = ov.querySelector('#man_name').value.trim();
    const price = parseFloat(ov.querySelector('#man_price').value);
    if (!name || !price) {
      ov.querySelector('#man_name').style.borderColor = '#c0392b';
      return;
    }

    const qty = parseInt(ov.querySelector('#man_qty').value) || 1;
    const specs = {};
    ov.querySelector('#man_specs').value.split('\n').forEach(l => {
      const idx = l.indexOf(':');
      if (idx < 0) return;
      const k = l.slice(0, idx).trim();
      const v = l.slice(idx + 1).trim();
      if (k && v) specs[k] = v;
    });

    _qItems.push({
      id: Date.now(),
      name,
      price,
      variant: '',
      image_url: '',
      specs,
      qty,
      discount: 0
    });

    renderItems();
    ov.remove();
  };
}

// ── EDITAR SPECS ──────────────────────────────────────────────────────────
function editSpecs(i) {
  const item = _qItems[i];
  const current = Object.entries(item.specs || {}).map(([k, v]) => `${k}: ${v}`).join('\n');

  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10001;display:flex;align-items:center;justify-content:center;padding:20px';

  ov.innerHTML = `
    <div style="background:#fff;border-radius:18px;width:100%;max-width:420px;padding:22px">
      <div style="font-size:15px;font-weight:700;margin-bottom:4px">Especificaciones</div>
      <div style="font-size:12px;color:#86868b;margin-bottom:12px">${item.name}</div>
      <div style="font-size:11px;color:#86868b;margin-bottom:6px">Una por línea: Clave: Valor</div>
      <textarea id="specsTA" style="width:100%;height:160px;border:1.5px solid #e8e8ed;border-radius:10px;padding:10px 12px;font-size:13px;font-family:monospace;outline:none;resize:vertical;line-height:1.8" onfocus="this.style.borderColor='#1d1d1f'" onblur="this.style.borderColor='#e8e8ed'" placeholder="Chip: Apple A18 Pro&#10;Pantalla: 6.3&quot; OLED&#10;Cámara: 48 MP">${current}</textarea>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button id="specSave" style="flex:1;background:#1d1d1f;color:#fff;border:none;padding:11px;border-radius:10px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit">Guardar</button>
        <button id="specCancel" style="padding:11px 16px;border-radius:10px;border:1.5px solid #e8e8ed;background:none;font-size:14px;cursor:pointer;font-family:inherit">Cancelar</button>
      </div>
    </div>`;

  document.body.appendChild(ov);
  ov.querySelector('#specCancel').onclick = () => ov.remove();
  ov.addEventListener('click', e => {
    if (e.target === ov) ov.remove();
  });

  ov.querySelector('#specSave').onclick = () => {
    const specs = {};
    ov.querySelector('#specsTA').value.split('\n').forEach(l => {
      const idx = l.indexOf(':');
      if (idx < 0) return;
      const k = l.slice(0, idx).trim();
      const v = l.slice(idx + 1).trim();
      if (k && v) specs[k] = v;
    });

    _qItems[i].specs = specs;
    ov.remove();
    renderItems();
  };

  ov.querySelector('#specsTA').focus();
}

// ── CONVERTIR IMAGEN ──────────────────────────────────────────────────────
async function toBase64(url) {
  if (!url) return '';
  try {
    const r = await fetch(url);
    const b = await r.blob();
    return new Promise(res => {
      const rd = new FileReader();
      rd.onload = () => res(rd.result);
      rd.onerror = () => res('');
      rd.readAsDataURL(b);
    });
  } catch {
    return '';
  }
}

// ── GENERAR PDF REAL POR BACKEND ──────────────────────────────────────────
async function generatePDF() {
  const client = document.getElementById('q_client')?.value.trim() || '';

  if (!_qItems || !_qItems.length) {
    alert('Agrega al menos un producto');
    return;
  }

  const btn = document.getElementById('qGen');
  const originalBtnHtml = btn ? btn.innerHTML : '';

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = 'Generando...';
  }

  try {
    const company   = document.getElementById('q_company')?.value.trim() || '';
    const seller    = typeof getSellerValue === 'function' ? getSellerValue() : '';
    const phone     = document.getElementById('q_phone')?.value.trim() || '';
    const notes     = document.getElementById('q_notes')?.value.trim() || '';
    const validity  = document.getElementById('q_validity')?.value || '7';
    const lbl1      = document.getElementById('q_cuota1_label')?.value || '6 cuotas sin intereses';
    const lbl2      = document.getElementById('q_cuota2_label')?.value || '10 cuotas sin intereses';
    const div1      = parseInt(document.getElementById('q_cuota1_div')?.value, 10) || 6;
    const div2      = parseInt(document.getElementById('q_cuota2_div')?.value, 10) || 10;
    const footNotes = swOn('sw_footnotes')
      ? (document.getElementById('q_footnotes')?.value.trim() || '')
      : '';

    const qNum = 'COT-' + Date.now().toString().slice(-6);

    const showSpecs       = swOn('sw_specs');
    const showFichaGlobal = swOn('sw_ficha');
    const showPMs         = swOn('sw_payments');
    const showCuotasPDF   = swOn('sw_cuotas');

    const selectedPMs = showPMs ? getSelectedPayMethods() : [];

    const preparedItems = await Promise.all(
      (_qItems || []).map(async (item) => {
        let image_base64 = '';

        if (item.image_url) {
          try {
            image_base64 = await toBase64(item.image_url);
          } catch (e) {
            console.warn('No se pudo convertir imagen a base64:', item.image_url, e);
          }
        }

        return {
          id: item.id || '',
          name: item.name || '',
          price: parseFloat(item.price) || 0,
          qty: parseInt(item.qty, 10) || 1,
          discount: parseFloat(item.discount) || 0,
          variant: item.variant || '',
          image_url: item.image_url || '',
          image_base64,
          specs: item.specs || {},
          ficha: item.ficha || {},
          selectedColors: Array.isArray(item.selectedColors) ? item.selectedColors : []
        };
      })
    );

    const preparedPaymentMethods = await Promise.all(
      (selectedPMs || []).map(async (m) => {
        let logo_base64 = '';

        if (m.logo_url) {
          try {
            logo_base64 = await toBase64(m.logo_url);
          } catch (e) {
            console.warn('No se pudo convertir logo a base64:', m.logo_url, e);
          }
        }

        return {
          id: m.id || '',
          name: m.name || '',
          description: m.description || '',
          logo_url: m.logo_url || '',
          logo_base64
        };
      })
    );

    const payload = {
      qNum,
      client,
      company,
      seller,
      phone,
      notes,
      validity,
      lbl1,
      lbl2,
      div1,
      div2,
      footNotes,
      ivaMode: _ivaMode || 'con',

      settings: {
        store_name: _qSettings?.store_name || 'MacStore',
        store_tagline: _qSettings?.store_tagline || 'Distribuidor Autorizado Apple',
        store_phone: _qSettings?.store_phone || '',
        store_email: _qSettings?.store_email || '',
        store_address: _qSettings?.store_address || 'El Salvador'
      },

      options: {
        showSpecs,
        showFichaGlobal,
        showPMs,
        showCuotasPDF
      },

      items: preparedItems,
      paymentMethods: preparedPaymentMethods
    };

    const res = await fetch('/api/quotations/export-pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/pdf'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      let msg = 'No se pudo generar el PDF';
      try {
        const err = await res.json();
        msg = err.message || msg;
      } catch (_) {}
      throw new Error(msg);
    }

    const blob = await res.blob();

    if (!blob || blob.size === 0) {
      throw new Error('El PDF llegó vacío');
    }

    // El historial ya se guarda en el backend (export-pdf) — no duplicar

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${qNum}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 15000);

  } catch (error) {
    console.error('Error generando PDF:', error);
    alert(error.message || 'Error al generar el PDF');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalBtnHtml || `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Descargar PDF`;
    }
  }
}

// ── LEGACY ────────────────────────────────────────────────────────────────
function generateQuotation(p, s) {
  window.SETTINGS_DATA = s;
  openQuotationModal(p);
}

function downloadQuotation() {
  openQuotationModal(window.PRODUCT_DATA);
}