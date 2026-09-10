import type { ChangeEvent } from 'react'
export function Slider({ value, defaultValue, min = 0, max = 100, step = 1, onValueChange, className }: { value?: number[]; defaultValue?: number[]; min?: number; max?: number; step?: number; onValueChange?: (value: number[]) => void; className?: string }) {
  const current = value?.[0] ?? defaultValue?.[0] ?? min
  const change = (event: ChangeEvent<HTMLInputElement>) => onValueChange?.([Number(event.target.value)])
  return <input className={className} type="range" min={min} max={max} step={step} value={current} onChange={change} />
}
