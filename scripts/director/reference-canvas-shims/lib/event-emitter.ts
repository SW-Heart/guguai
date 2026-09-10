type Listener = (payload: any) => void
const listeners = new Map<string, Set<Listener>>()

export const emitter = {
  on(event: string, listener: Listener) {
    const set = listeners.get(event) ?? new Set<Listener>()
    set.add(listener)
    listeners.set(event, set)
    return () => set.delete(listener)
  },
  emit(event: string, payload?: any) {
    listeners.get(event)?.forEach(listener => listener(payload))
  },
}
