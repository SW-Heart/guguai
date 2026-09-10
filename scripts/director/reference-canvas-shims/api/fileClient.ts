function adapter() {
  return (globalThis as any).__directorCanvasAdapter || {}
}

export const fileClient = {
  async saveUpload(payload: { base64: string; fileName: string }) {
    if (adapter().saveUpload) return adapter().saveUpload(payload)
    const bytes = Uint8Array.from(atob(payload.base64), char => char.charCodeAt(0))
    return URL.createObjectURL(new Blob([bytes]))
  },
  async saveTemp(payload: { base64: string; fileName: string }) {
    if (adapter().saveTemp) return adapter().saveTemp(payload)
    return this.saveUpload(payload)
  },
  async readBinary(path: string) {
    if (adapter().readBinary) return adapter().readBinary(path)
    const response = await fetch(path)
    return await response.arrayBuffer()
  },
}
