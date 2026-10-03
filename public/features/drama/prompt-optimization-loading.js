// Dither field adapted for this vanilla-JS app from beUI ImageGeneration.
// Reference: https://beui.dev/components/agents/image-generation
export function createOptimizationDither(canvas, host = window) {
  let cleanup;
  return {
    start() {
      if (cleanup) return;
      const context = canvas.getContext('2d');
      if (!context) return;
      const reduce = host.matchMedia('(prefers-reduced-motion: reduce)');
      const hover = host.matchMedia('(hover: hover) and (pointer: fine)');
      let frame = 0, running = true, width = 0, height = 0, color;
      const pointer = { x:0, y:0, targetX:0, targetY:0, inside:false };
      const draw = (time = 0) => {
        if (!running) return;
        context.clearRect(0, 0, width, height);
        if (!pointer.inside || reduce.matches || !hover.matches) {
          pointer.targetX = width / 2 + (reduce.matches ? 0 : Math.sin(time / 1700) * width * .12);
          pointer.targetY = height / 2 + (reduce.matches ? 0 : Math.cos(time / 2100) * height * .1);
        }
        const follow = reduce.matches ? 1 : pointer.inside ? .16 : .045;
        pointer.x += (pointer.targetX - pointer.x) * follow;
        pointer.y += (pointer.targetY - pointer.y) * follow;
        const radius = Math.min(width, height) * .42;
        const columns = Math.ceil(width / 10) + 1, rows = Math.ceil(height / 10) + 1;
        const offsetX = (width - (columns - 1) * 10) / 2, offsetY = (height - (rows - 1) * 10) / 2;
        context.fillStyle = color;
        for (let row = 0; row < rows; row++) {
          for (let column = 0; column < columns; column++) {
            const anchorX = offsetX + column * 10, anchorY = offsetY + row * 10;
            const deltaX = anchorX - pointer.x, deltaY = anchorY - pointer.y;
            const distance = Math.hypot(deltaX, deltaY);
            const proximity = Math.max(0, 1 - distance / radius);
            const influence = proximity * proximity * (3 - 2 * proximity);
            const displacement = influence * influence * 9;
            context.globalAlpha = .13 + influence * .68;
            context.beginPath();
            context.arc(anchorX + (distance ? deltaX / distance * displacement : 0), anchorY + (distance ? deltaY / distance * displacement : 0), .65 + influence * .85, 0, Math.PI * 2);
            context.fill();
          }
        }
        context.globalAlpha = 1;
        if (!reduce.matches && !canvas.ownerDocument.hidden) frame = host.requestAnimationFrame(draw);
      };
      const redraw = () => {
        if (frame) host.cancelAnimationFrame(frame);
        frame = 0;
        draw();
      };
      const resize = () => {
        const rect = canvas.getBoundingClientRect();
        width = rect.width || 400; height = rect.height || 300;
        const dpr = Math.min(host.devicePixelRatio || 1, 2);
        canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        color = host.getComputedStyle(canvas).color;
        pointer.x = pointer.targetX = width / 2; pointer.y = pointer.targetY = height / 2;
        redraw();
      };
      const move = event => {
        if (reduce.matches || !hover.matches) return;
        const rect = canvas.getBoundingClientRect();
        pointer.inside = true;
        pointer.targetX = event.clientX - rect.left; pointer.targetY = event.clientY - rect.top;
      };
      const leave = () => { pointer.inside = false; };
      const observer = host.ResizeObserver ? new host.ResizeObserver(resize) : null;
      observer?.observe(canvas);
      if (!observer) host.addEventListener('resize', resize);
      canvas.addEventListener('pointermove', move, { passive:true });
      canvas.addEventListener('pointerleave', leave);
      reduce.addEventListener('change', redraw);
      canvas.ownerDocument.addEventListener('visibilitychange', redraw);
      cleanup = () => {
        running = false;
        if (frame) host.cancelAnimationFrame(frame);
        observer?.disconnect();
        if (!observer) host.removeEventListener('resize', resize);
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerleave', leave);
        reduce.removeEventListener('change', redraw);
        canvas.ownerDocument.removeEventListener('visibilitychange', redraw);
      };
      resize();
    },
    stop() { cleanup?.(); cleanup = null; },
  };
}
