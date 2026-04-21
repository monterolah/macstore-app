/* MacStore — Sistema de Cotización v2 */

// ── MODAL DE COTIZACIÓN ───────────────────────────────────────────────────
let _quotationItems = [];
let _quotationSettings = {};
let _allProducts = [];

async function openQuotationModal(initialProduct) {
  _quotationSettings = window.SETTINGS_DATA || {};

  // Cargar productos si no están cargados
  if (!_allProducts.length) {
    try {
      const res = await fetch('/api/products');
      _allProducts = await res.json();
    } catch(e) { _allProducts = []; }
  }

  // Si viene con producto inicial, agregarlo
  _quotationItems = [];
  if (initialProduct) {
    _quotationItems.push({
      id: initialProduct.id || Date.now(),
      name: initialProduct.name,
      price: window._selectedPrice || initialProduct.price,
      variant: window._selectedVariant || '',
      image_url: initialProduct.image_url || '',
      qty: 1
    });
  }

  // Crear modal
  const existing = document.getElementById('quotModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'quotModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:22px;width:100%;max-width:680px;max-height:90vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,.25)">
      <div style="padding:28px 28px 20px;border-bottom:1px solid #e8e8ed;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:#fff;border-radius:22px 22px 0 0;z-index:1">
        <div>
          <div style="font-size:20px;font-weight:700;letter-spacing:-.04em">Nueva cotización</div>
          <div style="font-size:13px;color:#86868b;margin-top:2px">Completa los datos para generar el PDF</div>
        </div>
        <button onclick="document.getElementById('quotModal').remove()" style="width:32px;height:32px;border-radius:50%;border:1px solid #e8e8ed;background:none;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;color:#86868b">×</button>
      </div>

      <div style="padding:24px 28px">

        <!-- DATOS DEL CLIENTE -->
        <div style="margin-bottom:24px">
          <div style="font-size:13px;font-weight:600;color:#1d1d1f;margin-bottom:12px;text-transform:uppercase;letter-spacing:.03em">Datos del cliente</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div>
              <label style="font-size:11px;color:#86868b;font-weight:500;display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:.03em">Nombre *</label>
              <input id="q_client" placeholder="Nombre completo" style="width:100%;border:1px solid #d2d2d7;border-radius:9px;padding:10px 12px;font-size:14px;outline:none;font-family:inherit;transition:border-color .2s" onfocus="this.style.borderColor='#0071e3'" onblur="this.style.borderColor='#d2d2d7'">
            </div>
            <div>
              <label style="font-size:11px;color:#86868b;font-weight:500;display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:.03em">Teléfono</label>
              <input id="q_phone" placeholder="Número de teléfono" style="width:100%;border:1px solid #d2d2d7;border-radius:9px;padding:10px 12px;font-size:14px;outline:none;font-family:inherit;transition:border-color .2s" onfocus="this.style.borderColor='#0071e3'" onblur="this.style.borderColor='#d2d2d7'">
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <label style="font-size:11px;color:#86868b;font-weight:500;display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:.03em">Empresa (opcional)</label>
              <input id="q_company" placeholder="Empresa o negocio" style="width:100%;border:1px solid #d2d2d7;border-radius:9px;padding:10px 12px;font-size:14px;outline:none;font-family:inherit;transition:border-color .2s" onfocus="this.style.borderColor='#0071e3'" onblur="this.style.borderColor='#d2d2d7'">
            </div>
            <div>
              <label style="font-size:11px;color:#86868b;font-weight:500;display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:.03em">Email</label>
              <input id="q_email" type="email" placeholder="correo@ejemplo.com" style="width:100%;border:1px solid #d2d2d7;border-radius:9px;padding:10px 12px;font-size:14px;outline:none;font-family:inherit;transition:border-color .2s" onfocus="this.style.borderColor='#0071e3'" onblur="this.style.borderColor='#d2d2d7'">
            </div>
          </div>
        </div>

        <!-- PRODUCTOS -->
        <div style="margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div style="font-size:13px;font-weight:600;color:#1d1d1f;text-transform:uppercase;letter-spacing:.03em">Productos</div>
            <button onclick="addProductToQuot()" style="font-size:12px;color:#0071e3;background:none;border:none;cursor:pointer;font-family:inherit;font-weight:500">+ Agregar producto</button>
          </div>
          <div id="q_items"></div>
        </div>

        <!-- IMPUESTOS -->
        <div style="background:#f8f9fa;border:1px solid #e9ecef;border-radius:14px;padding:20px;margin-bottom:24px">
          <div style="font-size:14px;font-weight:700;margin-bottom:16px;color:#1d1d1f;text-transform:uppercase;letter-spacing:.02em">③ Impuestos y totales</div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
            <button id="btn_sin_iva" onclick="setIVA('sin')" style="padding:14px 10px;border-radius:12px;border:2px solid #0071e3;background:#0071e3;color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .2s">
              <div style="font-size:13px;font-weight:600;margin-bottom:4px">Sin IVA</div>
              <div style="font-size:11px;color:#e3f2fd;opacity:.85">Precio neto</div>
            </button>
            <button id="btn_con_iva" onclick="setIVA('con')" style="padding:14px 10px;border-radius:12px;border:1.5px solid #d2d2d7;background:#fff;color:#1d1d1f;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;transition:all .2s">
              <div style="font-size:13px;font-weight:600;margin-bottom:4px">Con IVA</div>
              <div style="font-size:11px;color:#86868b">+13% incluido</div>
            </button>
            <button id="btn_exento" onclick="setIVA('exento')" style="padding:14px 10px;border-radius:12px;border:1.5px solid #d2d2d7;background:#fff;color:#1d1d1f;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;transition:all .2s">
              <div style="font-size:13px;font-weight:600;margin-bottom:4px">Exento</div>
              <div style="font-size:11px;color:#86868b">0% IVA</div>
            </button>
          </div>
          <div id="q_total_preview" style="margin-top:16px;text-align:center;font-size:17px;font-weight:600;color:#1d1d1f;padding:14px 16px;background:#fff;border-radius:10px;border:1px solid #e9ecef;box-shadow:0 1px 4px rgba(0,0,0,.06)"></div>
        </div>

        <!-- MÉTODOS DE PAGO -->
        <div style="background:#f8f9fa;border:1px solid #e9ecef;border-radius:14px;padding:20px;margin-bottom:24px">
          <div style="font-size:14px;font-weight:700;margin-bottom:16px;color:#1d1d1f;text-transform:uppercase;letter-spacing:.02em">④ Métodos de pago</div>
          <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px">
            <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:#fff;border-radius:12px;border:1.5px solid #e9ecef;transition:border-color .2s">
              <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#1a365d,#2c5282);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>
              </div>
              <div>
                <div style="font-size:13px;font-weight:600;color:#1d1d1f">Banco Agrícola</div>
                <div style="font-size:11px;color:#86868b">Transferencia y tarjetas</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:#fff;border-radius:12px;border:1.5px solid #e9ecef;transition:border-color .2s">
              <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#c53030,#c0392b);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>
              </div>
              <div>
                <div style="font-size:13px;font-weight:600;color:#1d1d1f">Credomatic</div>
                <div style="font-size:11px;color:#86868b">Todas las tarjetas</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:#fff;border-radius:12px;border:1.5px solid #e9ecef;transition:border-color .2s">
              <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#1a365d,#2b6cb0);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>
              </div>
              <div>
                <div style="font-size:13px;font-weight:600;color:#1d1d1f">Banco Cuscatlán</div>
                <div style="font-size:11px;color:#86868b">Débito y crédito</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:#fff;border-radius:12px;border:1.5px solid #e9ecef;transition:border-color .2s">
              <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#dd6b20,#c05621);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>
              </div>
              <div>
                <div style="font-size:13px;font-weight:600;color:#1d1d1f">Davivienda</div>
                <div style="font-size:11px;color:#86868b">Todas las modalidades</div>
              </div>
            </div>
          </div>
          <div style="margin-top:16px;padding:14px;background:linear-gradient(135deg,#f0f9ff,#e0f2fe);border-radius:12px;border:1px solid #bae6fd">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0071e3" stroke-width="2" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
              <span style="font-size:13px;font-weight:600;color:#0071e3">Financiamiento disponible</span>
            </div>
            <div style="font-size:12px;color:#0c4a6e;line-height:1.5;padding-left:24px">
              Aceptamos todas las tarjetas de crédito y débito. Consultar opciones de financiamiento a plazos sin intereses con tarjetas participantes.
            </div>
          </div>
        </div>

        <div style="display:flex;gap:12px">
          <button onclick="generateQuotationFromModal()" style="flex:1;background:#0071e3;color:#fff;border:none;padding:14px;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px;transition:background .2s" onmouseover="this.style.background='#0056b3'" onmouseout="this.style.background='#0071e3'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Generar cotización PDF
          </button>
          <button onclick="document.getElementById('quotModal').remove()" style="padding:14px 20px;border-radius:12px;border:1px solid #d2d2d7;background:#fff;color:#6c757d;font-size:15px;cursor:pointer;font-family:inherit;font-weight:500;transition:all .2s" onmouseover="this.style.background='#f8f9fa';this.style.borderColor='#adb5bd'" onmouseout="this.style.background='#fff';this.style.borderColor='#d2d2d7'">Cancelar</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });

  window._ivaMode = 'sin';
  renderQuotItems();
  updateTotal();
  document.getElementById('q_client').focus();
}

function setIVA(mode) {
  window._ivaMode = mode;
  ['sin','con','exento'].forEach(m => {
    const btn = document.getElementById('btn_'+m+'_iva');
    if(!btn) return;
    const active = m === mode;
    if (m === 'sin') {
      btn.style.background = active ? '#0071e3' : '#fff';
      btn.style.borderColor = active ? '#0071e3' : '#d2d2d7';
      btn.style.color = active ? '#fff' : '#1d1d1f';
    } else {
      btn.style.background = active ? '#0071e3' : '#fff';
      btn.style.borderColor = active ? '#0071e3' : '#d2d2d7';
      btn.style.color = active ? '#fff' : '#1d1d1f';
    }
  });
  updateTotal();
}

function renderQuotItems() {
  const container = document.getElementById('q_items');
  if (!container) return;
  if (!_quotationItems.length) {
    container.innerHTML = '<div style="text-align:center;color:#86868b;font-size:13px;padding:20px;background:#f5f5f7;border-radius:10px">No hay productos. Haz clic en "+ Agregar producto"</div>';
    return;
  }
  container.innerHTML = _quotationItems.map((item, i) => `
    <div style="display:flex;align-items:center;gap:12px;padding:12px;background:#f8f9fa;border:1px solid #e9ecef;border-radius:10px;margin-bottom:8px;position:relative">
      <div style="width:48px;height:48px;border-radius:8px;background:#fff;border:1px solid #dee2e6;display:flex;align-items:center;justify-content:center;flex-shrink:0">
        ${item.image_url ? `<img src="${item.image_url}" style="width:100%;height:100%;object-fit:contain;border-radius:6px" onerror="this.parentElement.innerHTML='<div style=font-size:20px;color:#adb5bd>📦</div>'">` : '<div style="font-size:20px;color:#adb5bd">📦</div>'}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:600;color:#1d1d1f;margin-bottom:2px">${item.name}${item.variant?' — '+item.variant:''}</div>
        <div style="font-size:13px;color:#86868b">$${parseFloat(item.price).toFixed(2)} c/u × ${item.qty} = $${(parseFloat(item.price)*item.qty).toFixed(2)}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <button onclick="changeQty(${i},-1)" style="width:28px;height:28px;border-radius:50%;border:1px solid #d2d2d7;background:#fff;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;color:#6c757d;font-weight:600">-</button>
        <span style="font-size:14px;font-weight:600;min-width:24px;text-align:center">${item.qty}</span>
        <button onclick="changeQty(${i},1)" style="width:28px;height:28px;border-radius:50%;border:1px solid #d2d2d7;background:#fff;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;color:#6c757d;font-weight:600">+</button>
      </div>
      <button onclick="removeQuotItem(${i})" style="position:absolute;top:8px;right:8px;color:#dc3545;background:none;border:none;cursor:pointer;font-size:16px;padding:4px;border-radius:4px" onmouseover="this.style.background='#f8d7da'" onmouseout="this.style.background='none'">×</button>
    </div>`).join('');
  updateTotal();
}

function changeQty(i, delta) {
  _quotationItems[i].qty = Math.max(1, (_quotationItems[i].qty||1) + delta);
  renderQuotItems();
}

function removeQuotItem(i) {
  _quotationItems.splice(i, 1);
  renderQuotItems();
}

function addProductToQuot() {
  const select = document.createElement('div');
  select.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)';
  select.innerHTML = `
    <div style="background:#fff;border-radius:20px;width:100%;max-width:520px;max-height:70vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <div style="padding:20px 24px;border-bottom:1px solid #e9ecef;display:flex;justify-content:space-between;align-items:center">
        <span style="font-weight:700;font-size:18px;color:#1d1d1f">Seleccionar producto</span>
        <button onclick="this.closest('div[style*=\"fixed\"]').remove()" style="width:32px;height:32px;border-radius:50%;border:1px solid #d2d2d7;background:none;cursor:pointer;font-size:18px;color:#6c757d;display:flex;align-items:center;justify-content:center">×</button>
      </div>
      <div style="padding:0 16px">
        <input placeholder="Buscar productos..." oninput="filterQProd(this.value)" style="width:100%;border:1px solid #d2d2d7;border-radius:10px;padding:12px 16px;font-size:14px;outline:none;font-family:inherit;margin:16px 0 12px" onfocus="this.style.borderColor='#0071e3'" onblur="this.style.borderColor='#d2d2d7'">
      </div>
      <div id="qProdList" style="overflow-y:auto;padding:0 12px 16px;flex:1">
        ${_allProducts.map(p=>`
        <div onclick="selectQuotProd(${JSON.stringify(p).replace(/"/g,'&quot;')});this.closest('div[style*=\"fixed\"]').remove()"
          style="display:flex;align-items:center;gap:14px;padding:12px;border-radius:12px;cursor:pointer;transition:all .2s;margin-bottom:4px" onmouseover="this.style.background='#f8f9fa';this.style.transform='translateY(-1px)'" onmouseout="this.style.background='';this.style.transform=''">
          <div style="width:44px;height:44px;border-radius:8px;background:#f8f9fa;border:1px solid #e9ecef;display:flex;align-items:center;justify-content:center;flex-shrink:0">
            ${p.image_url ? `<img src="${p.image_url}" style="width:100%;height:100%;object-fit:contain;border-radius:6px" onerror="this.parentElement.innerHTML='<div style=font-size:18px;color:#adb5bd>📦</div>'">` : '<div style="font-size:18px;color:#adb5bd">📦</div>'}
          </div>
          <div style="flex:1">
            <div style="font-size:15px;font-weight:600;color:#1d1d1f;margin-bottom:2px">${p.name}</div>
            <div style="font-size:13px;color:#86868b">$${parseFloat(p.price).toFixed(2)}</div>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0071e3" stroke-width="2" style="flex-shrink:0"><path d="M9 12l2 2 4-4"/><path d="M21 12c-1 0-3-1-3-3s2-3 3-3 3 1 3 3-2 3-3 3"/><path d="M3 12c1 0 3-1 3-3s-2-3-3-3-3 1-3 3 2 3 3 3"/><path d="M12 3c0 1-1 3-3 3s-3-2-3-3 1-3 3-3 3 2 3 3"/><path d="M12 21c0-1-1-3-3-3s-3 2-3 3 1 3 3 3 3-2 3-3"/></svg>
        </div>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(select);
  select.addEventListener('click', e => { if(e.target===select) select.remove(); });
}

function filterQProd(q) {
  document.querySelectorAll('#qProdList > div').forEach(el => {
    el.style.display = el.textContent.toLowerCase().includes(q.toLowerCase()) ? '' : 'none';
  });
}

function selectQuotProd(p) {
  _quotationItems.push({ id:p.id, name:p.name, price:p.price, variant:'', image_url:p.image_url||'', qty:1 });
  renderQuotItems();
}

function updateTotal() {
  const preview = document.getElementById('q_total_preview');
  if (!preview) return;
  const subtotal = _quotationItems.reduce((s,i) => s + (parseFloat(i.price)*i.qty), 0);
  const mode = window._ivaMode || 'sin';
  let total = subtotal;
  let ivaText = '';
  if (mode === 'con') {
    total = subtotal * 1.13;
    ivaText = `<div style="font-size:12px;color:#86868b;margin-top:4px">Subtotal: $${subtotal.toFixed(2)} + IVA 13%: $${(subtotal * 0.13).toFixed(2)}</div>`;
  } else if (mode === 'exento') {
    ivaText = `<div style="font-size:12px;color:#86868b;margin-top:4px">Exento de IVA</div>`;
  } else {
    ivaText = `<div style="font-size:12px;color:#86868b;margin-top:4px">Sin IVA incluido</div>`;
  }
  preview.innerHTML = `<div>Total: <strong style="font-size:18px">$${total.toFixed(2)}</strong></div>${ivaText}`;
}

async function generateQuotationFromModal() {
  // Reset previous validation
  document.getElementById('q_client').style.borderColor = '#d2d2d7';

  const client = document.getElementById('q_client')?.value.trim();
  if (!client) {
    const input = document.getElementById('q_client');
    input.focus();
    input.style.borderColor = '#dc3545';
    input.style.boxShadow = '0 0 0 0.2rem rgba(220, 53, 69, 0.25)';
    return;
  }
  if (!_quotationItems.length) {
    alert('Agrega al menos un producto');
    return;
  }

  const btn = document.querySelector('#quotModal button[onclick="generateQuotationFromModal()"]');
  const original = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '.7';
    btn.innerHTML = 'Generando PDF...';
  }

  try {
    const company = document.getElementById('q_company')?.value.trim();
    const phone = document.getElementById('q_phone')?.value.trim();
    const email = document.getElementById('q_email')?.value.trim();
    const mode = window._ivaMode || 'sin';
    const subtotal = _quotationItems.reduce((s, i) => s + (parseFloat(i.price) * i.qty), 0);
    const iva = mode === 'con' ? subtotal * 0.13 : 0;
    const total = subtotal + iva;
    const quoteNum = 'COT-' + Date.now().toString().slice(-6);

    const payload = {
      client,
      company,
      client_phone: phone,
      client_email: email,
      seller: window.currentSellerName || '',
      notes: '',
      validity: '7',
      ivaMode: mode === 'sin' ? 'desglosado' : mode,
      items: _quotationItems,
      total,
      lbl1: '6 cuotas sin intereses',
      lbl2: '10 cuotas sin intereses',
      div1: 6,
      div2: 10,
      qNum: quoteNum,
      saveHistory: true
    };

    const res = await fetch('/api/quotations/export-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      let message = 'No se pudo generar el PDF';
      try {
        const data = await res.json();
        if (data?.error) message = data.error;
      } catch (_) {}
      throw new Error(message);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${quoteNum}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    document.getElementById('quotModal')?.remove();
  } catch (err) {
    alert(err.message || 'Error al generar el PDF');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.innerHTML = original;
    }
  }
}

// Función legacy para cotización simple desde producto
function generateQuotation(product, settings) {
  window.SETTINGS_DATA = settings;
  openQuotationModal(product);
}

function downloadQuotation() {
  openQuotationModal(window.PRODUCT_DATA);
}
