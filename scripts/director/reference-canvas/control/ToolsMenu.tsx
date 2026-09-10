import i18n from '@/i18n'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/shad/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/shad/dropdown-menu'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/shad/popover'
import { StrokeControls, type RgbaColor, rgbaToString } from './StrokeControls'
import './ColorAndStrokeWidthPanel.css'
import {
  ArrowRightIcon,
  BrushIcon,
  CircleIcon,
  CircleHelpIcon,
  DiamondIcon,
  FocusIcon,
  HexagonIcon,
  ImagePlusIcon,
  Layers2Icon,
  MapPinPlusIcon,
  MoreHorizontalIcon,
  MousePointer2Icon,
  MoveIcon,
  SquareIcon,
  StarIcon,
  TriangleIcon,
  TypeIcon,
} from 'lucide-react'
import { curveArrowToolActiveAtom, whiteboardApiAtom } from '../atom'
import { useAtom, useAtomValue } from 'jotai'
import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'

import { ATTACHMENT_TYPE_MAP, AttachmentType } from '@/api/types'
import { insertImageBesideCanvasContent } from '../utils'
import { normalizeClawMediaUrl } from '@/lib/claw'
import { LayerPanel } from './LayerPanel'
import MyTooltip from '@/components/ui/MyToolTip'
import { fileClient } from '@/api/fileClient'
import { arrayBufferToBase64 } from '@/lib/file'
import { toast } from 'sonner'
import {
  getCanvasImageCompressionFailureMessage,
  pickCanvasImageFiles,
  prepareCanvasImageFile,
} from '../canvasImageCompression'
import {
  CANVAS_DEFAULT_ANNOTATION_COLOR,
  CANVAS_DEFAULT_ANNOTATION_RGBA,
} from '../canvasStyleDefaults'

type ToolType =
  | 'select'
  | 'rectangle'
  | 'ellipse'
  | 'arrow'
  | 'line'
  | 'brush'
  | 'rich-text'
  | 'image'
  | 'hand'
  | 'image-marker'
  | 'star'
  | 'triangle'
  | 'diamond'
  | 'hexagon'

const toolDefinitions = [
  {
    icon: <MousePointer2Icon />,
    name: 'select',
    labelKey: 'legacy:ui_70b208202ce5',
  },
  {
    icon: <MoveIcon />,
    name: 'hand',
    labelKey: 'legacy:ui_f570ce0202d0',
  },
  null,
  {
    icon: <ImagePlusIcon />,
    name: 'image',
    labelKey: 'legacy:ui_e53930199cea',
  },
  {
    icon: <SquareIcon />,
    name: 'rectangle',
    labelKey: 'legacy:ui_b5d5ad392338',
  },
  {
    icon: <ArrowRightIcon />,
    name: 'arrow',
    labelKey: 'legacy:ui_890a6158d5b7',
  },
  {
    icon: <MapPinPlusIcon />,
    name: 'image-marker',
    labelKey: 'legacy:ui_5fca692ad7a7',
  },
  // {
  //   icon: <CircleIcon />,
  //   name: 'ellipse',
  // },
  // {
  //   icon: <SlashIcon />,
  //   name: 'line',
  // },
  {
    icon: <TypeIcon />,
    name: 'rich-text',
    labelKey: 'legacy:ui_f1926e9b3365',
  },
  {
    icon: <BrushIcon />,
    name: 'brush',
    labelKey: 'legacy:ui_203114dfc05c',
  },
  {
    icon: <MoreHorizontalIcon />,
    name: '$more',
    labelKey: 'legacy:ui_9b0c6c7858bf',
  },
  null,
  {
    icon: <FocusIcon />,
    name: '$scrollToContent',
    labelKey: 'legacy:ui_ae073ced107e',
  },
  {
    icon: <Layers2Icon />,
    name: '$toggleLayerPanel',
    labelKey: 'legacy:ui_ec4bca7dcc30',
  },
]

export function ToolsMenu() {
  const { t } = useTranslation()
  const tools = toolDefinitions.map(tool =>
    tool ? { ...tool, label: t(tool.labelKey) } : tool
  )
  const whiteboardApi = useAtomValue(whiteboardApiAtom)
  const [curveArrowToolActive, setCurveArrowToolActive] = useAtom(
    curveArrowToolActiveAtom
  )
  const [activeTool, setActiveTool] = useState<string | undefined>(undefined)
  const [layerPanelOpen, setLayerPanelOpen] = useState(false)
  const [brushPopoverOpen, setBrushPopoverOpen] = useState(false)
  const [brushStrokeWidth, setBrushStrokeWidth] = useState(4)
  const [brushStrokeColor, setBrushStrokeColor] = useState(
    CANVAS_DEFAULT_ANNOTATION_COLOR
  )
  const [brushCustomColor, setBrushCustomColor] = useState<RgbaColor>({
    ...CANVAS_DEFAULT_ANNOTATION_RGBA,
  })
  const handlePickImage = async () => {
    try {
      const files = await pickCanvasImageFiles({
        accept: ATTACHMENT_TYPE_MAP[AttachmentType.IMAGES]
          .map(extension => `.${extension}`)
          .join(','),
        multiple: false,
      })
      const file = files[0]
      if (!file) return

      const prepared = await prepareCanvasImageFile(file)
      if (!prepared.ok) {
        toast.error(getCanvasImageCompressionFailureMessage(file.name))
        return
      }

      const base64 = arrayBufferToBase64(await prepared.file.arrayBuffer())
      const localPath = await fileClient.saveUpload({
        base64,
        fileName: prepared.file.name,
      })
      await insertImageBesideCanvasContent(
        whiteboardApi,
        normalizeClawMediaUrl(localPath)
      )
    } catch (error) {
      console.error('选择文件出错:', error)
      toast.error(i18n.t('legacy:ui_47bb3e7c4bb5'))
    }
  }

  const handleToolChange = (
    tool: ToolType | '$scrollToContent' | '$toggleLayerPanel'
  ) => {
    if (tool !== 'arrow') {
      if (curveArrowToolActive) {
        whiteboardApi?.setToolType('select')
      }
      setCurveArrowToolActive(false)
    }

    if (tool === '$scrollToContent') {
      whiteboardApi?.scrollToContent()
      return
    }
    if (tool === '$toggleLayerPanel') {
      setLayerPanelOpen(prev => !prev)
      return
    }
    if (tool === 'select') {
      whiteboardApi?.setToolType('select')
      return
    }
    if (tool === 'hand') {
      whiteboardApi?.setToolType('hand')
      return
    }
    if (tool === 'rectangle') {
      whiteboardApi?.setToolType('rectangle', { strokeWidth: 8 })
      return
    }
    if (tool === 'image-marker') {
      whiteboardApi?.setToolType('image-marker')
      return
    }
    if (tool === 'image') {
      handlePickImage()
      return
    }
    if (tool === 'rich-text') {
      whiteboardApi?.setToolType('rich-text')
      return
    }
    if (tool === 'star') {
      whiteboardApi?.setToolType('star', { strokeWidth: 8 })
      return
    }
    if (tool === 'ellipse') {
      whiteboardApi?.setToolType('ellipse', { strokeWidth: 8 })
      return
    }
    if (tool === 'arrow') {
      flushSync(() => {
        setCurveArrowToolActive(true)
      })
      return
    }
    if (tool === 'triangle') {
      whiteboardApi?.setToolType('polygon', {
        $_shape: 'triangle',
        strokeWidth: 8,
      })
      return
    }
    if (tool === 'diamond') {
      whiteboardApi?.setToolType('polygon', {
        $_shape: 'diamond',
        strokeWidth: 8,
      })
      return
    }
    if (tool === 'hexagon') {
      whiteboardApi?.setToolType('polygon', {
        $_shape: 'hexagon',
        strokeWidth: 8,
      })
      return
    }
    if (tool === 'brush') {
      whiteboardApi?.setToolType('brush', {
        strokeWidth: brushStrokeWidth,
        $_strokeColor: brushStrokeColor,
      } as Parameters<typeof whiteboardApi.setToolType>[1])
      setBrushPopoverOpen(true)
      return
    }
  }

  const applyBrushStrokeWidth = (w: number) => {
    setBrushStrokeWidth(w)
    whiteboardApi?.setToolType('brush', {
      strokeWidth: w,
      $_strokeColor: brushStrokeColor,
    } as Parameters<typeof whiteboardApi.setToolType>[1])
  }

  const applyBrushStrokeColor = (color: string) => {
    setBrushStrokeColor(color)
    whiteboardApi?.setToolType('brush', {
      strokeWidth: brushStrokeWidth,
      $_strokeColor: color,
    } as Parameters<typeof whiteboardApi.setToolType>[1])
  }

  useEffect(() => {
    if (!whiteboardApi) return
    const type = whiteboardApi.getToolType()
    const meta = whiteboardApi.getToolMeta()
    if (type === 'polygon') {
      setActiveTool(type + '-' + meta?.$_shape)
    } else {
      setActiveTool(type)
    }

    const handleToolTypeChange = (t: {
      type: string
      meta?: Record<string, any>
    }) => {
      if (t.type === 'polygon') {
        setActiveTool(t?.meta?.$_shape)
      } else {
        setActiveTool(t.type)
      }
    }

    whiteboardApi.on('toolType:change', handleToolTypeChange)
    return () => {
      whiteboardApi.off('toolType:change', handleToolTypeChange)
    }
  }, [whiteboardApi])

  const shortcutSections = [
    {
      title: t('legacy:ui_6a4167e2ca90'),
      items: [
        {
          key: t('common:canvas.shortcuts.doubleClickCanvas'),
          desc: t('common:canvas.shortcuts.doubleClickCanvasDescription'),
        },
        {
          key: t('common:canvas.shortcuts.dragImage'),
          desc: t('common:canvas.shortcuts.dragImageDescription'),
        },
      ],
    },
    {
      title: t('legacy:ui_eb1b095016fa'),
      items: [
        { key: 'V', desc: t('common:canvas.shortcuts.selectTool') },
        { key: 'H', desc: t('common:canvas.shortcuts.handTool') },
        { key: 'M', desc: t('common:canvas.shortcuts.rectangleTool') },
        { key: 'U', desc: t('common:canvas.shortcuts.ellipseTool') },
        { key: 'P', desc: t('common:canvas.shortcuts.arrowTool') },
        { key: 'T', desc: t('common:canvas.shortcuts.textTool') },
        { key: 'B', desc: t('common:canvas.shortcuts.brushTool') },
        { key: 'S', desc: t('common:canvas.shortcuts.starTool') },
        { key: 'I', desc: t('common:canvas.shortcuts.precisionEdit') },
        {
          key: t('common:canvas.shortcuts.holdSpace'),
          desc: t('common:canvas.shortcuts.temporaryHand'),
        },
        { key: 'Escape', desc: t('common:canvas.shortcuts.escape') },
      ],
    },
    {
      title: t('legacy:ui_15d63423f977'),
      items: [
        { key: 'Ctrl+Z', desc: t('common:canvas.shortcuts.undo') },
        { key: 'Ctrl+Shift+Z', desc: t('common:canvas.shortcuts.redo') },
      ],
    },
    {
      title: t('legacy:ui_0005d0c68653'),
      items: [
        {
          key: 'Delete / Backspace',
          desc: t('common:canvas.shortcuts.deleteNodes'),
        },
        { key: 'Ctrl+A', desc: t('common:canvas.shortcuts.selectAll') },
        { key: 'Ctrl+C', desc: t('common:canvas.shortcuts.copyNodes') },
        { key: 'Ctrl+V', desc: t('common:canvas.shortcuts.pasteNodes') },
        { key: 'Ctrl+J', desc: t('common:canvas.shortcuts.duplicateNodes') },
      ],
    },
    {
      title: t('legacy:ui_4722e32d8961'),
      items: [
        { key: ']', desc: t('common:canvas.shortcuts.moveLayerUp') },
        { key: '[', desc: t('common:canvas.shortcuts.moveLayerDown') },
        { key: 'Ctrl+Shift+]', desc: t('common:canvas.shortcuts.moveToTop') },
        {
          key: 'Ctrl+Shift+[',
          desc: t('common:canvas.shortcuts.moveToBottom'),
        },
      ],
    },
    {
      title: t('legacy:ui_5dda4d9c203b'),
      items: [
        { key: 'Ctrl+= / Ctrl++', desc: t('common:canvas.shortcuts.zoomIn') },
        { key: 'Ctrl+-', desc: t('common:canvas.shortcuts.zoomOut') },
        { key: 'Ctrl+0', desc: t('common:canvas.shortcuts.fitToScreen') },
        { key: 'Ctrl+1', desc: t('common:canvas.shortcuts.resetZoom') },
      ],
    },
  ]
  const shortcutCount = shortcutSections.reduce(
    (count, section) => count + section.items.length,
    0
  )

  return (
    <>
      <div className="flex items-center gap-2">
        {tools.map((it, idx) => {
          if (!it) {
            return <div key={idx} className="w-px h-5 bg-[#e5e5e5]" />
          }
          if (it.name === '$more') {
            const moreToolActive = [
              'star',
              'ellipse',
              'triangle',
              'diamond',
              'hexagon',
            ].includes(activeTool ?? '')
            return (
              <DropdownMenu key={it.name}>
                <MyTooltip content={it.label} side="bottom">
                  <DropdownMenuTrigger asChild>
                    <Button
                      size={'icon'}
                      variant={moreToolActive ? 'secondary' : 'ghost'}
                      aria-label={it.label}
                    >
                      <MoreHorizontalIcon />
                    </Button>
                  </DropdownMenuTrigger>
                </MyTooltip>
                <DropdownMenuContent side="bottom">
                  <DropdownMenuItem onClick={() => handleToolChange('star')}>
                    <StarIcon />
                    <span>{t('legacy:ui_4ea7857de8cb')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleToolChange('ellipse')}>
                    <CircleIcon />
                    <span>{t('legacy:ui_229298d292b0')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => handleToolChange('triangle')}
                  >
                    <TriangleIcon />
                    <span>{t('legacy:ui_0a876c1b3fea')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleToolChange('diamond')}>
                    <DiamondIcon />
                    <span>{t('legacy:ui_ce8122feb121')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleToolChange('hexagon')}>
                    <HexagonIcon />
                    <span>{t('legacy:ui_ac60b7f331f8')}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )
          }
          if (it.name === 'brush') {
            return (
              <Popover
                key={it.name}
                open={brushPopoverOpen}
                onOpenChange={setBrushPopoverOpen}
              >
                <MyTooltip content={it.label} side="bottom">
                  <PopoverTrigger asChild>
                    <Button
                      onClick={() => handleToolChange('brush')}
                      size={'icon'}
                      variant={activeTool === 'brush' ? 'secondary' : 'ghost'}
                      aria-label={it.label}
                    >
                      <BrushIcon />
                    </Button>
                  </PopoverTrigger>
                </MyTooltip>
                <PopoverContent
                  side="bottom"
                  className="p-3 w-auto border-none shadow-xl rounded-xl bg-popover"
                >
                  <StrokeControls
                    strokeWidth={brushStrokeWidth}
                    strokeColor={brushStrokeColor}
                    customColor={brushCustomColor}
                    onStrokeWidthChange={applyBrushStrokeWidth}
                    onStrokeColorChange={applyBrushStrokeColor}
                    onCustomColorChange={color => {
                      setBrushCustomColor(color)
                      applyBrushStrokeColor(rgbaToString(color))
                    }}
                  />
                </PopoverContent>
              </Popover>
            )
          }
          return (
            <MyTooltip key={it.name} content={it.label} side="bottom">
              <Button
                onClick={() => handleToolChange(it.name as ToolType)}
                size={'icon'}
                variant={
                  it.name === 'arrow'
                    ? curveArrowToolActive
                      ? 'secondary'
                      : 'ghost'
                    : it.name === 'hand' && curveArrowToolActive
                      ? 'ghost'
                      : activeTool === it.name
                        ? 'secondary'
                        : 'ghost'
                }
                aria-label={it.label}
              >
                {it.icon}
              </Button>
            </MyTooltip>
          )
        })}
        <div className="w-px h-5 bg-[#e5e5e5]" />
        <Popover>
          <MyTooltip content={t('legacy:ui_021cf99c0d67')} side="bottom">
            <PopoverTrigger asChild>
              <Button
                size={'icon'}
                variant={'ghost'}
                aria-label={t('legacy:ui_021cf99c0d67')}
              >
                <CircleHelpIcon />
              </Button>
            </PopoverTrigger>
          </MyTooltip>
          <PopoverContent
            side="bottom"
            align="end"
            className="w-[24rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-md"
          >
            <div className="border-b border-border bg-background px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <CircleHelpIcon className="size-4 text-muted-foreground" />
                    {t('legacy:ui_021cf99c0d67')}
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t('legacy:ui_ebdd084ae67d')}
                  </p>
                </div>
                <div className="shrink-0 rounded-md border border-border bg-muted px-2.5 py-1.5 text-right">
                  <div className="text-[10px] text-muted-foreground">
                    {t('legacy:ui_3af1ac5b4efe')}
                  </div>
                  <div className="text-sm font-semibold leading-none text-foreground">
                    {shortcutCount}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="rounded-md border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                  <span className="font-mono font-medium text-foreground">
                    +
                  </span>{' '}
                  {t('legacy:ui_d87d9aca7f9e')}
                </span>
                <span className="rounded-md border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                  <span className="font-mono font-medium text-foreground">
                    /
                  </span>{' '}
                  {t('legacy:ui_23154e8310ce')}
                </span>
              </div>
            </div>
            <div className="hover-scrollbar max-h-[70vh] overlay-scrollbar hover-scrollbar p-3">
              <div className="space-y-3">
                {shortcutSections.map(section => (
                  <section
                    key={section.title}
                    className="overflow-hidden rounded-lg border border-border bg-background"
                  >
                    <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
                      <div className="text-xs font-medium text-foreground">
                        {section.title}
                      </div>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {section.items.length} {t('legacy:ui_64728a772742')}
                      </span>
                    </div>
                    <div className="px-2 py-1">
                      {section.items.map(item => (
                        <div
                          key={item.key}
                          className="flex min-h-10 items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted/60"
                        >
                          <span className="min-w-0 text-xs leading-5 text-foreground">
                            {item.desc}
                          </span>
                          <kbd className="shrink-0 whitespace-nowrap rounded-md border border-border bg-muted px-2 py-1 font-mono text-[11px] font-medium text-foreground shadow-xs">
                            {item.key}
                          </kbd>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <LayerPanel
        api={whiteboardApi}
        open={layerPanelOpen}
        onClose={() => setLayerPanelOpen(false)}
      />
    </>
  )
}
