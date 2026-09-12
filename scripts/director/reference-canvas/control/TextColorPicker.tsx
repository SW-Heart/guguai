import i18n from '@/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { RgbaColorPicker } from 'react-colorful'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/shad/popover'
import { cn } from '@/lib/utils'
import { type RgbaColor } from './StrokeControls'
import {
  CANVAS_DEFAULT_ANNOTATION_COLOR,
  CANVAS_DEFAULT_ANNOTATION_RGBA,
} from '../canvasStyleDefaults'

type TextSelectionRange = {
  from: number
  to: number
}

type EditorSelection = TextSelectionRange & {
  empty?: boolean
}

type ColorCommandChain = {
  focus(): ColorCommandChain
  setTextSelection(range: TextSelectionRange): ColorCommandChain
  setColor(color: string): ColorCommandChain
  unsetColor(): ColorCommandChain
  run(): boolean
}

export type ColorEditor = {
  state?: {
    selection?: EditorSelection
  }
  getAttributes?(name: string): Record<string, unknown>
  on?(event: 'selectionUpdate' | 'transaction', callback: () => void): void
  off?(event: 'selectionUpdate' | 'transaction', callback: () => void): void
  chain(): ColorCommandChain
}

const TEXT_PRESET_COLORS = ['#000000', '#ef4444', '#22c55e', '#1976d2']

export function applyDefaultCanvasTextColor(editor: ColorEditor): boolean {
  if (editor.state?.selection?.empty === false) return false

  const currentColor = editor.getAttributes?.('textStyle')?.color
  if (typeof currentColor === 'string' && currentColor.trim()) return false

  return editor.chain().setColor(CANVAS_DEFAULT_ANNOTATION_COLOR).run()
}

function clampColorChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)))
}

function clampAlpha(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function rgbaToHex(color: RgbaColor): string {
  const hex = (value: number) =>
    clampColorChannel(value).toString(16).padStart(2, '0')
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`
}

function rgbaToCss(color: RgbaColor): string {
  if (color.a >= 0.999) return rgbaToHex(color)

  return `rgba(${clampColorChannel(color.r)}, ${clampColorChannel(
    color.g
  )}, ${clampColorChannel(color.b)}, ${clampAlpha(color.a)})`
}

function hexToRgba(hex: string): RgbaColor {
  const value = hex.replace('#', '')
  const expanded =
    value.length === 3 || value.length === 4
      ? value
          .split('')
          .map(character => character + character)
          .join('')
      : value

  return {
    r: Number.parseInt(expanded.slice(0, 2), 16) || 0,
    g: Number.parseInt(expanded.slice(2, 4), 16) || 0,
    b: Number.parseInt(expanded.slice(4, 6), 16) || 0,
    a:
      expanded.length >= 8
        ? clampAlpha(Number.parseInt(expanded.slice(6, 8), 16) / 255)
        : 1,
  }
}

function parseDirectCssColor(value: string): RgbaColor | null {
  const normalized = value.trim().toLowerCase()
  if (/^#[0-9a-f]{3,4}$|^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(normalized)) {
    return hexToRgba(normalized)
  }

  const match = normalized.match(/^rgba?\(([^)]+)\)$/)
  if (!match) return null

  const parts = match[1].split(',').map(part => part.trim())
  if (parts.length < 3) return null

  const channels = parts.slice(0, 3).map(part => Number.parseFloat(part))
  if (channels.some(channel => !Number.isFinite(channel))) return null

  const alpha = parts[3] == null ? 1 : Number.parseFloat(parts[3])
  if (!Number.isFinite(alpha)) return null

  return {
    r: clampColorChannel(channels[0]),
    g: clampColorChannel(channels[1]),
    b: clampColorChannel(channels[2]),
    a: clampAlpha(alpha),
  }
}

function parseCssColor(value: unknown): RgbaColor | null {
  if (typeof value !== 'string' || !value.trim()) return null

  const direct = parseDirectCssColor(value)
  if (direct || typeof document === 'undefined') return direct

  const probe = document.createElement('span')
  probe.style.color = value
  probe.style.position = 'fixed'
  probe.style.pointerEvents = 'none'
  probe.style.opacity = '0'
  document.body.appendChild(probe)
  const resolved = window.getComputedStyle(probe).color
  probe.remove()

  return parseDirectCssColor(resolved)
}

function isNonEmptySelection(
  selection: EditorSelection | null | undefined
): selection is TextSelectionRange {
  return Boolean(
    selection && selection.empty !== true && selection.from !== selection.to
  )
}

export function TextColorPicker({ editor }: { editor: ColorEditor }) {
  const [color, setColor] = useState<RgbaColor>({
    ...CANVAS_DEFAULT_ANNOTATION_RGBA,
  })
  const [hexInput, setHexInput] = useState(
    CANVAS_DEFAULT_ANNOTATION_COLOR.slice(1)
  )
  const [open, setOpen] = useState(false)
  const [popoverContainer, setPopoverContainer] = useState<HTMLElement | null>(
    null
  )
  const selectionRef = useRef<TextSelectionRange | null>(null)
  const preserveSelectionRef = useRef(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setPopoverContainer(
      triggerRef.current?.closest<HTMLElement>('.rich-text-bubble-menu') ??
        document.getElementById('rich-text-html-element')
    )
  }, [])

  const syncSelection = useCallback(() => {
    const selection = editor.state?.selection
    if (isNonEmptySelection(selection)) {
      selectionRef.current = {
        from: selection.from,
        to: selection.to,
      }
      return selectionRef.current
    }

    if (!preserveSelectionRef.current) {
      selectionRef.current = null
    }
    return selectionRef.current
  }, [editor])

  const syncColorFromEditor = useCallback(() => {
    const editorColor = editor.getAttributes?.('textStyle')?.color
    const nextColor = parseCssColor(editorColor) ?? {
      ...CANVAS_DEFAULT_ANNOTATION_RGBA,
    }

    setColor(nextColor)
    setHexInput(rgbaToHex(nextColor).slice(1))
  }, [editor])

  useEffect(() => {
    const handleSelectionUpdate = () => {
      syncSelection()
      applyDefaultCanvasTextColor(editor)
      syncColorFromEditor()
    }
    const handleTransaction = () => {
      applyDefaultCanvasTextColor(editor)
      syncColorFromEditor()
    }

    handleSelectionUpdate()
    editor.on?.('selectionUpdate', handleSelectionUpdate)
    editor.on?.('transaction', handleTransaction)

    return () => {
      editor.off?.('selectionUpdate', handleSelectionUpdate)
      editor.off?.('transaction', handleTransaction)
    }
  }, [editor, syncColorFromEditor, syncSelection])

  const applyColor = useCallback(
    (cssColor: string, focusEditor = true) => {
      const range = syncSelection()
      let chain = editor.chain()

      if (focusEditor) {
        chain = chain.focus()
      }

      if (range) {
        chain = chain.setTextSelection(range)
      }

      chain.setColor(cssColor).run()
    },
    [editor, syncSelection]
  )

  const handlePickerChange = useCallback(
    (nextColor: RgbaColor) => {
      setColor(nextColor)
      setHexInput(rgbaToHex(nextColor).slice(1))
      applyColor(rgbaToCss(nextColor), false)
    },
    [applyColor]
  )

  const handlePresetClick = useCallback(
    (hex: string) => {
      const nextColor = hexToRgba(hex)
      setColor(nextColor)
      setHexInput(hex.slice(1))
      applyColor(hex)
    },
    [applyColor]
  )

  const handleHexSubmit = useCallback(() => {
    const cleaned = hexInput.replace('#', '').slice(0, 6)
    if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
      setHexInput(rgbaToHex(color).slice(1))
      return
    }

    const nextColor = hexToRgba(`#${cleaned}`)
    setColor(nextColor)
    setHexInput(cleaned.toLowerCase())
    applyColor(rgbaToCss(nextColor), false)
  }, [applyColor, color, hexInput])

  const openPicker = useCallback(() => {
    syncSelection()
    preserveSelectionRef.current = true
    setOpen(true)
  }, [syncSelection])

  const closePicker = useCallback(() => {
    preserveSelectionRef.current = false
    setOpen(false)
  }, [])

  useEffect(() => {
    if (!open) return

    const handleDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (
        popoverRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return
      }

      closePicker()
    }

    document.addEventListener('pointerdown', handleDocumentPointerDown, true)
    return () => {
      document.removeEventListener(
        'pointerdown',
        handleDocumentPointerDown,
        true
      )
    }
  }, [closePicker, open])

  const currentHex = rgbaToHex(color).toLowerCase()

  return (
    <div className="tiptap-text-color-controls">
      <div
        className="tiptap-text-color-presets"
        role="group"
        aria-label={i18n.t('legacy:ui_ae06271de947')}
      >
        {TEXT_PRESET_COLORS.map(hex => {
          const selected = color.a >= 0.999 && currentHex === hex.toLowerCase()
          return (
            <button
              key={hex}
              type="button"
              title={hex}
              aria-label={`文字颜色 ${hex}`}
              className={cn(
                'h-5 w-5 shrink-0 rounded-full border-2 p-0 transition-transform hover:scale-110',
                selected ? 'scale-110 border-blue-500' : 'border-gray-300'
              )}
              data-active-state={selected ? 'on' : 'off'}
              onPointerDown={event => {
                syncSelection()
                event.preventDefault()
              }}
              onClick={event => {
                event.preventDefault()
                event.stopPropagation()
                handlePresetClick(hex)
              }}
              style={{ backgroundColor: hex }}
            />
          )
        })}
      </div>

      <Popover
        open={open}
        onOpenChange={nextOpen => {
          if (nextOpen) openPicker()
          else closePicker()
        }}
      >
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            className="relative flex h-[22px] w-[22px] shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-gray-300 p-0 transition-transform hover:scale-110"
            aria-label={i18n.t('legacy:ui_3f87c7ef2086')}
            title={i18n.t('legacy:ui_3f87c7ef2086')}
            onPointerDown={event => {
              syncSelection()
              event.preventDefault()
            }}
            onClick={event => {
              event.preventDefault()
              event.stopPropagation()
              if (open) {
                closePicker()
              } else {
                openPicker()
              }
            }}
          >
            <span
              className="absolute inset-0"
              style={{
                background:
                  'conic-gradient(hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%), hsl(180,100%,50%), hsl(240,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%))',
              }}
            />
            <span
              className="absolute inset-0"
              style={{
                background:
                  'radial-gradient(circle, white 0%, transparent 65%)',
              }}
            />
          </button>
        </PopoverTrigger>

        <PopoverContent
          ref={popoverRef}
          container={popoverContainer}
          side="top"
          sideOffset={8}
          className="custom-color-popover w-auto rounded-lg border border-border bg-popover p-3 shadow-xl"
          onOpenAutoFocus={event => event.preventDefault()}
          onCloseAutoFocus={event => event.preventDefault()}
          onFocusOutside={event => event.preventDefault()}
          onEscapeKeyDown={event => {
            event.preventDefault()
            closePicker()
          }}
          onPointerDownCapture={event => {
            preserveSelectionRef.current = true
            syncSelection()
            event.stopPropagation()
          }}
          onPointerDown={event => event.stopPropagation()}
          onMouseDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
        >
          <div>
            <RgbaColorPicker color={color} onChange={handlePickerChange} />
          </div>

          <div className="mt-3 flex items-center gap-2">
            <span
              className="h-6 w-6 shrink-0 rounded-full border border-border"
              aria-label={i18n.t('legacy:ui_ca013a826850')}
              style={{ backgroundColor: rgbaToCss(color) }}
            />
            <label className="flex min-w-0 flex-1 items-center rounded-md bg-muted px-2 py-1 text-xs">
              <span className="mr-1 text-muted-foreground">#</span>
              <input
                value={hexInput}
                aria-label={i18n.t('legacy:ui_56f073f18ddc')}
                onChange={event =>
                  setHexInput(
                    event.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6)
                  )
                }
                onBlur={handleHexSubmit}
                onKeyDown={event => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  handleHexSubmit()
                }}
                className="min-w-0 flex-1 border-none bg-transparent font-mono text-xs outline-none"
              />
            </label>
            <span className="min-w-[44px] rounded-md bg-muted px-2 py-1 text-center text-xs tabular-nums">
              {Math.round(color.a * 100)}%
            </span>
          </div>

          <button
            type="button"
            onPointerDown={event => {
              preserveSelectionRef.current = true
              syncSelection()
              event.preventDefault()
            }}
            onClick={() => {
              const range = syncSelection()
              let chain = editor.chain()
              if (range) {
                chain = chain.setTextSelection(range)
              }
              chain.unsetColor().run()
            }}
            className="mt-2 w-full rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
          >
            {i18n.t('legacy:ui_7a4defe30aca')}
          </button>
        </PopoverContent>
      </Popover>
    </div>
  )
}
