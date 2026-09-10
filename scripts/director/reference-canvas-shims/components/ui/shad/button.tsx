import { forwardRef, type ButtonHTMLAttributes, type PropsWithChildren } from 'react'
import { cn } from '@/lib/utils'

export const Button = forwardRef<HTMLButtonElement, PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string; asChild?: boolean }>>(({ className, variant = 'default', size = 'default', asChild, children, ...props }, ref) => {
  if (asChild && (children as any)?.type) {
    return <span className={cn('reference-button', `reference-button-${variant}`, `reference-button-${size}`, className)}>{children}</span>
  }
  return <button ref={ref} className={cn('reference-button', `reference-button-${variant}`, `reference-button-${size}`, className)} {...props}>{children}</button>
})
Button.displayName = 'Button'
