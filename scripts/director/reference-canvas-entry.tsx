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

// Native rich text is rendered as HTML while it is being edited and rasterized
// back into the canvas when editing ends. Keep that HTML layer at the same
// visual scale as the director cards (16px canvas text becomes about 13px on
// screen), while still allowing an explicit node scale to be preserved.
const CANVAS_RICH_TEXT_HTML_SCALE = 0.8

function normalizeCanvasNode(node: any) {
  if (node?.$_type !== 'rich-text') return node
  // Nodes created before this normalization usually persisted the native
  // default of 1 after their first edit. Treat that default the same as a
  // missing scale, but keep intentional resize values such as 0.6 or 1.4.
  if (Number.isFinite(node.htmlScale) && node.htmlScale !== 1) return node
  return { ...node, htmlScale: CANVAS_RICH_TEXT_HTML_SCALE }
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
            const createNodes = value.createNodes.bind(value)
            value.createNodes = (nodes: any[], ...args: any[]) => createNodes(nodes.map(node =>
              normalizeCanvasNode(node.$_type === 'image'
                ? { brightness: 0, $_applyBrightnessFilter: false, ...node }
                : node)
            ), ...args)
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
