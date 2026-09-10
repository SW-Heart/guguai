import { useState, type PropsWithChildren } from 'react'

export default function MyTooltip({ children, content }: PropsWithChildren<{ content?: string; side?: string }>) {
  const [open, setOpen] = useState(false)
  return <span className="reference-tooltip-wrap" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>{children}{open && content ? <span className="reference-tooltip">{content}</span> : null}</span>
}
