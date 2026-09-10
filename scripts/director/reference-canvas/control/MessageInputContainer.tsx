import { MessageInput } from './MessageInput'
import { useSendMessage } from '../useSendMessage'

export function MessageInputContainer() {
  const { sendMessage, isSending, connectionStatus } = useSendMessage()

  return (
    <MessageInput
      onSend={sendMessage}
      disabled={isSending || connectionStatus !== 'connected'}
      placeholder={
        connectionStatus === 'connected'
          ? '输入消息... (Enter 发送, Shift+Enter 换行)'
          : '服务启动中...'
      }
    />
  )
}
