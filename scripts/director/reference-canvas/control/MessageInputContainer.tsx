import { MessageInput } from './MessageInput'
import { useSendMessage } from '../useSendMessage'

export function MessageInputContainer() {
  const { sendMessage, connectionStatus } = useSendMessage()

  return (
    <MessageInput
      onSend={sendMessage}
      // A running task must not lock the canvas composer.  The message is
      // queued by the active conversation and can be consumed after the
      // current generation step finishes.
      disabled={connectionStatus !== 'connected'}
      placeholder={
        connectionStatus === 'connected'
          ? '输入消息... (Enter 发送, Shift+Enter 换行)'
          : '服务启动中...'
      }
    />
  )
}
