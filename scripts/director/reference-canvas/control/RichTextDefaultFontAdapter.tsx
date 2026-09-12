import i18n from '@/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import {
  CANVAS_DEFAULT_FONT_FAMILY,
  CANVAS_FONT_OPTIONS,
  getCanvasFontFamily,
  loadCanvasDefaultFont,
  shouldUseCanvasDefaultFont,
} from '../canvasFonts'

type TextSelectionRange = {
  from: number
  to: number
}

type FontCommandChain = {
  focus(): FontCommandChain
  setTextSelection(range: TextSelectionRange): FontCommandChain
  setFontFamily(fontFamily: string): FontCommandChain
  run(): boolean
}

type RichTextFontEditor = {
  state?: {
    selection?: {
      empty?: boolean
      from?: number
      to?: number
    }
  }
  getAttributes?(name: string): Record<string, any>
  commands?: {
    setFontFamily(fontFamily: string): boolean
  }
  on?(event: 'selectionUpdate' | 'transaction', callback: () => void): void
  off?(event: 'selectionUpdate' | 'transaction', callback: () => void): void
  chain(): FontCommandChain
}

function getFontFamily(editor: RichTextFontEditor): string | undefined {
  return editor.getAttributes?.('textStyle')?.fontFamily
}

function getSelectedRange(
  editor: RichTextFontEditor
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

function applyDefaultFontAtCursor(editor: RichTextFontEditor): void {
  if (editor.state?.selection?.empty === false) return
  if (!shouldUseCanvasDefaultFont(getFontFamily(editor))) return

  editor.commands?.setFontFamily(CANVAS_DEFAULT_FONT_FAMILY)
}

export function RichTextDefaultFontAdapter({
  editor,
}: {
  editor: RichTextFontEditor
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const selectionRef = useRef<TextSelectionRange | null>(null)
  const [open, setOpen] = useState(false)
  const [selectedFontFamily, setSelectedFontFamily] = useState(() =>
    getCanvasFontFamily(getFontFamily(editor))
  )

  const syncSelectedFontFamily = useCallback(() => {
    setSelectedFontFamily(getCanvasFontFamily(getFontFamily(editor)))
  }, [editor])

  const rememberSelection = useCallback(() => {
    selectionRef.current = getSelectedRange(editor)
  }, [editor])

  const applySelectedFont = useCallback(
    (fontFamily: string) => {
      let chain = editor.chain().focus()
      if (selectionRef.current) {
        chain = chain.setTextSelection(selectionRef.current)
      }
      chain.setFontFamily(fontFamily).run()
      setSelectedFontFamily(fontFamily)
      selectionRef.current = null
      setOpen(false)
    },
    [editor]
  )

  useEffect(() => {
    void loadCanvasDefaultFont()
    applyDefaultFontAtCursor(editor)
    rememberSelection()
    syncSelectedFontFamily()

    const handleEditorUpdate = () => {
      applyDefaultFontAtCursor(editor)
      rememberSelection()
      syncSelectedFontFamily()
    }
    editor.on?.('selectionUpdate', handleEditorUpdate)
    editor.on?.('transaction', handleEditorUpdate)

    return () => {
      editor.off?.('selectionUpdate', handleEditorUpdate)
      editor.off?.('transaction', handleEditorUpdate)
    }
  }, [editor, rememberSelection, syncSelectedFontFamily])

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

  const selectedOption =
    CANVAS_FONT_OPTIONS.find(option => option.value === selectedFontFamily) ??
    CANVAS_FONT_OPTIONS[0]

  return (
    <div
      ref={rootRef}
      className="canvas-rich-text-select canvas-rich-text-font-select"
    >
      <button
        type="button"
        className="canvas-rich-text-select-trigger"
        aria-label={i18n.t('legacy:ui_b50d4d8352f5')}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="字体"
        onPointerDown={event => {
          event.preventDefault()
          rememberSelection()
        }}
        onClick={() => setOpen(value => !value)}
        style={{ fontFamily: selectedFontFamily }}
      >
        <span className="canvas-rich-text-select-value">
          {selectedOption.label}
        </span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <div className="canvas-rich-text-select-menu" role="listbox">
          {CANVAS_FONT_OPTIONS.map(option => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === selectedFontFamily}
              className="canvas-rich-text-select-option"
              style={{ fontFamily: option.value }}
              onPointerDown={event => event.preventDefault()}
              onClick={() => applySelectedFont(option.value)}
            >
              <span>{option.label}</span>
              <span className="canvas-rich-text-font-preview">字 Aa</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
