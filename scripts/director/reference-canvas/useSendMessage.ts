import { getLocalizedErrorMessage } from '@/i18n/errors'
import { useAtomValue, useAtom } from 'jotai'
import { currentClawSessionKeyAtom, allIsSendingAtom } from '@/store/atoms'
import { whiteboardApiAtom } from './atom'
import { sendClawChatMessage } from '@/hooks/useClawChatController'
import { useMemo } from 'react'
import { runtimeClient } from '@/api/runtimeClient'
import {
  createCanvasQuickEditAttachment,
  persistCanvasQuickEditAttachment,
} from './canvasQuickEditAttachment'
import { CanvasImageCompressionLimitError } from './canvasImageCompression'
import { toast } from 'sonner'

export function useSendMessage() {
  const sessionKey = useAtomValue(currentClawSessionKeyAtom)
  const [allIsSending] = useAtom(allIsSendingAtom)
  const api = useAtomValue(whiteboardApiAtom)

  const isSending = useMemo(() => {
    return allIsSending[sessionKey ?? ''] ?? false
  }, [allIsSending, sessionKey])

  const connectionStatus = runtimeClient.isShellRuntime()
    ? 'connected'
    : 'disconnected'

  const handleSendMessage = async (msg: string) => {
    if (!sessionKey) return

    try {
      const temporaryAttachment = api
        ? await createCanvasQuickEditAttachment({
            api,
            requestId: `canvas-action-${Date.now()}`,
          })
        : null
      const attachment = temporaryAttachment
        ? await persistCanvasQuickEditAttachment(temporaryAttachment)
        : null

      if (!attachment) {
        console.log('canvas 选区为空')
      }

      sendClawChatMessage(
        sessionKey,
        msg,
        attachment ? [attachment.file] : undefined
      )
    } catch (e) {
      console.error('[canvas] 快捷对话发送失败', e)
      toast.error(getLocalizedErrorMessage(e))
    }
  }

  return {
    sendMessage: handleSendMessage,
    isSending,
    connectionStatus,
  }
}
