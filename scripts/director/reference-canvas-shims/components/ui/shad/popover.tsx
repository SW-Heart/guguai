import { createContext, useContext, useState, type PropsWithChildren, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
const PopoverContext = createContext<{ open: boolean; setOpen: (value: boolean) => void }>({ open: false, setOpen: () => undefined })
export function Popover({ children, open, onOpenChange }: PropsWithChildren<{ open?: boolean; onOpenChange?: (open: boolean) => void }>) {
  const [internal, setInternal] = useState(false)
  const actual = open ?? internal
  const setOpen = (next: boolean) => { setInternal(next); onOpenChange?.(next) }
  return <PopoverContext.Provider value={{ open: actual, setOpen }}><span className="reference-popover-root">{children}</span></PopoverContext.Provider>
}
export function PopoverTrigger({ children, asChild }: { children: ReactNode; asChild?: boolean }) { const { setOpen } = useContext(PopoverContext); return <span className="reference-popover-trigger" onClick={() => setOpen(true)}>{children}</span> }
export function PopoverContent({ children, className, side, align }: PropsWithChildren<{ className?: string; side?: string; align?: string }>) { const { open, setOpen } = useContext(PopoverContext); if (!open) return null; return <span className={cn('reference-popover-content', className)} onClick={e => e.stopPropagation()}><button className="reference-popover-close" onClick={() => setOpen(false)} aria-label="关闭">×</button>{children}</span> }
