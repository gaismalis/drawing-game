// Calm floating-dots mesh behind the UI. Dots drift slowly, link up when close,
// and gently move away from the finger / mouse.
(() => {
  const canvas = document.getElementById('bg');
  const ctx = canvas.getContext('2d');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const COLORS = ['255,255,255', '205,180,219', '162,210,255', '255,175,204'];
  const LINK_DIST = 120;
  const POINTER_RADIUS = 140;

  let w, h, dots = [];
  const pointer = { x: -9999, y: -9999, strength: 0, active: false };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.round(Math.min(80, Math.max(30, (w * h) / 12000)));
    while (dots.length < count) dots.push(newDot());
    dots.length = count;
  }

  function newDot() {
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.08 + Math.random() * 0.17;
    return {
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      r: 1.5 + Math.random() * 2.5,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    };
  }

  function step() {
    // Pointer influence fades in while touching/moving and fades out afterwards.
    pointer.strength += ((pointer.active ? 1 : 0) - pointer.strength) * 0.08;

    for (const d of dots) {
      const dx = d.x - pointer.x;
      const dy = d.y - pointer.y;
      const dist = Math.hypot(dx, dy);
      if (dist < POINTER_RADIUS && dist > 0.1) {
        const push = (1 - dist / POINTER_RADIUS) * 0.6 * pointer.strength;
        d.x += (dx / dist) * push;
        d.y += (dy / dist) * push;
      }
      d.x += d.vx;
      d.y += d.vy;
      if (d.x < -10) d.x = w + 10;
      if (d.x > w + 10) d.x = -10;
      if (d.y < -10) d.y = h + 10;
      if (d.y > h + 10) d.y = -10;
    }
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 1;
    for (let i = 0; i < dots.length; i++) {
      const a = dots[i];
      for (let j = i + 1; j < dots.length; j++) {
        const b = dots[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist < LINK_DIST) {
          ctx.strokeStyle = `rgba(255,255,255,${(1 - dist / LINK_DIST) * 0.45})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      if (pointer.strength > 0.02) {
        const dist = Math.hypot(a.x - pointer.x, a.y - pointer.y);
        if (dist < POINTER_RADIUS * 1.3) {
          ctx.strokeStyle = `rgba(255,255,255,${(1 - dist / (POINTER_RADIUS * 1.3)) * 0.6 * pointer.strength})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(pointer.x, pointer.y);
          ctx.stroke();
        }
      }
    }
    for (const d of dots) {
      ctx.fillStyle = `rgba(${d.color},0.85)`;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  let running = false;
  function frame() {
    if (!running) return;
    step();
    draw();
    requestAnimationFrame(frame);
  }
  function start() {
    if (running || reduceMotion) return;
    running = true;
    requestAnimationFrame(frame);
  }

  function setPointer(e) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.active = true;
  }
  window.addEventListener('pointermove', setPointer, { passive: true });
  window.addEventListener('pointerdown', setPointer, { passive: true });
  window.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') pointer.active = false; });
  window.addEventListener('pointercancel', () => (pointer.active = false));
  document.addEventListener('pointerleave', () => (pointer.active = false));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) running = false;
    else start();
  });
  window.addEventListener('resize', resize);

  resize();
  draw();
  start();
})();
