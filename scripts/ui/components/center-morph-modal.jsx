"use client";
// Center-unfold animation from the supplied beUI CenterMorphModal.
// A native dialog retains top-layer focus containment throughout the exit.
import { AnimatePresence, motion, useAnimationControls, useIsPresent, useReducedMotion } from 'motion/react';
import { useEffect, useRef } from 'react';

export const CENTER_FOLDED_CLIP = 'inset(48% 48% 48% 48% round 30px)';
export const CENTER_OPEN_CLIP = 'inset(0% 0% 0% 0% round 30px)';
export const CENTER_UNFOLD_TRANSITION = { duration: .43, ease: [.2, 0, .2, 1] };

export function morphOffset(rect, origin) {
  return origin ? { x: origin.x - rect.left - rect.width / 2, y: origin.y - rect.top - rect.height / 2 } : { x: 0, y: 0 };
}

function ModalSurface({ children, onClose, origin, getOrigin }) {
  const isPresent = useIsPresent();
  const reduce = useReducedMotion();
  const panel = useRef(null);
  const center = useRef(null);
  const controls = useAnimationControls();
  useEffect(() => {
    if (!isPresent) return;
    const frame = requestAnimationFrame(() => {
      if (!panel.current) return;
      center.current = panel.current.getBoundingClientRect();
      const offset = reduce ? { x: 0, y: 0 } : morphOffset(center.current, origin);
      controls.set({ ...offset, opacity: reduce ? 0 : 1, clipPath: reduce ? CENTER_OPEN_CLIP : CENTER_FOLDED_CLIP });
      void controls.start({ x: 0, y: 0, opacity: 1, clipPath: CENTER_OPEN_CLIP });
    });
    return () => cancelAnimationFrame(frame);
  }, [controls, origin, reduce, isPresent]);
  return <>
    <motion.button type="button" aria-label="关闭弹窗" tabIndex={-1}
      disabled={!isPresent} className="center-morph-backdrop"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: reduce ? .1 : .28, ease: [.22, 1, .36, 1] }}
      onClick={onClose} />
    <div className="center-morph-layer" inert={!isPresent}>
      <div className="center-morph-position">
        <motion.div ref={panel} className="project-type-dialog center-morph-panel"
          initial={{ opacity: 0, clipPath: reduce ? CENTER_OPEN_CLIP : CENTER_FOLDED_CLIP }}
          animate={controls}
          variants={{ retract: () => ({
            ...(reduce || !center.current ? { x: 0, y: 0 } : morphOffset(center.current, getOrigin?.() || origin)),
            opacity: reduce ? 0 : 1, clipPath: reduce ? CENTER_OPEN_CLIP : CENTER_FOLDED_CLIP,
          }) }}
          exit="retract"
          transition={reduce ? { duration: .14 } : CENTER_UNFOLD_TRANSITION}>
          {children}
        </motion.div>
      </div>
    </div>
  </>;
}

export function CenterMorphModal({ open, onClose, onExitComplete, children, ariaLabel, origin, getOrigin }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    const frame = requestAnimationFrame(() => dialog.querySelector('[data-project-type]')?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(frame);
      dialog.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);
  return <dialog ref={ref} className="center-morph-dialog" aria-label={ariaLabel}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <AnimatePresence onExitComplete={onExitComplete}>
      {open ? <ModalSurface key="surface" onClose={onClose} origin={origin} getOrigin={getOrigin}>{children}</ModalSurface> : null}
    </AnimatePresence>
  </dialog>;
}
