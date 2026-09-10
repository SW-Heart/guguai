import { getLocalizedErrorMessage } from '@/i18n/errors'
import i18n from '@/i18n'
import './index.css'
import './whiteboard.css'

import {
  useCallback,
  useEffect,
  forwardRef,
  useRef,
  useState,
  type DragEvent,
} from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'

import {
  canvasQuickEditDraftAtom,
  canvasQuickEditPendingAtom,
  canvasInsertRequestsAtom,
  createCanvasInsertRequestId,
  findCanvasInsertRequestForSession,
  imageMarkerTrackerAtom,
  rebindCanvasQuickEditPendingSession,
  removeCanvasInsertRequest,
  whiteboardApiAtom,
} from './atom'
import { FloatingMenuContainer } from './control/FloatingMenuContainer'

import { Grid } from './Grid'
import { ToolsMenu } from './control/ToolsMenu'
import { ZoomPanel } from './control/ZoomPanel'
import { CanvasApi, TipTapBubbleMenu } from '@8btc/whiteboard'
import {
  getCanvasNodesRightInsertPosition,
  insertImageBesideCanvasContent,
  insertImagesAtCanvasPosition,
} from './utils'
import {
  currentClawSessionKeyAtom,
  drawModelPreferenceAtom,
  messageInputRefAtom,
} from '@/store/atoms'
import { useCropAndUpload } from './useCropAndUpload'
import { emitter } from '@/lib/event-emitter'
import { UndoRedoButton } from './control/UndoRedoButtonGroup'
import { ColorAndStrokeWidthPanel } from './control/ColorAndStrokeWidthPanel'
import { CurveArrowToolLayer } from './control/CurveArrowToolLayer'
import { TextColorPicker } from './control/TextColorPicker'
import { toast } from 'sonner'
import { configureImageResizeBehavior } from './imageResizeBehavior'
import { RichTextDefaultFontAdapter } from './control/RichTextDefaultFontAdapter'
import { loadCanvasDefaultFont } from './canvasFonts'
import {
  bindCanvasDoubleClickToRichText,
  getCanvasPointFromClient,
  getDroppedCanvasImageFiles,
  hasCanvasImageDrag,
} from './canvasQuickActions'
import { arrayBufferToBase64 } from '@/lib/file'
import { fileClient } from '@/api/fileClient'
import { normalizeClawMediaUrl } from '@/lib/claw'
import { ImagePlusIcon } from 'lucide-react'
import {
  CANVAS_HISTORY_LIMIT_CHECK_DELAY_MS,
  createCanvasHistoryDraftKey,
  enforceActiveCanvasHistoryLimit,
  getCanvasHistoryForSession,
  getCanvasHistoryInitialState,
  getCanvasHistorySessionKey,
  rebindCanvasHistorySession,
  restoreCanvasHistory,
  saveCanvasHistoryForSession,
} from './canvasHistory'
import {
  deriveCanvasQuickModelState,
  getCanvasQuickEditReferenceMode,
  getCanvasQuickEditVisiblePromptPrefill,
  getCanvasQuickEditSourceAspectRatio,
  getCanvasQuickEditMode,
  isCanvasQuickEditSelectionCandidate,
} from './canvasQuickEdit'
import { createCanvasQuickEditAttachments } from './canvasQuickEditAttachment'
import { findCanvasQuickEditResult } from './canvasQuickEditResult'
import {
  CanvasImageCompressionLimitError,
  getCanvasImageCompressionFailureMessage,
  prepareCanvasImageFiles,
} from './canvasImageCompression'
import {
  getOrCreateSession,
  subscribeSession,
} from '@/hooks/claw-chat/sessionStore'
import {
  useViewerRuntime,
  useViewerRuntimeDomId,
} from '@/components/preview/viewer/ViewerRuntimeContext'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface CanvasPrevewProps {
  onReady?: (api: CanvasApi) => void
  onDispose?: () => void
  initialState?: any
}

function cacheCanvasHistoryForSession(
  sessionKey: string | null | undefined,
  api: CanvasApi | null | undefined
): void {
  const result = saveCanvasHistoryForSession(sessionKey, api)
  if (!result.cached && result.reason !== 'missing_api') {
    console.warn('Canvas history was not cached', {
      sessionKey: getCanvasHistorySessionKey(sessionKey),
      reason: result.reason,
      sizeBytes: result.sizeBytes,
    })
  }
}

const CanvasPreview = forwardRef<any, CanvasPrevewProps>((props) => {
  const { active } = useViewerRuntime()
  const whiteboardContainerId = useViewerRuntimeDomId('whiteboardContainer')
  const layerPanelAttachContainerId = useViewerRuntimeDomId(
    'layerPanelAttachContainer'
  )
  // local atom
  const [whiteboardApi, setWhiteboardApi] = useAtom(whiteboardApiAtom)
  const canvasInsertRequests = useAtomValue(canvasInsertRequestsAtom)
  const setCanvasInsertRequests = useSetAtom(canvasInsertRequestsAtom)
  const canvasQuickEditPending = useAtomValue(canvasQuickEditPendingAtom)
  const setCanvasQuickEditDraft = useSetAtom(canvasQuickEditDraftAtom)
  const setCanvasQuickEditPending = useSetAtom(canvasQuickEditPendingAtom)
  const drawModelPreference = useAtomValue(drawModelPreferenceAtom)
  const setDrawModelPreference = useSetAtom(drawModelPreferenceAtom)
  const containerRef = useRef<HTMLDivElement>(null)
  const insertedIdsRef = useRef<string[]>([])
  const messageInputRef = useAtomValue(messageInputRefAtom)
  const { cropAndUploadImage, uploadBase64Image } = useCropAndUpload()
  const imageMarkerTracker = useAtomValue(imageMarkerTrackerAtom)
  const sessionKey = useAtomValue(currentClawSessionKeyAtom)
  const draftCanvasSessionKeyRef = useRef<string | null>(null)
  if (!draftCanvasSessionKeyRef.current) {
    draftCanvasSessionKeyRef.current = createCanvasHistoryDraftKey()
  }
  const canvasSessionKey = getCanvasHistorySessionKey(
    sessionKey,
    draftCanvasSessionKeyRef.current
  )
  const whiteboardApiRef = useRef<CanvasApi | null>(null)
  const apiSessionKeyRef = useRef<string | null>(null)
  const messageInputRefRef = useRef(messageInputRef)
  const drawModelPreferenceRef = useRef(drawModelPreference)
  const canvasQuickEditPendingRef = useRef(canvasQuickEditPending)
  const quickEditSelectionSequenceRef = useRef(0)
  const quickEditSelectionTimerRef = useRef<number | null>(null)
  const processingQuickEditResultIdsRef = useRef(new Set<string>())
  const suppressQuickEditSelectionRef = useRef(false)
  const canvasDragDepthRef = useRef(0)
  const [isCanvasImageDragActive, setIsCanvasImageDragActive] = useState(false)

  messageInputRefRef.current = messageInputRef
  drawModelPreferenceRef.current = drawModelPreference
  canvasQuickEditPendingRef.current = canvasQuickEditPending
  const processingInsertRequestIdRef = useRef<string | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props

  useEffect(() => {
    whiteboardApiRef.current = whiteboardApi
  }, [whiteboardApi])

  useEffect(() => {
    if (!whiteboardApi) return
    let historyLimitTimer: number | null = null
    const enforceHistoryLimit = () => {
      historyLimitTimer = null
      const result = enforceActiveCanvasHistoryLimit(whiteboardApi)
      if (result.reason === 'present_too_large') {
        console.warn('Canvas current state exceeds the in-memory cache limit', {
          sessionKey: canvasSessionKey,
        })
      }
    }
    const scheduleHistoryLimitCheck = () => {
      if (historyLimitTimer !== null) {
        window.clearTimeout(historyLimitTimer)
      }
      historyLimitTimer = window.setTimeout(
        enforceHistoryLimit,
        CANVAS_HISTORY_LIMIT_CHECK_DELAY_MS
      )
    }

    whiteboardApi.on('state:change', scheduleHistoryLimitCheck)
    scheduleHistoryLimitCheck()

    return () => {
      whiteboardApi.off('state:change', scheduleHistoryLimitCheck)
      if (historyLimitTimer !== null) {
        window.clearTimeout(historyLimitTimer)
      }
    }
  }, [canvasSessionKey, whiteboardApi])

  useEffect(() => {
    if (!whiteboardApi) return
    return configureImageResizeBehavior(whiteboardApi)
  }, [whiteboardApi])

  useEffect(() => {
    if (!whiteboardApi) return

    const handleNodesSelected = (selectedNodeIds: string[]) => {
      quickEditSelectionSequenceRef.current += 1
      const sequence = quickEditSelectionSequenceRef.current
      if (quickEditSelectionTimerRef.current !== null) {
        window.clearTimeout(quickEditSelectionTimerRef.current)
      }
      if (
        suppressQuickEditSelectionRef.current ||
        selectedNodeIds.length === 0
      ) {
        return
      }

      quickEditSelectionTimerRef.current = window.setTimeout(() => {
        quickEditSelectionTimerRef.current = null
        void (async () => {
          const snapshot = whiteboardApi.getState()
          if (
            sequence !== quickEditSelectionSequenceRef.current ||
            !sameNodeSelection(
              snapshot.selectedNodeIds ?? [],
              selectedNodeIds
            ) ||
            !isCanvasQuickEditSelectionCandidate(snapshot)
          ) {
            return
          }

          const selectedNodes = (snapshot.nodes ?? []).filter(node =>
            selectedNodeIds.includes(node.id)
          )
          const hasUnexportableNode = selectedNodes.some(
            node =>
              node.$_type === 'html' ||
              (node.$_type === 'image' &&
                node.$_imageUrl?.toLowerCase().endsWith('.svg'))
          )
          if (hasUnexportableNode) return

          const insertPosition = getCanvasNodesRightInsertPosition(
            whiteboardApi,
            selectedNodeIds
          )
          if (!insertPosition) return

          const mode = getCanvasQuickEditMode(snapshot)
          const referenceMode = getCanvasQuickEditReferenceMode(snapshot)
          const sourceAspectRatio =
            mode === 'annotation_edit'
              ? getCanvasQuickEditSourceAspectRatio(snapshot)
              : undefined
          const modelState = deriveCanvasQuickModelState(
            drawModelPreferenceRef.current,
            mode,
            sourceAspectRatio
          )
          drawModelPreferenceRef.current = modelState.preference
          setDrawModelPreference(modelState.preference)

          const requestId = createCanvasInsertRequestId()
          try {
            const attachmentBundle = await createCanvasQuickEditAttachments({
              api: whiteboardApi,
              requestId,
              snapshot,
              referenceMode,
            })
            if (
              !attachmentBundle ||
              sequence !== quickEditSelectionSequenceRef.current ||
              whiteboardApiRef.current !== whiteboardApi ||
              !messageInputRefRef.current?.setCanvasReferenceFiles
            ) {
              return
            }

            const draft = {
              requestId,
              sessionKey: canvasSessionKey,
              mode,
              modelSource: modelState.source,
              baselinePreference: modelState.preference,
              initialTouchedParameterKeys: modelState.touchedParameterKeys,
              selectedNodeIds: [...selectedNodeIds],
              referenceMode: attachmentBundle.referenceMode,
              references: attachmentBundle.references,
              insertPosition,
            }
            setCanvasQuickEditDraft(draft)
            messageInputRefRef.current.setCanvasReferenceFiles(
              attachmentBundle.references.map(reference => reference.file)
            )
            const currentInput = messageInputRefRef.current.getContent?.()
            const visiblePromptPrefill = getCanvasQuickEditVisiblePromptPrefill(
              mode,
              `${currentInput?.origin ?? ''}${currentInput?.content ?? ''}`
            )
            if (visiblePromptPrefill) {
              messageInputRefRef.current.setContent?.(visiblePromptPrefill)
            }
            messageInputRefRef.current.focus?.()
          } catch (error) {
            if (sequence !== quickEditSelectionSequenceRef.current) return
            console.error('Failed to attach Canvas selection:', error)
            toast.error(getLocalizedErrorMessage(error))
          }
        })()
      }, 160)
    }

    whiteboardApi.on('nodes:selected', handleNodesSelected)
    return () => {
      whiteboardApi.off('nodes:selected', handleNodesSelected)
      quickEditSelectionSequenceRef.current += 1
      if (quickEditSelectionTimerRef.current !== null) {
        window.clearTimeout(quickEditSelectionTimerRef.current)
        quickEditSelectionTimerRef.current = null
      }
    }
  }, [
    canvasSessionKey,
    sessionKey,
    setCanvasQuickEditDraft,
    setDrawModelPreference,
    whiteboardApi,
  ])

  useEffect(() => {
    if (!whiteboardApi || !sessionKey) return

    const insertReadyResults = () => {
      const messages = getOrCreateSession(sessionKey).messages
      canvasQuickEditPendingRef.current
        .filter(pending => pending.sessionKey === sessionKey)
        .forEach(pending => {
          const result = findCanvasQuickEditResult(messages, pending.requestId)
          if (result.status === 'failed') {
            setCanvasQuickEditPending(current =>
              current.filter(item => item.requestId !== pending.requestId)
            )
            return
          }
          if (
            result.status !== 'ready' ||
            processingQuickEditResultIdsRef.current.has(pending.requestId)
          ) {
            return
          }

          processingQuickEditResultIdsRef.current.add(pending.requestId)
          suppressQuickEditSelectionRef.current = true
          void insertImagesAtCanvasPosition(
            whiteboardApi,
            result.imageUrls.map(normalizeClawMediaUrl),
            getCanvasNodesRightInsertPosition(
              whiteboardApi,
              pending.selectedNodeIds
            ) ?? pending.insertPosition
          )
            .then(() => {
              if (
                whiteboardApiRef.current !== whiteboardApi ||
                apiSessionKeyRef.current !== canvasSessionKey
              ) {
                return
              }
              setCanvasQuickEditPending(current =>
                current.filter(item => item.requestId !== pending.requestId)
              )
            })
            .catch(error => {
              if (whiteboardApiRef.current !== whiteboardApi) return
              console.error('Failed to insert Canvas quick edit result:', error)
              toast.error(i18n.t('legacy:ui_7d80a742062c'))
            })
            .finally(() => {
              processingQuickEditResultIdsRef.current.delete(pending.requestId)
              suppressQuickEditSelectionRef.current =
                processingQuickEditResultIdsRef.current.size > 0
            })
        })
    }

    insertReadyResults()
    return subscribeSession(sessionKey, insertReadyResults)
  }, [canvasSessionKey, sessionKey, setCanvasQuickEditPending, whiteboardApi])

  useEffect(() => {
    if (!whiteboardApi) return
    return bindCanvasDoubleClickToRichText(whiteboardApi)
  }, [whiteboardApi])

  const handleCanvasDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!whiteboardApi || !hasCanvasImageDrag(event.dataTransfer)) return

      event.preventDefault()
      event.stopPropagation()
      canvasDragDepthRef.current += 1
      setIsCanvasImageDragActive(true)
    },
    [whiteboardApi]
  )

  const handleCanvasDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!whiteboardApi || !hasCanvasImageDrag(event.dataTransfer)) return

      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'copy'
    },
    [whiteboardApi]
  )

  const handleCanvasDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (canvasDragDepthRef.current === 0) return

      event.preventDefault()
      event.stopPropagation()
      canvasDragDepthRef.current = Math.max(0, canvasDragDepthRef.current - 1)
      if (canvasDragDepthRef.current === 0) {
        setIsCanvasImageDragActive(false)
      }
    },
    []
  )

  const handleCanvasDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      if (!whiteboardApi || event.dataTransfer.files.length === 0) return

      event.preventDefault()
      event.stopPropagation()
      canvasDragDepthRef.current = 0
      setIsCanvasImageDragActive(false)

      const { imageFiles, rejectedFileCount } = getDroppedCanvasImageFiles(
        event.dataTransfer
      )
      if (rejectedFileCount > 0) {
        toast.error(`仅支持拖入图片，已忽略 ${rejectedFileCount} 个其他文件`)
      }

      const prepared = await prepareCanvasImageFiles(imageFiles)
      prepared.failures.forEach(failure => {
        toast.error(
          getCanvasImageCompressionFailureMessage(failure.originalFileName)
        )
      })
      const validFiles = prepared.files
      if (validFiles.length === 0) return

      const dropPoint = getCanvasPointFromClient(whiteboardApi, {
        x: event.clientX,
        y: event.clientY,
      })
      const uploadResults = await Promise.allSettled(
        validFiles.map(async file => {
          const base64 = arrayBufferToBase64(await file.arrayBuffer())
          const localPath = await fileClient.saveUpload({
            base64,
            fileName: file.name,
          })
          return normalizeClawMediaUrl(localPath)
        })
      )
      const imageUrls = uploadResults.flatMap(result =>
        result.status === 'fulfilled' ? [result.value] : []
      )
      const failedUploadCount = uploadResults.length - imageUrls.length
      if (failedUploadCount > 0) {
        toast.error(`${failedUploadCount} 张图片上传失败，请重试`)
      }
      if (imageUrls.length === 0) return

      try {
        await insertImagesAtCanvasPosition(whiteboardApi, imageUrls, dropPoint)
      } catch (error) {
        console.error('Failed to insert dropped images into canvas:', error)
        toast.error(i18n.t('legacy:ui_47bb3e7c4bb5'))
      }
    },
    [whiteboardApi]
  )

  useEffect(() => {
    if (!whiteboardApi) return
    const offCustomBlockChange = emitter.on(
      'custom-block-change',
      eventData => {
        if (!active) return
        if (Array.isArray(eventData.customize)) {
          console.log(eventData.customize)
          // 检查哪些id不在customize数组中
          const currentIds = eventData.customize
            .map(item => item.data?.id)
            .filter(Boolean)
          const idsToDelete = insertedIdsRef.current.filter(
            id => !currentIds.includes(id)
          )

          console.log('custom-block-change idsToDelete:', idsToDelete)

          // 删除不在customize中的节点
          whiteboardApi.deleteNodes(idsToDelete)

          // 更新记录的id数组
          insertedIdsRef.current = currentIds
        }
      }
    )

    const offMessageSentSuccess = emitter.on('message-sent:success', event => {
      if (
        event.sessionId &&
        getCanvasHistorySessionKey(event.sessionId) !== canvasSessionKey
      ) {
        return
      }
      whiteboardApi?.deleteNodes(insertedIdsRef.current)
      insertedIdsRef.current = []
    })

    const offMessageSentError = emitter.on('message-sent:error', event => {
      if (
        event?.sessionId &&
        getCanvasHistorySessionKey(event.sessionId) !== canvasSessionKey
      ) {
        return
      }
      whiteboardApi?.deleteNodes(insertedIdsRef.current)
      insertedIdsRef.current = []
    })

    return () => {
      offCustomBlockChange()
      offMessageSentSuccess()
      offMessageSentError()
    }
  }, [active, canvasSessionKey, whiteboardApi])

  useEffect(() => {
    if (!containerRef.current) return

    if (whiteboardApi) {
      if (apiSessionKeyRef.current !== canvasSessionKey) {
        const previousSessionKey = apiSessionKeyRef.current
        cacheCanvasHistoryForSession(previousSessionKey, whiteboardApi)
        if (
          previousSessionKey === draftCanvasSessionKeyRef.current &&
          sessionKey
        ) {
          rebindCanvasHistorySession(previousSessionKey, canvasSessionKey)
          setCanvasQuickEditPending(current =>
            rebindCanvasQuickEditPendingSession(
              current,
              previousSessionKey,
              sessionKey
            )
          )
        }
        whiteboardApi.dispose()
        whiteboardApiRef.current = null
        apiSessionKeyRef.current = null
        setWhiteboardApi(null)
        insertedIdsRef.current = []
        return
      }
      return
    }
    let disposed = false
    const timer = window.setTimeout(() => {
      void (async () => {
        const history = getCanvasHistoryForSession(canvasSessionKey)
        await loadCanvasDefaultFont()
        if (disposed || !containerRef.current) return

        const initialState = getCanvasHistoryInitialState(history)
        const providedState = propsRef.current.initialState
        const core = providedState
          ? new CanvasApi(containerRef.current, { state: providedState })
          : initialState
            ? new CanvasApi(containerRef.current, { state: initialState })
          : new CanvasApi(containerRef.current)

        if (history) {
          restoreCanvasHistory(core, history)
        } else {
          core.updateViewport({
            // svg 图片尺寸很小，不需要缩放（ps 魔镜生成的图片大）
            scale: 0.2,
          })
        }

        apiSessionKeyRef.current = canvasSessionKey
        whiteboardApiRef.current = core
        setWhiteboardApi(core)
        core.on('nodes:created', nodes => {
          nodes?.map(n => {
            if (!sessionKey) return

            if (n.$_type === 'image-marker') {
              const imgNode = core
                .getState()
                .nodes?.find(node => node.id === n.$_parentId)

              if (!imgNode) return
              const baseUrl = imgNode.$_imageUrl!

              const editUrl = core.exportImageWithMarker(n.$_parentId!, {
                pixelRatio: 1,
                mimeType: 'image/jpeg',
              })
              if (!editUrl) return
              const { start, end } = n.$_relativeBox as {
                start: { ratioX: number; ratioY: number }
                end: { ratioX: number; ratioY: number }
              }

              const fileName = `image_marker_${Date.now()}.png`
              const editFileName = `image_marker_edit_${Date.now()}.png`

              // 上传editUrl
              const uploadEditUrlPromise = uploadBase64Image(
                editUrl,
                editFileName,
                sessionKey
              )

              // 使用start和end截取baseUrl并上传生成previewUrl
              const uploadPreviewPromise = cropAndUploadImage(
                baseUrl,
                start,
                end,
                fileName,
                sessionKey
              )

              Promise.all([uploadEditUrlPromise, uploadPreviewPromise])
                .then(([uploadedEditUrl, previewUrl]) => {
                  if (
                    whiteboardApiRef.current !== core ||
                    apiSessionKeyRef.current !== canvasSessionKey ||
                    !core.getNodeConfigById(n.id)
                  ) {
                    return
                  }
                  if (!uploadedEditUrl || !previewUrl) {
                    throw new Error('Image selection upload returned empty url')
                  }

                  // 记录插入的id
                  insertedIdsRef.current.push(n.id)

                  imageMarkerTracker.set(baseUrl, uploadedEditUrl)

                  messageInputRefRef.current?.appendContent?.(
                    `${JSON.stringify({
                      type: 'imageSelection',
                      content: {
                        index: n.$_markerNumber,
                        baseUrl,
                        editUrl: uploadedEditUrl,
                        previewUrl: previewUrl,
                        id: n.id,
                      },
                    })}`
                  )
                })
                .catch((error: any) => {
                  if (
                    whiteboardApiRef.current !== core ||
                    apiSessionKeyRef.current !== canvasSessionKey
                  ) {
                    return
                  }
                  console.error('Failed to upload images:', error)
                  toast.error(getLocalizedErrorMessage(error))
                })
            }
          })
        })
        core.on('nodes:deleted', nodes => {
          if (!sessionKey) return
          console.log('nodes deleted:', nodes)
          nodes
            .filter(n => n.$_type === 'image')
            .map(n => {
              imageMarkerTracker.delete(n.$_imageUrl)
            })

          const deletedImageMarkers = nodes.filter(
            n => n.$_type === 'image-marker'
          )
          deletedImageMarkers.forEach(n => {
            // 先把对应的数据从输入框里移除
            // 从记录中移除删除的id
            insertedIdsRef.current = insertedIdsRef.current.filter(
              id => id !== n.id
            )
            messageInputRefRef.current?.updateContent?.(
              `${JSON.stringify({
                type: 'imageSelection',
                content: {
                  index: n.$_markerNumber,
                  id: n.id,
                },
              })}`,
              true
            )
            const imgNode = core
              .getState()
              .nodes?.find(node => node.id === n.$_parentId)
            if (!imgNode) return
            const baseUrl = imgNode.$_imageUrl!
            const editUrl = core.exportImageWithMarker(n.$_parentId!, {
              pixelRatio: 1,
              mimeType: 'image/jpeg',
            })
            if (!editUrl) {
              // 如果 marker 被清空，则从记录中移除
              imageMarkerTracker.delete(baseUrl)
              return
            }
            const editFileName = `image_marker_edit_${Date.now()}.png`
            uploadBase64Image(editUrl, editFileName, sessionKey)
              .then(uploadedEditUrl => {
                if (
                  whiteboardApiRef.current !== core ||
                  apiSessionKeyRef.current !== canvasSessionKey ||
                  !core.getNodeConfigById(n.$_parentId!)
                ) {
                  return
                }
                const baseUrl = imgNode.meta.imageUrl!
                imageMarkerTracker.set(baseUrl, uploadedEditUrl)
              })
              .catch(error => {
                console.error('Failed to refresh image marker preview:', error)
              })
          })
        })
        propsRef.current.onReady?.(core)
      })()
    }, 0)
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [
    canvasSessionKey,
    cropAndUploadImage,
    imageMarkerTracker,
    messageInputRef,
    sessionKey,
    setCanvasQuickEditPending,
    setWhiteboardApi,
    uploadBase64Image,
    whiteboardApi,
  ])

  useEffect(() => {
    const request = findCanvasInsertRequestForSession(
      canvasInsertRequests,
      sessionKey
    )
    if (!whiteboardApi || !request) return
    if (processingInsertRequestIdRef.current) return

    processingInsertRequestIdRef.current = request.id
    insertImageBesideCanvasContent(whiteboardApi, request.imageUrls)
      .catch(error => {
        if (
          whiteboardApiRef.current !== whiteboardApi ||
          apiSessionKeyRef.current !== canvasSessionKey
        ) {
          return
        }
        console.error('Failed to insert image into canvas:', error)
        toast.error(i18n.t('legacy:ui_65b962d69016'))
      })
      .finally(() => {
        if (processingInsertRequestIdRef.current === request.id) {
          processingInsertRequestIdRef.current = null
        }
        setCanvasInsertRequests(current =>
          removeCanvasInsertRequest(current, request.id)
        )
      })
  }, [
    canvasInsertRequests,
    canvasSessionKey,
    sessionKey,
    setCanvasInsertRequests,
    whiteboardApi,
  ])

  useEffect(() => {
    return () => {
      console.log('canvas preview unmount')
      const api = whiteboardApiRef.current
      cacheCanvasHistoryForSession(apiSessionKeyRef.current, api)
      api?.dispose()
      propsRef.current.onDispose?.()
      whiteboardApiRef.current = null
      apiSessionKeyRef.current = null
      setWhiteboardApi(null)
    }
  }, [setWhiteboardApi])

  return (
    <div
      className="canvas-layer-panel-attach-container h-full flex flex-col canvas-preview overflow-hidden relative"
      id={layerPanelAttachContainerId}
    >
      <div className="px-4 py-1.5 border-b border-solid border-border">
        <ToolsMenu />
      </div>
      <div
        className="canvas-whiteboard-container relative w-full h-full"
        id={whiteboardContainerId}
        onDragEnter={handleCanvasDragEnter}
        onDragOver={handleCanvasDragOver}
        onDragLeave={handleCanvasDragLeave}
        onDrop={handleCanvasDrop}
      >
        <Grid />
        <div ref={containerRef} className="relative size-full outline-none" />
        <CurveArrowToolLayer api={whiteboardApi} />

        {isCanvasImageDragActive && (
          <div className="pointer-events-none absolute inset-3 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/70 bg-primary/10 backdrop-blur-[1px]">
            <div className="flex items-center gap-2 rounded-lg bg-background/95 px-4 py-3 text-sm font-medium text-foreground shadow-lg">
              <ImagePlusIcon className="size-5 text-primary" />
              {i18n.t('legacy:ui_c46a4a9d4292')}
            </div>
          </div>
        )}

        <FloatingMenuContainer />
        <ColorAndStrokeWidthPanel api={whiteboardApi} />

        {/* <AddToChatButton /> */}

        <div className="absolute bottom-4 left-6 z-10 flex items-center gap-4">
          {whiteboardApi && <UndoRedoButton api={whiteboardApi} />}
        </div>
        <div className="absolute bottom-4 right-6 z-10 flex items-center gap-4">
          {whiteboardApi && <ZoomPanel api={whiteboardApi} />}
        </div>

        <TipTapBubbleMenu
          api={whiteboardApi}
          renderTextColorPicker={(editor: any) => (
            <>
              <RichTextDefaultFontAdapter editor={editor} />
              <TextColorPicker editor={editor} />
            </>
          )}
        />
      </div>
    </div>
  )
})

CanvasPreview.displayName = 'CanvasPreview'

function sameNodeSelection(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const rightIds = new Set(right)
  return left.every(id => rightIds.has(id))
}

export { CanvasPreview }
