export const runtimeClient = {
  isShellRuntime: () => true,
  async request(...args: any[]) {
    return (globalThis as any).__directorCanvasAdapter?.runtimeRequest?.(...args)
  },
}
