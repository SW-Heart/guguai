import i18n from '@/i18n'
export const CANVAS_DEFAULT_FONT_FAMILY = 'Xiaolai SC'
export const CANVAS_DEFAULT_FONT_LABEL = '小赖字体'

export const CANVAS_FONT_OPTIONS = [
  {
    label: CANVAS_DEFAULT_FONT_LABEL,
    value: CANVAS_DEFAULT_FONT_FAMILY,
  },
  { label: i18n.t('legacy:ui_b07d560a7cba'), value: 'LXGWWenKai' },
  { label: i18n.t('legacy:ui_927122dc7999'), value: 'SimSun, STSong' },
  { label: i18n.t('legacy:ui_348fef8d5213'), value: 'KaiTi, STKaiti' },
  { label: 'Inter', value: 'Inter, sans-serif' },
  { label: 'Comic Sans', value: '"Comic Sans MS", cursive' },
  { label: 'Serif', value: 'serif' },
  { label: 'Monospace', value: 'monospace' },
  { label: 'Cursive', value: 'cursive' },
] as const

let canvasDefaultFontLoadPromise: Promise<void> | null = null

function normalizeFontFamily(fontFamily: string): string {
  return fontFamily
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function shouldUseCanvasDefaultFont(
  fontFamily: string | null | undefined
): boolean {
  return !fontFamily?.trim()
}

export function getCanvasFontFamily(
  fontFamily: string | null | undefined
): string {
  if (!fontFamily) return CANVAS_DEFAULT_FONT_FAMILY

  const normalizedFontFamily = normalizeFontFamily(fontFamily)
  return (
    CANVAS_FONT_OPTIONS.find(
      option => normalizeFontFamily(option.value) === normalizedFontFamily
    )?.value ?? CANVAS_DEFAULT_FONT_FAMILY
  )
}

export function loadCanvasDefaultFont(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) {
    return Promise.resolve()
  }

  if (!canvasDefaultFontLoadPromise) {
    canvasDefaultFontLoadPromise = document.fonts
      .load(`16px "${CANVAS_DEFAULT_FONT_FAMILY}"`)
      .then(() => undefined)
      .catch(() => undefined)
  }

  return canvasDefaultFontLoadPromise
}
