import i18n from '@/i18n'
import { Slider } from '@/components/ui/shad/slider'
import { RgbaColorPicker } from 'react-colorful'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/shad/popover'

export interface RgbaColor {
  r: number
  g: number
  b: number
  a: number
}

export function rgbaToString(c: RgbaColor): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`
}

export const STROKE_COLORS = [
  '#000000',
  '#ffffff',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
]

export interface StrokeControlsProps {
  strokeWidth: number
  strokeColor: string
  customColor: RgbaColor
  onStrokeWidthChange: (w: number) => void
  onStrokeColorChange: (color: string) => void
  onCustomColorChange: (color: RgbaColor) => void
  /** 'horizontal' 适用于浮动面板，'vertical' 适用于 Popover（默认） */
  layout?: 'horizontal' | 'vertical'
}

export function StrokeControls({
  strokeWidth,
  strokeColor,
  customColor,
  onStrokeWidthChange,
  onStrokeColorChange,
  onCustomColorChange,
  layout = 'vertical',
}: StrokeControlsProps) {
  const displayStrokeWidth = Number.isInteger(strokeWidth)
    ? strokeWidth.toString()
    : strokeWidth.toFixed(1)

  const sliderSection = (
    <div className="flex items-center gap-2">
      <span className="min-w-[42px] whitespace-nowrap text-right text-xs tabular-nums text-gray-500">
        {displayStrokeWidth}px
      </span>
      <div className={layout === 'horizontal' ? 'w-[88px]' : 'w-[120px]'}>
        <Slider
          min={1}
          max={64}
          step={0.5}
          value={[strokeWidth]}
          onValueChange={vals =>
            onStrokeWidthChange(Array.isArray(vals) ? vals[0] : vals)
          }
        />
      </div>
    </div>
  )

  const colorSection = (
    <div className="flex items-center gap-1">
      {STROKE_COLORS.map(color => (
        <button
          key={color}
          title={color}
          onClick={() => onStrokeColorChange(color)}
          className={`w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 ${
            strokeColor === color
              ? 'border-blue-500 scale-110'
              : 'border-gray-300'
          }`}
          style={{ backgroundColor: color }}
        />
      ))}
      <Popover>
        <PopoverTrigger asChild>
          <button
            title={i18n.t('legacy:ui_5e6fcb565121')}
            className="w-[22px] h-[22px] rounded-full border-2 border-gray-300 transition-transform hover:scale-110 overflow-hidden relative"
          >
            <div
              className="absolute inset-0"
              style={{
                background:
                  'conic-gradient(hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%), hsl(180,100%,50%), hsl(240,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%))',
              }}
            />
            <div
              className="absolute inset-0"
              style={{
                background:
                  'radial-gradient(circle, white 0%, transparent 65%)',
              }}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="right"
          className="p-3 w-auto border-none shadow-xl rounded-xl bg-popover custom-color-popover"
        >
          <RgbaColorPicker
            color={customColor}
            onChange={newColor => {
              onCustomColorChange(newColor)
              onStrokeColorChange(rgbaToString(newColor))
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  )

  if (layout === 'horizontal') {
    return (
      <>
        {sliderSection}
        <div className="w-px h-5 bg-gray-200" />
        {colorSection}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {sliderSection}
      {colorSection}
    </div>
  )
}
