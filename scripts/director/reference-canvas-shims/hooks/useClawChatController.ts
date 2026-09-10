export function sendClawChatMessage(sessionKey: string, message: string, files?: any[]) {
  return (globalThis as any).__directorCanvasAdapter?.sendMessage?.(message, files, sessionKey)
}
