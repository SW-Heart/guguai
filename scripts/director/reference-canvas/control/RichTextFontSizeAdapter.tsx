import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'

type TextSelectionRange = {
  from: number
  to: number
}

type FontSizeCommandChain = {
  focus(): FontSizeCommandChain
  setTextSelection(range: TextSelectionRange): FontSizeCommandChain
  setFontSize(fontSize: string): FontSizeCommandChain
  run(): boolean
}

type RichTextFontSizeEditor = {
  state?: {
    selection?: {
      empty?: boolean
      from?: number
      to?: number
    }
  }
  getAttributes?(name: string): Record<string, any>
  on?(event: 'selectionUpdate' | 'transaction', callback: () => void): void
  off?(event: 'selectionUpdate' | 'transaction', callback: () => void): void
  chain(): FontSizeCommandChain
}

const FONT_SIZE_OPTIONS = [
  '10px',
  '11px',
  '12px',
  '14px',
  '16px',
  '18px',
  '20px',
  '24px',
  '28px',
  '32px',
  '36px',
  '48px',
  '64px',
  '72px',
] as const

function getSelectedRange(
  editor: RichTextFontSizeEditor
): TextSelectionRange | null {
  const selection = editor.state?.selection
  if (
    !selection ||
    selection.empty !== false ||
    typeof selection.from !== 'number' ||
    typeof selection.to !== 'number' ||
    selection.from === selection.to
  ) {
    return null
  }

  return { from: selection.from, to: selection.to }
}

function previewFontSize(value: string): string {
  const size = Number.parseInt(value, 10)
  return `${Math.min(20, Math.max(12, 12 + (size - 12) * 0.16))}px`
}

export function RichTextFontSizeAdapter({
  editor,
}: {
  editor: RichTextFontSizeEditor
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const selectionRef = useRef<TextSelectionRange | null>(null)
  const [open, setOpen] = useState(false)
  const [selectedFontSize, setSelectedFontSize] = useState('16px')

  const rememberSelection = useCallback(() => {
    selectionRef.current = getSelectedRange(editor)
  }, [editor])

  const syncSelectedFontSize = useCallback(() => {
    const fontSize = editor.getAttributes?.('textStyle')?.fontSize
    setSelectedFontSize(
      typeof fontSize === 'string' &&
        FONT_SIZE_OPTIONS.includes(fontSize as (typeof FONT_SIZE_OPTIONS)[number])
        ? fontSize
        : '16px'
    )
  }, [editor])

  const applySelectedFontSize = useCallback(
    (fontSize: string) => {
      let chain = editor.chain().focus()
      if (selectionRef.current) {
        chain = chain.setTextSelection(selectionRef.current)
      }
      chain.setFontSize(fontSize).run()
      setSelectedFontSize(fontSize)
      selectionRef.current = null
      setOpen(false)
    },
    [editor]
  )

  useEffect(() => {
    rememberSelection()
    syncSelectedFontSize()
    const handleEditorUpdate = () => {
      rememberSelection()
      syncSelectedFontSize()
    }
    editor.on?.('selectionUpdate', handleEditorUpdate)
    editor.on?.('transaction', handleEditorUpdate)
    return () => {
      editor.off?.('selectionUpdate', handleEditorUpdate)
      editor.off?.('transaction', handleEditorUpdate)
    }
  }, [editor, rememberSelection, syncSelectedFontSize])

  useEffect(() => {
    if (!open) return

    const handleDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && rootRef.current?.contains(target)) return
      setOpen(false)
    }

    document.addEventListener('pointerdown', handleDocumentPointerDown, true)
    return () =>
      document.removeEventListener(
        'pointerdown',
        handleDocumentPointerDown,
        true
      )
  }, [open])

  return (
    <div
      ref={rootRef}
      className="canvas-rich-text-select canvas-rich-text-size-select"
    >
      <button
        type="button"
        className="canvas-rich-text-select-trigger"
        aria-label="字号"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="字号"
        onPointerDown={event => {
          event.preventDefault()
          rememberSelection()
        }}
        onClick={() => setOpen(value => !value)}
      >
        <span className="canvas-rich-text-select-value">
          {selectedFontSize.replace('px', '')}
        </span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <div className="canvas-rich-text-select-menu" role="listbox">
          {FONT_SIZE_OPTIONS.map(option => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={option === selectedFontSize}
              className="canvas-rich-text-select-option canvas-rich-text-size-option"
              onPointerDown={event => event.preventDefault()}
              onClick={() => applySelectedFontSize(option)}
            >
              <span style={{ fontSize: previewFontSize(option) }}>
                {option.replace('px', '')}
              </span>
              <span className="canvas-rich-text-size-preview">Aa</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
