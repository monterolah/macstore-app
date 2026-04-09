/* Light protection layer: non-destructive */
(function(){
  'use strict';

  // Keep basic shortcut hardening without breaking zoom or page rendering.
  document.addEventListener('contextmenu', function(e){
    e.preventDefault();
  }, true);

  document.addEventListener('keydown', function(e){
    var k = e.keyCode || e.which;
    var ctrl = e.ctrlKey || e.metaKey;

    if(k === 123){
      e.preventDefault();
      return false;
    }

    if(ctrl && e.shiftKey && [73,74,67,75,69,77].indexOf(k) !== -1){
      e.preventDefault();
      return false;
    }

    // Do not block zoom shortcuts (Ctrl/Cmd + '+' '-' '0').
    if(ctrl && [85,83,80].indexOf(k) !== -1){
      e.preventDefault();
      return false;
    }

    if(ctrl && e.altKey && k === 73){
      e.preventDefault();
      return false;
    }
  }, true);

  document.addEventListener('dragstart', function(e){
    e.preventDefault();
  }, true);
})();
