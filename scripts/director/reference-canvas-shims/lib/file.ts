export function arrayBufferToBase64(input: ArrayBuffer): string {
  let binary = ''
  const bytes = new Uint8Array(input)
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function base64ToFile(value: string, name: string): File {
  const [, data = value] = value.split(',')
  const binary = atob(data)
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  return new File([bytes], name, { type: value.startsWith('data:') ? value.slice(5, value.indexOf(';')) : 'image/png' })
}

export async function xhrDownload(url: string, fileName?: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`下载失败（${response.status}）`)
  const blob = await response.blob()
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = fileName || 'canvas-export'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}

export function escapeWindowsPath(path: string) {
  return path
}
