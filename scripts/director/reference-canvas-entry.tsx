import React, { useEffect, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, useSetAtom } from 'jotai'
import { CanvasPreview } from './reference-canvas/index'
import { currentClawSessionKeyAtom, messageInputRefAtom } from './reference-canvas-shims/store/atoms'
import { ViewerRuntimeProvider } from './reference-canvas-shims/components/preview/viewer/ViewerRuntimeContext'

export interface ReferenceCanvasOptions {
  sessionKey?: string | null
  adapter?: Record<string, any>
  onReady?: (api: any) => void
  onDispose?: () => void
}

function RuntimeBridge({ options, children }: PropsWithChildren<{ options: ReferenceCanvasOptions }>) {
  const setSessionKey = useSetAtom(currentClawSessionKeyAtom)
  const setMessageInput = useSetAtom(messageInputRefAtom)
  useEffect(() => {
    setSessionKey(options.sessionKey ?? null)
    setMessageInput(options.adapter?.messageInputRef ?? null)
    return () => {
      setSessionKey(null)
      setMessageInput(null)
    }
  }, [options.adapter, options.sessionKey, setMessageInput, setSessionKey])
  return <ViewerRuntimeProvider runtimeId="director-canvas" active>{children}</ViewerRuntimeProvider>
}

export function mountReferenceCanvas(container: HTMLElement, options: ReferenceCanvasOptions = {}) {
  const previousAdapter = (globalThis as any).__directorCanvasAdapter
  ;(globalThis as any).__directorCanvasAdapter = options.adapter || {}
  const root: Root = createRoot(container)
  let api: any = null
  root.render(
    <Provider>
      <RuntimeBridge options={options}>
        <CanvasPreview
          onReady={value => {
            api = value
            options.onReady?.(value)
          }}
          onDispose={() => options.onDispose?.()}
        />
      </RuntimeBridge>
    </Provider>
  )
  return {
    getApi: () => api,
    unmount: () => {
      root.unmount()
      if ((globalThis as any).__directorCanvasAdapter === options.adapter) {
        ;(globalThis as any).__directorCanvasAdapter = previousAdapter
      }
    },
  }
}
