import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type PropsWithChildren, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
const SheetContext = createContext<{ open: boolean; setOpen: (value: boolean) => void }>({ open: false, setOpen: () => undefined })
export function Sheet({ children, open: controlled, onOpenChange }: PropsWithChildren<{ open?: boolean; onOpenChange?: (open: boolean) => void }>) { const [internal, setInternal] = useState(false); const open = controlled ?? internal; const setOpen = (next: boolean) => { setInternal(next); onOpenChange?.(next) }; return <SheetContext.Provider value={{ open, setOpen }}><span className="reference-sheet-root">{children}</span></SheetContext.Provider> }
export function SheetTrigger({ children }: { children: ReactNode; asChild?: boolean }) { const { open, setOpen } = useContext(SheetContext); return <span onClick={() => setOpen(!open)} aria-expanded={open}>{children}</span> }
export function SheetContent({ children, className, side, style, container, showOverlay, onInteractOutside }: PropsWithChildren<{ side?: string; className?: string; style?: CSSProperties; container?: HTMLElement | null; showOverlay?: boolean; onInteractOutside?: (event: PointerEvent) => void }>) {
  const { open, setOpen } = useContext(SheetContext)
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    const onPointerDown = (event: PointerEvent) => {
      if (contentRef.current && !contentRef.current.contains(event.target as Node)) {
        onInteractOutside?.(event)
        if (!event.defaultPrevented) setOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, onInteractOutside])
  if (!open) return null
  const content = <div ref={contentRef} className={cn('reference-sheet-content', className)} style={style}><button type="button" onClick={() => setOpen(false)} className="reference-sheet-close" aria-label="关闭"><X size={16} strokeWidth={2} aria-hidden="true" /></button>{children}</div>
  return container ? createPortal(content, container) : content
}
export function SheetHeader({ children, className }: PropsWithChildren<{ className?: string }>) { return <div className={cn('reference-sheet-header', className)}>{children}</div> }
export function SheetTitle({ children, className }: PropsWithChildren<{ className?: string }>) { return <h2 className={cn('reference-sheet-title', className)}>{children}</h2> }
