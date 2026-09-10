import { createContext, useContext, type PropsWithChildren } from 'react'

const RuntimeContext = createContext({ runtimeId: 'director-canvas', active: true })

export function ViewerRuntimeProvider({ runtimeId = 'director-canvas', active = true, children }: PropsWithChildren<{ runtimeId?: string; active?: boolean }>) {
  return <RuntimeContext.Provider value={{ runtimeId, active }}>{children}</RuntimeContext.Provider>
}

export function useViewerRuntime() {
  return useContext(RuntimeContext)
}

export function useViewerRuntimeDomId(suffix: string) {
  const { runtimeId } = useViewerRuntime()
  return `${runtimeId}-${suffix}`
}

export const ViewerRuntimeContext = RuntimeContext
