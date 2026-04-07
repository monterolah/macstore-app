/* Protection layer — do not modify */
(function(){
  'use strict';

  // ── Guardar console.log original ANTES de sobreescribir (para el getter-trick) ──
  var _origLog   = console.log   && console.log.bind(console);
  var _origClear = console.clear && console.clear.bind(console);

  // ── 1. Silenciar consola completamente ──────────────────────────────────────
  var _noop = function(){};
  ['log','warn','error','info','debug','dir','dirxml','table','trace',
   'group','groupEnd','groupCollapsed','count','countReset','assert',
   'clear','profile','profileEnd','time','timeEnd','timeLog','timeStamp'
  ].forEach(function(m){
    try{ console[m] = _noop; }catch(e){}
  });

  // ── 2. Bloquear clic derecho ────────────────────────────────────────────────
  document.addEventListener('contextmenu', function(e){
    e.preventDefault(); e.stopPropagation(); return false;
  }, true);

  // ── 3. Bloquear atajos de teclado de DevTools ───────────────────────────────
  document.addEventListener('keydown', function(e){
    var k   = e.keyCode || e.which;
    var ctrl = e.ctrlKey || e.metaKey;
    if(k === 123){ e.preventDefault(); e.stopPropagation(); return false; }                  // F12
    if(ctrl && e.shiftKey && [73,74,67,75,69,77].indexOf(k) !== -1){                         // Ctrl+Shift+I/J/C/K/E/M
      e.preventDefault(); e.stopPropagation(); return false;
    }
    if(ctrl && [85,83,80].indexOf(k) !== -1){                                                 // Ctrl+U / S / P
      e.preventDefault(); e.stopPropagation(); return false;
    }
    if(ctrl && e.altKey && k === 73){ e.preventDefault(); e.stopPropagation(); return false; } // Cmd+Opt+I
  }, true);

  // ── Función de limpieza ──────────────────────────────────────────────────────
  var _wiped = false;
  function _wipe(){
    if(_wiped) return;
    _wiped = true;
    try{ window.stop && window.stop(); }catch(e){}
    try{
      document.documentElement.style.cssText = 'visibility:hidden!important;pointer-events:none!important';
      document.body.innerHTML = '';
      document.head.querySelectorAll('script,link,style').forEach(function(el){ el.remove(); });
    }catch(e){}
  }

  // ── 4. Anti-debugger por timing ─────────────────────────────────────────────
  // Cuando DevTools está abierto y llega a un "debugger", el tiempo se dispara > 100 ms
  function _antiDebug(){
    var t = performance.now();
    (new Function('debugger'))();
    if(performance.now() - t > 100){ _wipe(); }
  }
  setInterval(_antiDebug, 900);

  // ── 5. Getter-trick: console.log activa el getter cuando DevTools está abierto
  var _probe = new Image();
  Object.defineProperty(_probe, 'id', {
    get: function(){ _wipe(); return ''; }
  });
  setInterval(function(){
    if(_origLog)  _origLog(_probe);       // DevTools inspecciona el objeto → getter se activa
    if(_origClear) _origClear();
  }, 1000);

  // ── 6. Detección por diferencia de tamaño de ventana (panel lateral/inferior) ─
  var _wasOpen = false;
  var _THR = 160;
  function _checkSize(){
    var open = (window.outerWidth - window.innerWidth > _THR) ||
               (window.outerHeight - window.innerHeight > _THR);
    if(open && !_wasOpen){ _wasOpen = true; _wipe(); }
    else if(!open){ _wasOpen = false; }
  }
  setInterval(_checkSize, 500);

  // ── 7. Ocultar errores JS (no filtrar rutas ni variables) ───────────────────
  window.onerror = function(){ return true; };
  window.addEventListener('unhandledrejection', function(e){ e.preventDefault(); }, true);

  // ── 8. Deshabilitar arrastrar assets ────────────────────────────────────────
  document.addEventListener('dragstart', function(e){ e.preventDefault(); return false; }, true);

  // ── 9. Bloquear selección de texto fuera de inputs ──────────────────────────
  document.addEventListener('selectstart', function(e){
    var t = e.target && e.target.tagName;
    if(t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT'){ return true; }
    e.preventDefault(); return false;
  }, true);

})();
