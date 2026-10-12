"use client";
// beui.dev/components/motion/tilt-card — adapted from the supplied source.
import { motion, useMotionTemplate, useMotionValue, useReducedMotion, useSpring } from 'motion/react';
import { useEffect, useRef } from 'react';
import { SPRING_MOUSE } from '../lib/ease.js';
import { useHoverCapable } from '../hooks/use-hover-capable.js';

export function TiltCard({ children, max = 12, glare = true, className }) {
  const ref = useRef(null);
  const reduce = useReducedMotion();
  const canHover = useHoverCapable();
  const enabled = !reduce && canHover;
  const rx = useMotionValue(0), ry = useMotionValue(0);
  const gx = useMotionValue(50), gy = useMotionValue(50);
  const srx = useSpring(rx, SPRING_MOUSE), sry = useSpring(ry, SPRING_MOUSE);
  const transform = useMotionTemplate`perspective(1000px) rotateX(${srx}deg) rotateY(${sry}deg)`;
  const glareBg = useMotionTemplate`radial-gradient(circle at ${gx}% ${gy}%, var(--theme-highlight, #fff), transparent 50%)`;
  const onLeave = () => { rx.set(0); ry.set(0); };
  useEffect(() => {
    if (!enabled) { rx.set(0); ry.set(0); srx.jump(0); sry.jump(0); }
  }, [enabled, rx, ry, srx, sry]);
  useEffect(() => {
    const reset = () => { rx.set(0); ry.set(0); };
    window.addEventListener('blur', reset);
    return () => window.removeEventListener('blur', reset);
  }, [rx, ry]);
  const onMove = event => {
    if (!ref.current || !enabled) return;
    const rect = ref.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const py = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    ry.set((px - .5) * max); rx.set((.5 - py) * max);
    gx.set(px * 100); gy.set(py * 100);
  };
  return <motion.div ref={ref} onMouseMove={onMove} onMouseLeave={onLeave}
    style={{ transform: enabled ? transform : 'none', transformStyle: 'preserve-3d' }}
    className={className}>
    {children}
    {glare && enabled ? <motion.div aria-hidden="true" className="create-home-tilt-glare" style={{ background: glareBg }} /> : null}
  </motion.div>;
}
