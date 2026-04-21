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
        <div style="margin-bottom:20px">
          <div style="font-size:13px;font-weight:600;color:#1d1d1f;margin-bottom:10px;text-transform:uppercase;letter-spacing:.03em">Datos del cliente</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:#86868b;font-weight:500;display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:.03em">Nombre *</label>
              <input id="q_client" placeholder="Nombre completo" style="width:100%;border:1px solid #d2d2d7;border-radius:9px;padding:9px 12px;font-size:14px;outline:none;font-family:inherit" onfocus="this.style.borderColor='#1d1d1f'" onblur="this.style.borderColor='#d2d2d7'">
            </div>
            <div>
              <label style="font-size:11px;color:#86868b;font-weight:500;display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:.03em">Teléfono</label>
              <input id="q_phone" placeholder="Número de teléfono" style="width:100%;border:1px solid #d2d2d7;border-radius:9px;padding:9px 12px;font-size:14px;outline:none;font-family:inherit" onfocus="this.style.borderColor='#1d1d1f'" onblur="this.style.borderColor='#d2d2d7'">
            </div>
          </div>
          <div style="margin-top:10px">
            <label style="font-size:11px;color:#86868b;font-weight:500;display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:.03em">Empresa (opcional)</label>
            <input id="q_company" placeholder="Empresa o negocio" style="width:100%;border:1px solid #d2d2d7;border-radius:9px;padding:9px 12px;font-size:14px;outline:none;font-family:inherit" onfocus="this.style.borderColor='#1d1d1f'" onblur="this.style.borderColor='#d2d2d7'">
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

        <!-- IVA -->
        <div style="background:#f5f5f7;border-radius:12px;padding:14px;margin-bottom:20px">
          <div style="font-size:13px;font-weight:600;margin-bottom:10px">Impuestos</div>
          <div style="display:flex;gap:8px">
            <button id="btn_sin_iva" onclick="setIVA('sin')" style="flex:1;padding:9px;border-radius:9px;border:2px solid #1d1d1f;background:#1d1d1f;color:#fff;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit">Sin IVA</button>
            <button id="btn_con_iva" onclick="setIVA('con')" style="flex:1;padding:9px;border-radius:9px;border:1px solid #d2d2d7;background:#fff;color:#1d1d1f;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit">Con IVA (13%)</button>
            <button id="btn_exento" onclick="setIVA('exento')" style="flex:1;padding:9px;border-radius:9px;border:1px solid #d2d2d7;background:#fff;color:#1d1d1f;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit">Exento de IVA</button>
          </div>
          <div id="q_total_preview" style="margin-top:12px;text-align:right;font-size:15px;font-weight:600"></div>
        </div>

        <div style="display:flex;gap:10px">
          <button onclick="generateQuotationFromModal()" style="flex:1;background:#1d1d1f;color:#fff;border:none;padding:13px;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Descargar cotización PDF
          </button>
          <button onclick="document.getElementById('quotModal').remove()" style="padding:13px 20px;border-radius:12px;border:1px solid #d2d2d7;background:none;font-size:15px;cursor:pointer;font-family:inherit">Cancelar</button>
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
    btn.style.background = active ? '#1d1d1f' : '#fff';
    btn.style.color = active ? '#fff' : '#1d1d1f';
    btn.style.border = active ? '2px solid #1d1d1f' : '1px solid #d2d2d7';
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
    <div style="display:grid;grid-template-columns:36px 1fr auto auto;gap:10px;align-items:center;padding:10px;background:#f5f5f7;border-radius:10px;margin-bottom:8px">
      <img src="${item.image_url||''}" style="width:36px;height:36px;object-fit:contain;border-radius:6px;background:#fff" onerror="this.style.display='none'">
      <div>
        <div style="font-size:13px;font-weight:600">${item.name}${item.variant?' — '+item.variant:''}</div>
        <div style="font-size:12px;color:#86868b">$${parseFloat(item.price).toFixed(2)} c/u</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <button onclick="changeQty(${i},-1)" style="width:24px;height:24px;border-radius:50%;border:1px solid #d2d2d7;background:#fff;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center">-</button>
        <span style="font-size:14px;font-weight:600;min-width:20px;text-align:center">${item.qty}</span>
        <button onclick="changeQty(${i},1)" style="width:24px;height:24px;border-radius:50%;border:1px solid #d2d2d7;background:#fff;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center">+</button>
      </div>
      <button onclick="removeQuotItem(${i})" style="color:#c0392b;background:none;border:none;cursor:pointer;font-size:18px;padding:4px">×</button>
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
  select.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px';
  select.innerHTML = `
    <div style="background:#fff;border-radius:18px;width:100%;max-width:480px;max-height:70vh;overflow:hidden;display:flex;flex-direction:column">
      <div style="padding:18px 20px;border-bottom:1px solid #e8e8ed;display:flex;justify-content:space-between;align-items:center">
        <span style="font-weight:600">Seleccionar producto</span>
        <button onclick="this.closest('div[style*=\"fixed\"]').remove()" style="background:none;border:none;cursor:pointer;font-size:20px;color:#86868b">×</button>
      </div>
      <input placeholder="Buscar..." oninput="filterQProd(this.value)" style="margin:12px 16px;border:1px solid #d2d2d7;border-radius:8px;padding:8px 12px;font-size:14px;outline:none;font-family:inherit">
      <div id="qProdList" style="overflow-y:auto;padding:0 12px 12px">
        ${_allProducts.map(p=>`
        <div onclick="selectQuotProd(${JSON.stringify(p).replace(/"/g,'&quot;')});this.closest('div[style*=\"fixed\"]').remove()"
          style="display:flex;align-items:center;gap:12px;padding:10px;border-radius:10px;cursor:pointer;transition:background .15s" onmouseover="this.style.background='#f5f5f7'" onmouseout="this.style.background=''">
          <img src="${p.image_url||''}" style="width:40px;height:40px;object-fit:contain;border-radius:6px;background:#f5f5f7" onerror="this.style.display='none'">
          <div><div style="font-size:14px;font-weight:500">${p.name}</div><div style="font-size:12px;color:#86868b">$${parseFloat(p.price).toFixed(2)}</div></div>
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
  if (mode === 'con') { total = subtotal * 1.13; ivaText = ` <span style="font-size:12px;color:#86868b;font-weight:400">(IVA 13% incluido)</span>`; }
  else if (mode === 'exento') { ivaText = ` <span style="font-size:12px;color:#86868b;font-weight:400">(Exento de IVA)</span>`; }
  preview.innerHTML = `Total: <strong>$${total.toFixed(2)}</strong>${ivaText}`;
}

async function generateQuotationFromModal() {
  const client = document.getElementById('q_client')?.value.trim();
  if (!client) {
    const input = document.getElementById('q_client');
    input.focus();
    input.style.borderColor = '#c0392b';
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
    const mode = window._ivaMode || 'sin';
    const subtotal = _quotationItems.reduce((s, i) => s + (parseFloat(i.price) * i.qty), 0);
    const iva = mode === 'con' ? subtotal * 0.13 : 0;
    const total = subtotal + iva;
    const quoteNum = 'COT-' + Date.now().toString().slice(-6);

    const payload = {
      client,
      company,
      client_phone: phone,
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
