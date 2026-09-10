const sessions = new Map<string, { messages: any[]; listeners: Set<() => void> }>()

export function getOrCreateSession(key: string) {
  let session = sessions.get(key)
  if (!session) {
    session = { messages: [], listeners: new Set() }
    sessions.set(key, session)
  }
  return session
}

export function subscribeSession(key: string, listener: () => void) {
  const session = getOrCreateSession(key)
  session.listeners.add(listener)
  return () => session.listeners.delete(listener)
}

export function pushSessionMessage(key: string, message: any) {
  const session = getOrCreateSession(key)
  session.messages.push(message)
  session.listeners.forEach(listener => listener())
}
