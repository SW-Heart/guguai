import { createContext, useContext, useEffect, useRef, useState, type PropsWithChildren, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
const MenuContext = createContext<{ open: boolean; setOpen: (value: boolean) => void }>({ open: false, setOpen: () => undefined })
export function DropdownMenu({ children }: PropsWithChildren) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    const onPointerDown = (event: PointerEvent) => { if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])
  return <MenuContext.Provider value={{ open, setOpen }}><span ref={rootRef} className="reference-dropdown-root">{children}</span></MenuContext.Provider>
}
export function DropdownMenuTrigger({ children, asChild }: { children: ReactNode; asChild?: boolean }) { const { open, setOpen } = useContext(MenuContext); return <span className="reference-dropdown-trigger" onClick={() => setOpen(!open)} aria-expanded={open}>{children}</span> }
export function DropdownMenuContent({ children, className }: PropsWithChildren<{ side?: string; className?: string }>) { const { open } = useContext(MenuContext); return open ? <div className={cn('reference-dropdown-content', className)} onClick={e => e.stopPropagation()}>{children}</div> : null }
export function DropdownMenuItem({ children, onClick }: PropsWithChildren<{ onClick?: () => void }>) { const { setOpen } = useContext(MenuContext); return <button className="reference-dropdown-item" onClick={() => { onClick?.(); setOpen(false) }}>{children}</button> }
