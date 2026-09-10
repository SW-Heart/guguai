import { createContext, useContext, useState, type PropsWithChildren, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
const SheetContext = createContext<{ open: boolean; setOpen: (value: boolean) => void }>({ open: false, setOpen: () => undefined })
export function Sheet({ children, open: controlled, onOpenChange }: PropsWithChildren<{ open?: boolean; onOpenChange?: (open: boolean) => void }>) { const [internal, setInternal] = useState(false); const open = controlled ?? internal; const setOpen = (next: boolean) => { setInternal(next); onOpenChange?.(next) }; return <SheetContext.Provider value={{ open, setOpen }}><span className="reference-sheet-root">{children}</span></SheetContext.Provider> }
export function SheetTrigger({ children }: { children: ReactNode; asChild?: boolean }) { const { setOpen } = useContext(SheetContext); return <span onClick={() => setOpen(true)}>{children}</span> }
export function SheetContent({ children, className }: PropsWithChildren<{ side?: string; className?: string }>) { const { open, setOpen } = useContext(SheetContext); if (!open) return null; return <div className={cn('reference-sheet-content', className)}><button onClick={() => setOpen(false)} className="reference-sheet-close">×</button>{children}</div> }
export function SheetHeader({ children }: PropsWithChildren) { return <div className="reference-sheet-header">{children}</div> }
export function SheetTitle({ children }: PropsWithChildren) { return <h2 className="reference-sheet-title">{children}</h2> }
