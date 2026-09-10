const FALLBACKS: Record<string, string> = {
  'common:input.placeholderEdit': '编辑画布内容…',
  'common:canvas.shortcuts.doubleClickCanvas': '双击画布',
  'common:canvas.shortcuts.doubleClickCanvasDescription': '双击空白处创建文字',
  'common:canvas.shortcuts.dragImage': '拖入图片',
  'common:canvas.shortcuts.dragImageDescription': '把本地图片拖到画布',
}

const i18n = {
  language: 'zh-CN',
  t(key: string, options?: { defaultValue?: string }) {
    return options?.defaultValue ?? FALLBACKS[key] ?? key.split(':').at(-1) ?? key
  },
  changeLanguage: async () => undefined,
}

export default i18n
