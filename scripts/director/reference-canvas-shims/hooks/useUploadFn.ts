export function useUploadFn() {
  return async ({ file, fileName, task_id }: { file: File; fileName: string; task_id?: string }) => {
    const adapter = (globalThis as any).__directorCanvasAdapter || {}
    if (adapter.uploadFile) return adapter.uploadFile({ file, fileName, task_id })
    const base64 = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())))
    return adapter.saveUpload?.({ base64, fileName }) || URL.createObjectURL(file)
  }
}
