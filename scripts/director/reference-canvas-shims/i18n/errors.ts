export function getLocalizedErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '操作失败')
}
