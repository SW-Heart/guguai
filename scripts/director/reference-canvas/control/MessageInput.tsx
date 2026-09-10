import i18n from '@/i18n'
import { useTranslation } from 'react-i18next'
import { memo, useState, useRef, useCallback, type KeyboardEvent } from 'react'
import { Sparkles, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface MessageInputProps {
  onSend: (message: string) => void
  disabled?: boolean
  placeholder?: string
  className?: string
}

export const MessageInput = memo<MessageInputProps>(
  ({
    onSend,
    disabled = false,
    placeholder,
    className,
  }) => {
    const { t } = useTranslation()
    const effectivePlaceholder =
      placeholder ?? t('common:input.placeholderEdit')
    const [message, setMessage] = useState('')
    const textareaRef = useRef<HTMLTextAreaElement>(null)

    // 自动调整文本框高度
    const adjustHeight = useCallback(() => {
      const textarea = textareaRef.current
      if (!textarea) return

      textarea.style.height = 'auto'
      const newHeight = Math.min(textarea.scrollHeight, 200) // 最大200px
      textarea.style.height = `${newHeight}px`
    }, [])

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setMessage(e.target.value)
      adjustHeight()
    }

    const handleSend = useCallback(() => {
      const trimmed = message.trim()
      if (!trimmed || disabled) return

      onSend(trimmed)
      setMessage('')

      // 重置高度
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    }, [message, disabled, onSend])

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Ctrl/Cmd + Enter 发送
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        handleSend()
      }
      // Enter 发送（Shift + Enter 换行）
      else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    }

    return (
      <div
        className={cn(
          'bg-background border border-solid border-border rounded-lg',
          className
        )}
      >
        <div
          className={cn(
            'rounded-[14px]  bg-background p-4 pb-2 relative z-[1]'
          )}
        >
          {/* 输入框 */}
          <textarea
            ref={textareaRef}
            value={message}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={effectivePlaceholder}
            disabled={disabled}
            rows={1}
            className="w-full text-foreground  text-sm font-medium resize-none rounded-lg border-none  bg-background  focus:outline-none  disabled:cursor-not-allowed disabled:opacity-50 scrollbar-hidden"
            style={{ minHeight: '60px', maxHeight: '60px' }}
          />

          <div className="w-full flex justify-between items-end ">
            <div></div>
            {/* 发送按钮 */}
            <button
              onClick={handleSend}
              disabled={disabled || !message.trim()}
              className={cn(
                'flex justify-center items-center w-9 h-9 bg-[#171717]  rounded-lg transition-colors',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                message.trim() && !disabled ? '' : 'opacity-[1/2]'
              )}
              aria-label={i18n.t('legacy:ui_94306b2fc35c')}
              tabIndex={0}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  handleSend()
                }
              }}
            >
              {disabled ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4 text-[#FAFAFA]" />
              )}
            </button>
          </div>
        </div>
      </div>
    )
  }
)
