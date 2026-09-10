import type { PropsWithChildren } from 'react'
import { cn } from '@/lib/utils'
export function ButtonGroup({ children, className }: PropsWithChildren<{ className?: string }>) { return <div className={cn('reference-button-group', className)}>{children}</div> }
