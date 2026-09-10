// import { useAtomValue } from 'jotai'
// import { canvasApiAtom } from '../atom'
// import { useCallback, useEffect, useState } from 'react'

// import { base64ToFile } from '@/lib/file'
// import { Button } from '@/components/ui/shad/button'
// import { MessageSquarePlusIcon } from 'lucide-react'

// export function AddToChatButton() {
//   const api = useAtomValue(canvasApiAtom)
//   const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

//   useEffect(() => {
//     if (!api) {
//       return
//     }

//     const unsub = api.rawApi.onChange((elements, appState) => {
//       //   console.log(elements, appState, files);
//       const selectedIds = appState.selectedElementIds
//       if (Object.keys(selectedIds).length === 0) {
//         setPos(null)

//         return
//       }

//       // 基于所有选中的元素计算位置
//       const selectedElements = elements.filter(
//         element => selectedIds[element.id]
//       )

//       if (selectedElements.some(element => element.type === 'embeddable')) {
//         setPos(null)
//         return
//       }

//       const rightX = selectedElements.reduce(
//         (acc, element) => Math.max(acc, element.x + element.width),
//         -Infinity
//       )

//       const bottomY = selectedElements.reduce(
//         (acc, element) => Math.max(acc, element.y + element.height),
//         -Infinity
//       )

//       const scrollX = appState.scrollX
//       const scrollY = appState.scrollY
//       const zoom = appState.zoom.value
//       const offsetX = (scrollX + rightX) * zoom
//       const offsetY = (scrollY + bottomY) * zoom
//       setPos({ x: offsetX, y: offsetY })
//     })

//     return unsub
//   }, [api])
//   const handleAddToChat = useCallback(async () => {
//     if (!api) {
//       return
//     }

//     try {
//       const dataUrl = await api.exportSelection()
//       if (!dataUrl) {
//         return
//       }

//       const fileName = `from_canvas_${Date.now()}.png`

//       let file: File | null = null
//       if (dataUrl.startsWith('data:')) {
//         file = base64ToFile(dataUrl, fileName)
//       } else {
//         const response = await fetch(dataUrl)
//         const blob = await response.blob()
//         file = new File([blob], fileName, {
//           type: blob.type || 'image/png',
//         })
//       }

//       // await chatFn();
//     } catch (err) {
//       console.error('add to chat failed', err)
//     }
//   }, [api])

//   if (!pos) {
//     return null
//   }

//   return (
//     <div
//       className="floating-menu-container absolute z-10 mt-2 -translate-x-10 -translate-y-12 min-w-max"
//       style={{
//         left: pos.x,
//         top: pos.y,
//       }}
//     >
//       <Button size={'icon'} variant={'default'} onClick={handleAddToChat}>
//         <MessageSquarePlusIcon />
//       </Button>
//     </div>
//   )
// }
