import type { CanvasApi, NodeConfig } from '@8btc/whiteboard'
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from '@/components/ui/shad/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/shad/sheet'
import {
  Box,
  Circle,
  Eye,
  EyeOff,
  FileText,
  Film,
  GripVertical,
  Image,
  Lock,
  Pencil,
  Shapes,
  Square,
  Type,
  Unlock,
} from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { cn } from '@/lib/utils'
import { useViewerRuntimeDomId } from '@/components/preview/viewer/ViewerRuntimeContext'
import { useTranslation } from 'react-i18next'

const DEFAULT_LAYER_PANEL_WIDTH = 320
const MIN_LAYER_PANEL_WIDTH = 184
const MAX_LAYER_PANEL_WIDTH = 420

function clampLayerPanelWidth(width: number) {
  return Math.min(MAX_LAYER_PANEL_WIDTH, Math.max(MIN_LAYER_PANEL_WIDTH, width))
}

interface LayerPanelProps {
  api: CanvasApi | null
  open: boolean
  onClose: () => void
}

const getNodeIcon = (type: string) => {
  const iconProps = { size: 14, color: 'rgba(0, 0, 0, 9)' }

  let IconComponent: any
  switch (type?.toLowerCase()) {
    case 'image':
      IconComponent = <Image {...iconProps} />
      break
    case 'video':
      IconComponent = <Film {...iconProps} />
      break
    case 'rich-text':
      IconComponent = <Type {...iconProps} />
      break
    case 'rect':
    case 'rectangle':
      IconComponent = <Square {...iconProps} />
      break
    case 'circle':
    case 'ellipse':
      IconComponent = <Circle {...iconProps} />
      break
    case 'path':
    case 'draw':
      IconComponent = <Pencil {...iconProps} />
      break
    case 'shape':
      IconComponent = <Shapes {...iconProps} />
      break
    case 'note':
      IconComponent = <FileText {...iconProps} />
      break
    default:
      IconComponent = <Box {...iconProps} />
  }

  return (
    <div className="w-8 h-8 shrink-0 flex items-center justify-center mr-2 bg-gray-100 text-gray-600 rounded-md">
      {IconComponent}
    </div>
  )
}

type LayerNodeConfig = NodeConfig & {
  $_actualType?: string
}

/**
 * HTML is the rendering container used by the director cards. Keep the
 * media kind separate so the layer panel describes what the node contains.
 * The markup fallback also covers canvas states saved before $_actualType
 * was added.
 */
const getNodeLayerType = (node: LayerNodeConfig) => {
  const type = node.$_type?.toLowerCase()
  if (type === 'video') return 'video'
  if (
    type === 'html' &&
    (node.$_actualType?.toLowerCase() === 'video' ||
      /<video(?:\s|>)/i.test(node.$_htmlContent || ''))
  ) {
    return 'video'
  }
  return type || 'node'
}

const getNodeThumbnail = (node: NodeConfig, thumbnailLabel: string) => {
  const layerType = getNodeLayerType(node as LayerNodeConfig)
  const thumbnailUrl =
    layerType === 'image'
      ? node.$_imageUrl
      : layerType === 'video'
        ? (node as LayerNodeConfig).$_coverUrl
        : undefined

  if (thumbnailUrl) {
    return (
      <div className="w-8 h-8 shrink-0 mr-2 overflow-hidden rounded-md">
        <img
          src={thumbnailUrl}
          alt={thumbnailLabel}
          className="w-full h-full object-cover"
        />
      </div>
    )
  }

  return getNodeIcon(layerType)
}

const getNodeDisplayName = (type: string, t: (key: string) => string) => {
  const typeMap: Record<string, string> = {
    image: t('common:canvas.layers.image'),
    video: t('common:canvas.layers.video'),
    'rich-text': t('common:canvas.layers.text'),
    rect: t('common:canvas.layers.rectangle'),
    rectangle: t('common:canvas.layers.rectangle'),
    circle: t('common:canvas.layers.circle'),
    ellipse: t('common:canvas.layers.ellipse'),
    path: t('common:canvas.layers.path'),
    draw: t('common:canvas.layers.drawing'),
    shape: t('common:canvas.layers.shape'),
    note: t('common:canvas.layers.note'),
    line: t('common:canvas.layers.line'),
    arrow: t('common:canvas.layers.arrow'),
    'sticky-note': t('common:canvas.layers.stickyNote'),
  }

  const displayName =
    typeMap[type?.toLowerCase()] || type || t('common:canvas.layers.fallback')
  return `${displayName}`
}

interface SortableItemProps {
  node: NodeConfig
  onFocus: (node: NodeConfig) => void
  onToggleVisible: (nodeId: string) => void
  onToggleLock: (nodeId: string) => void
}

function SortableItem({
  node,
  onFocus,
  onToggleVisible,
  onToggleLock,
}: SortableItemProps) {
  const { t } = useTranslation()
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: node.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      key={node.id}
      className={cn(
        'flex items-center justify-between w-full px-3 py-1 rounded-lg',
        'bg-background border border-border',
        'hover:bg-gray-50 dark:hover:bg-gray-750 hover:shadow-sm',
        'transition-all duration-200',
        isDragging && 'opacity-50 shadow-lg'
      )}
    >
      <div className="flex min-w-0 items-center justify-between w-full">
        <div
          className="flex min-w-0 items-center flex-1 mr-2"
          style={{ opacity: node.visible === false ? 0.5 : 1 }}
        >
          <div
            className="shrink-0 cursor-grab active:cursor-grabbing mr-2 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
            {...attributes}
            {...listeners}
          >
            <GripVertical size={16} />
          </div>
          <div
            className="flex min-w-0 items-center flex-1 cursor-pointer"
            onClick={() => onFocus(node)}
          >
            {getNodeThumbnail(node, t('common:canvas.layers.thumbnail'))}
            <span className="min-w-0 flex-1 text-sm font-medium text-foreground truncate">
              {getNodeDisplayName(getNodeLayerType(node), t)}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={e => {
              e.stopPropagation()
              onToggleVisible(node.id)
            }}
            title={
              node.visible === false
                ? t('common:canvas.layers.show')
                : t('common:canvas.layers.hide')
            }
            className="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 h-8 w-8 rounded-md"
          >
            {node.visible === false ? <EyeOff size={16} /> : <Eye size={16} />}
          </Button>

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={e => {
              e.stopPropagation()
              onToggleLock(node.id)
            }}
            title={
              node.$_listening === false
                ? t('common:canvas.layers.unlock')
                : t('common:canvas.layers.lock')
            }
            className="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 h-8 w-8 rounded-md"
          >
            {node.$_listening === false ? (
              <Lock size={16} />
            ) : (
              <Unlock size={16} />
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function LayerPanel({ api, open, onClose }: LayerPanelProps) {
  const { t } = useTranslation()
  const layerPanelAttachContainerId = useViewerRuntimeDomId(
    'layerPanelAttachContainer'
  )
  const [nodes, setNodes] = useState<NodeConfig[] | undefined>(
    api?.getState().nodes
  )
  const [panelWidth, setPanelWidth] = useState(DEFAULT_LAYER_PANEL_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const resizeAbortControllerRef = useRef<AbortController | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  //   const handleLayerIndexChange = (ids: string[]) => {};

  useEffect(() => {
    if (!api) {
      setNodes(undefined)
      return
    }

    const handleStateChange = (state: ReturnType<CanvasApi['getState']>) => {
      setNodes([...(state.nodes || [])].reverse()) // 反转节点数组，使得后创建的节点在前面显示
    }

    handleStateChange(api.getState())
    api.on('state:change', handleStateChange)

    // api.on('nodes:sorted', handleLayerIndexChange);

    // 监听图层变化事件
    return () => {
      api.off('state:change', handleStateChange)
    }
  }, [api])

  useEffect(() => {
    return () => {
      resizeAbortControllerRef.current?.abort()
      resizeAbortControllerRef.current = null
    }
  }, [])

  const handleResizePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>
  ) => {
    if (event.button !== 0) return

    event.preventDefault()
    event.stopPropagation()

    resizeAbortControllerRef.current?.abort()

    const controller = new AbortController()
    resizeAbortControllerRef.current = controller
    const startX = event.clientX
    const startWidth = panelWidth

    setIsResizing(true)

    const finishResize = () => {
      controller.abort()
      if (resizeAbortControllerRef.current === controller) {
        resizeAbortControllerRef.current = null
      }
      setIsResizing(false)
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX
      setPanelWidth(clampLayerPanelWidth(startWidth - deltaX))
    }

    window.addEventListener('pointermove', handlePointerMove, {
      signal: controller.signal,
    })
    window.addEventListener('pointerup', finishResize, {
      signal: controller.signal,
    })
    window.addEventListener('pointercancel', finishResize, {
      signal: controller.signal,
    })
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event

    if (!over || active.id === over.id || !nodes) {
      return
    }

    const oldIndex = nodes.findIndex(node => node.id === active.id)
    const newIndex = nodes.findIndex(node => node.id === over.id)

    const newNodes = arrayMove(nodes, oldIndex, newIndex)
    setNodes(newNodes)

    // 通知 API 更新节点顺序，需要将翻转后的顺序再翻转回去
    if (api) {
      api.reorderNodes([...newNodes].reverse().map(node => node.id))
    }
  }

  const handleFocusNode = (node: NodeConfig) => {
    if (!api) return
    if (node.visible === false) {
      return
    }
    api.focusNodes([node.id])
  }

  const toggleLock = (nodeId: string) => {
    if (!api) return
    api.toggleNodeLock(nodeId)
  }

  const toggleVisible = (nodeId: string) => {
    if (!api) return
    api.toggleNodeVisibility(nodeId)
  }

  if (!api) {
    return null
  }

  return (
    <Sheet
      modal={false}
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <SheetContent
        side="right"
        className="w-[320px] min-w-[184px] max-w-[420px] sm:max-w-[420px] bg-background border-l border-border  p-0 shadow-md absolute"
        style={{ width: panelWidth }}
        container={
          document.getElementById(layerPanelAttachContainerId) ?? undefined
        }
        showOverlay={false}
        onInteractOutside={event => event.preventDefault()}
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('legacy:ui_85b5727173ea')}
          className={cn(
            'absolute left-0 top-0 z-20 h-full w-3 -translate-x-1/2 cursor-col-resize touch-none',
            'after:absolute after:left-1/2 after:top-3 after:h-[calc(100%-1.5rem)] after:w-px after:-translate-x-1/2 after:rounded-full after:bg-transparent after:transition-colors',
            'hover:after:bg-border',
            isResizing && 'after:bg-primary/60'
          )}
          onPointerDown={handleResizePointerDown}
        />
        <SheetHeader className="px-4 py-4 border-b border-border">
          <SheetTitle className="text-sm font-semibold text-foreground">
            {t('legacy:ui_2976a08011ca')}
          </SheetTitle>
        </SheetHeader>

        <div className="px-3 py-3 overlay-scrollbar hover-scrollbar h-[calc(100%-60px)]">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={nodes?.map(n => n.id) || []}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-2">
                {nodes && nodes.length > 0 ? (
                  nodes.map(node => (
                    <SortableItem
                      key={node.id}
                      node={node}
                      onFocus={handleFocusNode}
                      onToggleVisible={toggleVisible}
                      onToggleLock={toggleLock}
                    />
                  ))
                ) : (
                  <div className="text-center text-gray-400 dark:text-gray-500 py-12 text-sm">
                    {t('legacy:ui_a48d6d8cbe56')}
                  </div>
                )}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      </SheetContent>
    </Sheet>
  )
}
