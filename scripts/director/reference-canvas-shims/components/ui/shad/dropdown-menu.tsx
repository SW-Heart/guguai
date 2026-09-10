import { createContext, useContext, useState, type PropsWithChildren, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
const MenuContext = createContext<{ open: boolean; setOpen: (value: boolean) => void }>({ open: false, setOpen: () => undefined })
export function DropdownMenu({ children }: PropsWithChildren) { const [open, setOpen] = useState(false); return <MenuContext.Provider value={{ open, setOpen }}><span className="reference-dropdown-root">{children}</span></MenuContext.Provider> }
export function DropdownMenuTrigger({ children }: { children: ReactNode; asChild?: boolean }) { const { setOpen } = useContext(MenuContext); return <span className="reference-dropdown-trigger" onClick={() => setOpen(true)}>{children}</span> }
export function DropdownMenuContent({ children, className }: PropsWithChildren<{ side?: string; className?: string }>) { const { open } = useContext(MenuContext); return open ? <span className={cn('reference-dropdown-content', className)}>{children}</span> : null }
export function DropdownMenuItem({ children, onClick }: PropsWithChildren<{ onClick?: () => void }>) { const { setOpen } = useContext(MenuContext); return <button className="reference-dropdown-item" onClick={() => { onClick?.(); setOpen(false) }}>{children}</button> }
