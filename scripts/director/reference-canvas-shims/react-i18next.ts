import i18n from './i18n'

export function useTranslation() {
  return { t: i18n.t, i18n }
}

export function I18nextProvider({ children }: { children: any }) {
  return children
}
