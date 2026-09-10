import i18n from '@/i18n'
import { useCallback, useEffect, useState } from 'react'
import {
  CANVAS_DEFAULT_FONT_FAMILY,
  CANVAS_FONT_OPTIONS,
  getCanvasFontFamily,
  loadCanvasDefaultFont,
  shouldUseCanvasDefaultFont,
} from '../canvasFonts'

type RichTextFontEditor = {
  state?: {
    selection?: {
      empty?: boolean
    }
  }
  getAttributes?(name: string): Record<string, any>
  commands?: {
    setFontFamily(fontFamily: string): boolean
  }
  on?(event: 'selectionUpdate' | 'transaction', callback: () => void): void
  off?(event: 'selectionUpdate' | 'transaction', callback: () => void): void
  chain(): {
    focus(): {
      setFontFamily(fontFamily: string): { run(): boolean }
    }
  }
}

function getFontFamily(editor: RichTextFontEditor): string | undefined {
  return editor.getAttributes?.('textStyle')?.fontFamily
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
  const [selectedFontFamily, setSelectedFontFamily] = useState(() =>
    getCanvasFontFamily(getFontFamily(editor))
  )

  const syncSelectedFontFamily = useCallback(() => {
    setSelectedFontFamily(getCanvasFontFamily(getFontFamily(editor)))
  }, [editor])

  const applySelectedFont = useCallback(
    (fontFamily: string) => {
      setSelectedFontFamily(fontFamily)
      editor.chain().focus().setFontFamily(fontFamily).run()
    },
    [editor]
  )

  useEffect(() => {
    void loadCanvasDefaultFont()
    applyDefaultFontAtCursor(editor)
    syncSelectedFontFamily()

    const handleEditorUpdate = () => {
      applyDefaultFontAtCursor(editor)
      syncSelectedFontFamily()
    }
    editor.on?.('selectionUpdate', handleEditorUpdate)
    editor.on?.('transaction', handleEditorUpdate)

    return () => {
      editor.off?.('selectionUpdate', handleEditorUpdate)
      editor.off?.('transaction', handleEditorUpdate)
    }
  }, [editor, syncSelectedFontFamily])

  return (
    <select
      aria-label={i18n.t('legacy:ui_b50d4d8352f5')}
      className="font-family-select canvas-font-family-select"
      value={selectedFontFamily}
      onChange={event => applySelectedFont(event.target.value)}
      style={{ fontFamily: selectedFontFamily }}
    >
      {CANVAS_FONT_OPTIONS.map(option => (
        <option
          key={option.value}
          value={option.value}
          style={{ fontFamily: option.value }}
        >
          {option.label}
        </option>
      ))}
    </select>
  )
}
