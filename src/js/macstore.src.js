/* MacStore — Animations v3 */

// ── NAV SCROLL ────────────────────────────────────────────────────────────
window.addEventListener('scroll', () => {
  document.querySelector('.apple-nav')?.classList.toggle('scrolled', window.scrollY > 10);
}, {passive:true});

// ── SEARCH ────────────────────────────────────────────────────────────────
document.getElementById('searchToggle')?.addEventListener('click', function(){
  const bar = document.getElementById('searchBar');
  const open = bar.style.display !== 'none';
  bar.style.display = open ? 'none' : 'block';
  if(!open) document.getElementById('searchInput')?.focus();
});
document.getElementById('searchInput')?.addEventListener('keydown', function(e){
  if(e.key==='Enter' && this.value.trim())
    location.href = '/productos?q=' + encodeURIComponent(this.value.trim());
  if(e.key==='Escape') document.getElementById('searchBar').style.display='none';
});

// ── HAMBURGER ─────────────────────────────────────────────────────────────
document.getElementById('hamburgerBtn')?.addEventListener('click', function(){
  document.getElementById('mobNav').classList.toggle('open');
  this.classList.toggle('open');
});
document.getElementById('mobClose')?.addEventListener('click', ()=>{
  document.getElementById('mobNav').classList.remove('open');
  document.getElementById('hamburgerBtn')?.classList.remove('open');
});

// ── HERO SLIDER ───────────────────────────────────────────────────────────
(function(){
  const slides = document.querySelectorAll('.ms-slide');
  const dots   = document.querySelectorAll('.ms-dot');
  if(slides.length < 2) return;
  let cur = 0, timer;
  function go(i){
    slides[cur].classList.remove('active');
    dots[cur]?.classList.remove('active');
    cur = (i + slides.length) % slides.length;
    slides[cur].classList.add('active');
    dots[cur]?.classList.add('active');
  }
  dots.forEach((d,i) => d.addEventListener('click',()=>{ clearInterval(timer); go(i); start(); }));
  function start(){ timer = setInterval(()=>go(cur+1), 6000); }
  slides[0]?.classList.add('active');
  dots[0]?.classList.add('active');
  start();
})();

// ── PARALLAX HERO ─────────────────────────────────────────────────────────
(function(){
  const hero = document.querySelector('.ms-hero-wrap');
  if(!hero || window.matchMedia('(prefers-reduced-motion:reduce)').matches) return;
  let ticking = false;
  window.addEventListener('scroll', ()=>{
    if(ticking) return;
    requestAnimationFrame(()=>{
      const y = window.scrollY;
      const bg = hero.querySelector('.ms-hero-bg');
      if(bg && y < window.innerHeight)
        bg.style.transform = `scale(1.08) translateY(${y * 0.22}px)`;
      ticking = false;
    });
    ticking = true;
  },{passive:true});
})();

// ── SCROLL REVEAL ─────────────────────────────────────────────────────────
(function(){
  if(!('IntersectionObserver' in window)){
    document.querySelectorAll('[data-reveal]').forEach(el=>el.classList.add('revealed'));
    return;
  }
  const obs = new IntersectionObserver((entries)=>{
    entries.forEach(e=>{
      if(!e.isIntersecting) return;
      const delay = parseInt(e.target.dataset.delay)||0;
      setTimeout(()=>e.target.classList.add('revealed'), delay);
      obs.unobserve(e.target);
    });
  },{threshold:0.1});
  document.querySelectorAll('[data-reveal]').forEach(el=>obs.observe(el));
})();

// ── SHOWCASE SCROLL PARALLAX ──────────────────────────────────────────────
// Disabled - causes clipping with overflow:hidden

// ── CARD 3D TILT ──────────────────────────────────────────────────────────
(function(){
  if(window.matchMedia('(prefers-reduced-motion:reduce)').matches) return;
  function initTilt(){
    document.querySelectorAll('.ms-card:not(.tilt-init)').forEach(card=>{
      card.classList.add('tilt-init');
      card.addEventListener('mousemove',e=>{
        const r=card.getBoundingClientRect();
        const x=(e.clientX-r.left)/r.width-.5;
        const y=(e.clientY-r.top)/r.height-.5;
        card.style.transform=`translateY(-6px) rotateY(${x*7}deg) rotateX(${-y*7}deg)`;
      });
      card.addEventListener('mouseleave',()=>{
        card.style.transition='transform .4s ease,box-shadow .4s ease';
        card.style.transform='';
        setTimeout(()=>card.style.transition='',400);
      });
      card.addEventListener('mouseenter',()=>card.style.transition='none');
    });
  }
  initTilt();
  // Re-init for dynamically loaded cards
  new MutationObserver(initTilt).observe(document.body,{childList:true,subtree:true});
})();

// ── BADGE COUNTER ANIMATION ───────────────────────────────────────────────
(function(){
  const obs = new IntersectionObserver(entries=>{
    entries.forEach(e=>{
      if(!e.isIntersecting) return;
      const el=e.target;
      const target=parseInt(el.dataset.count);
      if(isNaN(target)) return;
      let start=null;
      function step(ts){
        if(!start) start=ts;
        const p=Math.min((ts-start)/1000,1);
        el.textContent=Math.floor(p*target);
        if(p<1) requestAnimationFrame(step);
        else el.textContent=target;
      }
      requestAnimationFrame(step);
      obs.unobserve(el);
    });
  },{threshold:0.5});
  document.querySelectorAll('[data-count]').forEach(el=>obs.observe(el));
})();

// ── STAGGER CHILDREN ──────────────────────────────────────────────────────
(function(){
  const obs = new IntersectionObserver(entries=>{
    entries.forEach(e=>{
      if(!e.isIntersecting) return;
      [...e.target.children].forEach((child,i)=>{
        setTimeout(()=>child.classList.add('revealed'), i*80);
      });
      obs.unobserve(e.target);
    });
  },{threshold:0.1});
  document.querySelectorAll('[data-stagger]').forEach(el=>{
    [...el.children].forEach(child=>child.setAttribute('data-reveal',''));
    obs.observe(el);
  });
})();

// ── SWATCH CLICK EN CATÁLOGO ──────────────────────────────────────────────
function swatchClick(swatch, pid, imgSrc, availCaps, imgFit, imgPos, imgScale) {
  const wrap = swatch.closest('div');
  if (wrap) wrap.querySelectorAll('.ms-card-swatch').forEach(s => s.classList.remove('active'));
  swatch.classList.add('active');

  const card = swatch.closest('.ms-card');
  const img = document.getElementById('cardimg_' + pid);
  const targetScale = parseFloat(imgScale || '1') || 1;
  const targetFit = imgFit || 'contain';
  const targetPos = imgPos || 'center';

  if (card) card.style.setProperty('--img-scale', targetScale);
  if (img) {
    img.style.transition = 'opacity .18s';
    img.style.opacity = '0';
    setTimeout(() => {
      if (imgSrc) img.src = imgSrc;
      img.style.objectFit = targetFit;
      img.style.objectPosition = targetPos;
      img.style.transform = `scale(${targetScale})`;
      img.style.transformOrigin = 'center center';
      img.onload = img.onerror = () => { img.style.opacity = '1'; };
      if (!imgSrc) img.style.opacity = '1';
    }, 160);
  }

  const caps = document.getElementById('caps_' + pid);
  if (!caps || !availCaps) return;
  caps.querySelectorAll('[data-cap]').forEach(pill => {
    const ok = availCaps.includes(pill.dataset.cap);
    pill.style.color          = ok ? '#515154' : '#c0c0c0';
    pill.style.borderColor    = ok ? '#d2d2d7' : '#e8e8ed';
    pill.style.fontWeight     = ok ? '500'     : '400';
    pill.style.textDecoration = ok ? 'none'    : 'line-through';
  });
}

function cardSwatchClick(el, ev) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  const card = el.closest('.ms-card');
  if (!card) return;
  const img = card.querySelector('.ms-card-img img');
  card.querySelectorAll('.ms-card-swatch').forEach(s => s.classList.remove('active'));
  el.classList.add('active');
  const scale = parseFloat(el.dataset.scale || '1') || 1;
  const fit = el.dataset.fit || 'contain';
  const pos = el.dataset.pos || 'center';
  if (card) card.style.setProperty('--img-scale', scale);
  if (img) {
    img.style.opacity = '0';
    setTimeout(() => {
      if (el.dataset.img) img.src = el.dataset.img;
      img.style.objectFit = fit;
      img.style.objectPosition = pos;
      img.style.transform = `scale(${scale})`;
      img.style.transformOrigin = 'center center';
      img.onload = img.onerror = () => { img.style.opacity = '1'; };
      if (!el.dataset.img) img.style.opacity = '1';
    }, 160);
  }
}
