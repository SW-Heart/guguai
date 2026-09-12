import { useEffect, useRef, useState } from 'react'
import i18n from '@/i18n'
import { useAtomValue } from 'jotai'
import { useClickAway } from 'ahooks'
import { whiteboardApiAtom } from '../atom'
import { Button } from '@/components/ui/shad/button'
import { ButtonGroup } from '@/components/ui/shad/button-group'
import {
  ArrowDownToLineIcon,
  ArrowUpToLineIcon,
  CropIcon,
  EraserIcon,
  ImageDownIcon,
  ImageUpscaleIcon,
  MessageSquarePlusIcon,
  SquareUserRoundIcon,
  Trash2Icon,
} from 'lucide-react'
import { MessageInputContainer } from './MessageInputContainer'
import { useSendMessage } from '../useSendMessage'
import { toast } from 'sonner'
import type { CanvasSnapshot } from '@8btc/whiteboard'
import MyTooltip from '@/components/ui/MyToolTip'
import { xhrDownload } from '@/lib/file'
import { exportCanvasSelectionAsImage } from '../canvasSelectionExport'

// Canvas 改图统一从主对话输入框发起，旧的选区内聊天入口暂时隐藏。
const SHOW_CANVAS_FLOATING_CHAT = false

interface FloatingMenuProps {
  onBrushActivate: (imageId: string) => void
  onCropActivate: (imageId: string) => void
}

export function FloatingMenu({
  onBrushActivate,
  onCropActivate,
}: FloatingMenuProps) {
  const whiteboardApi = useAtomValue(whiteboardApiAtom)

  const [attaching, setAttaching] = useState(false)
  const [showChatBox, setShowChatbox] = useState(false)
  const inputRef = useRef<HTMLDivElement>(null)
  const chatButtonRef = useRef<HTMLButtonElement>(null)
  const { sendMessage, isSending } = useSendMessage()
  const [curSelectionIsImg, setCurSelectionIsImg] = useState(false)
  const [showChatBtn, setShowChatBtn] = useState(false)

  useEffect(() => {
    if (!whiteboardApi) return
    const state = whiteboardApi.getState()
    const handleState = (state: CanvasSnapshot) => {
      if (state.selectedNodeIds?.length === 1) {
        const selID = state.selectedNodeIds[0]
        const selectedNodes = state.nodes?.find(node => selID === node.id)
        if (
          // svg 特殊处理，带foreignObject无法导出为png图片（error: Tainted canvases may not be exported.）)
          selectedNodes?.$_type === 'image' &&
          !selectedNodes?.$_imageUrl?.endsWith('.svg')
        ) {
          setCurSelectionIsImg(true)
        } else {
          setCurSelectionIsImg(false)
        }
      } else if ((state.selectedNodeIds?.length || 0) > 1) {
        const selectedNodes = state.nodes?.filter(node =>
          state.selectedNodeIds?.includes(node.id)
        )
        const hasUnPortableNode = selectedNodes?.some(node => {
          // 目前只有svg图片需要特殊处理，其他类型都可以正常导出为png图片
          if (node.$_type === 'image' && node.$_imageUrl?.endsWith('.svg')) {
            return true
          }
          if (node.$_type === 'html') {
            return true
          }
          return false
        })

        setCurSelectionIsImg(false)
        setShowChatBtn(!hasUnPortableNode)
      }
    }
    handleState(state)
    whiteboardApi.on('state:change', handleState)
    return () => {
      whiteboardApi.off('state:change', handleState)
    }
  }, [whiteboardApi])

  useClickAway(() => {
    if (showChatBox) {
      setShowChatbox(false)
    }
  }, [inputRef, chatButtonRef])

  const [runningAction, setRunningAction] = useState(false)
  const handleImageAction = async (action: 'upscale' | 'cutout') => {
    if (isSending || runningAction) return
    setRunningAction(true)
    try {
      const adapter = (globalThis as any).__directorCanvasAdapter
      if (adapter?.imageAction) {
        await adapter.imageAction(action, whiteboardApi?.getState().selectedNodeIds || [])
      } else {
        await sendMessage(action === 'upscale' ? '增强图片清晰度，保留原图内容' : '移除图片背景，保留主体，输出透明背景图片')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '图片处理失败，请重试')
    } finally { setRunningAction(false) }
  }

  const handleCrop = () => {
    const imageId = whiteboardApi?.getState()?.selectedNodeIds?.[0]
    if (imageId) {
      onCropActivate(imageId)
    }
  }

  const handleDelete = () => {
    whiteboardApi?.deleteSelectedNodes()
  }

  const handleDownload = async () => {
    try {
    const adapter = (globalThis as any).__directorCanvasAdapter
    if (await adapter?.downloadFiles?.(whiteboardApi?.getState().selectedNodeIds || [])) return
    const dataUrl = whiteboardApi
      ? await exportCanvasSelectionAsImage(whiteboardApi, {
          pixelRatio: 1,
          quality: 0.8,
          backgroundColor: '#ffffff',
        })
      : null
    if (!dataUrl) {
      toast.error('当前选区无法导出，请选择图片、素材或图形')
      return
    }

    await xhrDownload(dataUrl, `whiteboard_${Date.now()}.png`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '下载失败，请重试')
    }
  }

  return (
    <div className="floating-menu">
      <div className="flex items-center gap-2">
        <ButtonGroup>
          {(globalThis as any).__directorCanvasAdapter?.attachFiles && (
            <MyTooltip content="发送到聊天">
              <Button variant="outline" size="icon" aria-label="发送到聊天"
                disabled={attaching}
                onClick={async () => {
                  if (attaching) return
                  setAttaching(true)
                  try {
                    await (globalThis as any).__directorCanvasAdapter.attachFiles(
                      whiteboardApi?.getState().selectedNodeIds || []
                    )
                  } finally { setAttaching(false) }
                }}>
                <MessageSquarePlusIcon />
              </Button>
            </MyTooltip>
          )}
          {SHOW_CANVAS_FLOATING_CHAT && showChatBtn && (
            <MyTooltip content={i18n.t('common:canvas.quickActions.chat')}>
              <Button
                variant={'outline'}
                size={'icon'}
                onClick={() => {
                  setShowChatbox(prev => !prev)
                }}
                ref={chatButtonRef}
              >
                <MessageSquarePlusIcon />
              </Button>
            </MyTooltip>
          )}
          {curSelectionIsImg && (
            <>
              {SHOW_CANVAS_FLOATING_CHAT && (
                <MyTooltip content={i18n.t('common:canvas.quickActions.chat')}>
                  <Button
                    variant={'outline'}
                    size={'icon'}
                    onClick={() => {
                      setShowChatbox(prev => !prev)
                    }}
                    ref={chatButtonRef}
                  >
                    <MessageSquarePlusIcon />
                  </Button>
                </MyTooltip>
              )}

              <MyTooltip content={i18n.t('common:canvas.quickActions.upscale')}>
                <Button
                  variant={'outline'}
                  size={'icon'}
                  disabled={runningAction || isSending}
                  onClick={() => {
                    void handleImageAction('upscale')
                  }}
                >
                  <ImageUpscaleIcon />
                </Button>
              </MyTooltip>

              <MyTooltip content={i18n.t('common:canvas.quickActions.cutout')}>
                <Button
                  variant={'outline'}
                  size={'icon'}
                  disabled={runningAction || isSending}
                  onClick={() => {
                    void handleImageAction('cutout')
                  }}
                >
                  <SquareUserRoundIcon />
                </Button>
              </MyTooltip>

              {/* <MyTooltip content={i18n.t('common:canvas.quickActions.eraser')}>
                <Button
                  variant={'outline'}
                  size={'icon'}
                  onClick={() => {
                    const imageId =
                      whiteboardApi?.getState()?.selectedNodeIds?.[0]
                    if (imageId) {
                      onBrushActivate(imageId)
                    }
                  }}
                >
                  <EraserIcon />
                </Button>
              </MyTooltip> */}
            </>
          )}

          {curSelectionIsImg && (
            <MyTooltip content={i18n.t('common:canvas.quickActions.crop')}>
              <Button variant={'outline'} size={'icon'} onClick={handleCrop}>
                <CropIcon />
              </Button>
            </MyTooltip>
          )}
          <MyTooltip content={i18n.t('common:canvas.quickActions.download')}>
            <Button
              variant={'outline'}
              size={'icon'}
              onClick={() => void handleDownload()}
            >
              <ImageDownIcon />
            </Button>
          </MyTooltip>
          <MyTooltip content={i18n.t('common:canvas.quickActions.delete')}>
            <Button variant={'outline'} size={'icon'} onClick={handleDelete}>
              <Trash2Icon />
            </Button>
          </MyTooltip>
        </ButtonGroup>

        <ButtonGroup>
          <MyTooltip
            content={i18n.t('common:canvas.quickActions.moveToBottom')}
          >
            <Button
              variant={'outline'}
              size={'icon'}
              onClick={() => {
                const nodeIds = whiteboardApi?.getState()?.selectedNodeIds || []
                whiteboardApi?.moveNodesToBottom(nodeIds)
              }}
            >
              <ArrowDownToLineIcon />
            </Button>
          </MyTooltip>
          <MyTooltip content={i18n.t('common:canvas.quickActions.moveToTop')}>
            <Button
              variant={'outline'}
              size={'icon'}
              onClick={() => {
                const nodeIds = whiteboardApi?.getState()?.selectedNodeIds || []
                whiteboardApi?.moveNodesToTop(nodeIds)
              }}
            >
              <ArrowUpToLineIcon />
            </Button>
          </MyTooltip>
        </ButtonGroup>
      </div>

      {SHOW_CANVAS_FLOATING_CHAT && showChatBox && (
        <div ref={inputRef} className="mt-2">
          <MessageInputContainer />
        </div>
      )}
    </div>
  )
}
