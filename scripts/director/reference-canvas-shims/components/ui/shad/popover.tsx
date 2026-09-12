import { createContext, forwardRef, useContext, useEffect, useRef, useState, type PointerEventHandler, type PropsWithChildren, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
const PopoverContext = createContext<{ open: boolean; setOpen: (value: boolean) => void }>({ open: false, setOpen: () => undefined })
export function Popover({ children, open, onOpenChange }: PropsWithChildren<{ open?: boolean; onOpenChange?: (open: boolean) => void }>) {
  const [internal, setInternal] = useState(false)
  const actual = open ?? internal
  const setOpen = (next: boolean) => { setInternal(next); onOpenChange?.(next) }
  const rootRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!actual) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [actual])
  return <PopoverContext.Provider value={{ open: actual, setOpen }}><span ref={rootRef} className="reference-popover-root">{children}</span></PopoverContext.Provider>
}
export function PopoverTrigger({ children, asChild, className }: { children: ReactNode; asChild?: boolean; className?: string }) {
  const { open, setOpen } = useContext(PopoverContext)
  return <span className={cn('reference-popover-trigger', className)} onClick={() => setOpen(!open)} aria-expanded={open}>{children}</span>
}
export const PopoverContent = forwardRef<HTMLDivElement, PropsWithChildren<{
  className?: string
  side?: string
  align?: string
  sideOffset?: number
  container?: HTMLElement | null
  onEscapeKeyDown?: (event: KeyboardEvent) => void
  onOpenAutoFocus?: (event: Event) => void
  onCloseAutoFocus?: (event: Event) => void
  onFocusOutside?: (event: FocusEvent) => void
  onPointerDownCapture?: PointerEventHandler<HTMLDivElement>
  onPointerDown?: PointerEventHandler<HTMLDivElement>
}>>(({ children, className, side, align, container, onEscapeKeyDown, onPointerDownCapture, onPointerDown }, ref) => {
  const { open, setOpen } = useContext(PopoverContext)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      onEscapeKeyDown?.(event)
      if (!event.defaultPrevented) setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onEscapeKeyDown, open])
  if (!open) return null
  return <div ref={ref} className={cn('reference-popover-content', className)} onClick={e => e.stopPropagation()} onPointerDownCapture={onPointerDownCapture} onPointerDown={onPointerDown}><button type="button" className="reference-popover-close" onClick={() => setOpen(false)} aria-label="关闭"><X size={15} strokeWidth={2} aria-hidden="true" /></button>{children}</div>
})
PopoverContent.displayName = 'PopoverContent'
