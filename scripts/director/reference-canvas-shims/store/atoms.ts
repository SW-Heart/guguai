import { atom } from 'jotai'

export const currentClawSessionKeyAtom = atom<string | null>(null)
export const allIsSendingAtom = atom<Record<string, boolean>>({})
export const messageInputRefAtom = atom<any>(null)
export const drawModelPreferenceAtom = atom<any>({ mode: 'auto', mediaKind: 'image', parameters: {} })
