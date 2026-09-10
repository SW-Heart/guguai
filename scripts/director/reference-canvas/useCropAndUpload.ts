import { useCallback } from 'react'
import { useUploadFn } from '@/hooks/useUploadFn'
import {
  CanvasImageCompressionLimitError,
  prepareCanvasImageFile,
} from './canvasImageCompression'

const base64ToBlob = (base64: any) => {
  const [header, data] = base64.split(',')
  const mime = header.match(/:(.*?);/)[1]
  const binary = atob(data) // 解码 base64
  const array = []
  for (let i = 0; i < binary.length; i++) {
    array.push(binary.charCodeAt(i))
  }
  return new Blob([new Uint8Array(array)], { type: mime })
}

const assertUploadedUrl = (url: string, kind: string) => {
  if (!url || typeof url !== 'string') {
    throw new Error(`${kind} upload returned empty url`)
  }
  return url
}

/**
 * 图片截取和上传 Hook
 */
export const useCropAndUpload = () => {
  const uploadFn = useUploadFn()

  /**
   * 根据start和end截取图片并上传
   * @param imageUrl 原始图片URL
   * @param start 起始位置 {percentX, percentY}
   * @param end 结束位置 {percentX, percentY}
   * @param fileName 生成的文件名
   * @returns 上传后的previewUrl
   */
  const cropAndUploadImage = useCallback(
    async (
      imageUrl: string,
      start: { ratioX: number; ratioY: number },
      end: { ratioX: number; ratioY: number },
      fileName: string,
      sessionId: string
    ): Promise<string> => {
      return new Promise((resolve, reject) => {
        if (!sessionId) {
          reject(new Error('Session ID is required'))
          return
        }

        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        const img = new Image()

        img.onload = async () => {
          try {
            console.log('Image loaded:', {
              width: img.width,
              height: img.height,
              start,
              end,
            })

            // 验证百分比值的有效性（百分制：0-100）
            const isValidPercent = (val: number) =>
              typeof val === 'number' && val >= 0 && val <= 1

            if (
              !isValidPercent(start.ratioX) ||
              !isValidPercent(start.ratioY) ||
              !isValidPercent(end.ratioX) ||
              !isValidPercent(end.ratioY)
            ) {
              reject(
                new Error(
                  `Invalid percentage values: start=${JSON.stringify(
                    start
                  )}, end=${JSON.stringify(end)}`
                )
              )
              return
            }

            // 计算截取区域（将百分制转换为小数制）
            let startX = Math.min(start.ratioX, end.ratioX) * img.width
            let startY = Math.min(start.ratioY, end.ratioY) * img.height
            let width = Math.abs(end.ratioX - start.ratioX) * img.width
            let height = Math.abs(end.ratioY - start.ratioY) * img.height

            // 设置最小尺寸（至少10像素）
            const minSize = 10
            if (width < minSize) {
              width = minSize
              startX = Math.max(0, Math.min(startX, img.width - width))
            }
            if (height < minSize) {
              height = minSize
              startY = Math.max(0, Math.min(startY, img.height - height))
            }

            // 确保截取区域不超出图片边界
            const clampedStartX = Math.max(0, Math.min(startX, img.width - 1))
            const clampedStartY = Math.max(0, Math.min(startY, img.height - 1))
            const clampedWidth = Math.min(width, img.width - clampedStartX)
            const clampedHeight = Math.min(height, img.height - clampedStartY)

            console.log('Clamped crop area:', {
              clampedStartX,
              clampedStartY,
              clampedWidth,
              clampedHeight,
            })

            // 最终验证
            if (clampedWidth <= 0 || clampedHeight <= 0) {
              // 如果还是无效，使用整个图片作为fallback
              console.warn(
                'Using full image as fallback due to invalid crop area'
              )
              canvas.width = img.width
              canvas.height = img.height

              if (ctx) {
                ctx.drawImage(img, 0, 0)
              } else {
                reject(new Error('Failed to get canvas context'))
                return
              }
            } else {
              // 设置canvas尺寸
              canvas.width = clampedWidth
              canvas.height = clampedHeight

              console.log('Canvas dimensions set:', {
                width: canvas.width,
                height: canvas.height,
              })

              // 截取图片区域
              if (ctx) {
                ctx.drawImage(
                  img,
                  clampedStartX,
                  clampedStartY,
                  clampedWidth,
                  clampedHeight,
                  0,
                  0,
                  clampedWidth,
                  clampedHeight
                )
              } else {
                reject(new Error('Failed to get canvas context'))
                return
              }
            }

            console.log('Image drawn to canvas')

            // 转换为blob
            canvas.toBlob(
              async blob => {
                console.log('toBlob callback called, blob:', blob)

                if (!blob) {
                  reject(new Error('Failed to export cropped image blob'))
                  return
                }

                // 创建文件对象
                const file = new File([blob], fileName, { type: 'image/png' })

                try {
                  const prepared = await prepareCanvasImageFile(file)
                  if (!prepared.ok) {
                    throw new CanvasImageCompressionLimitError(file.name)
                  }
                  // 上传文件
                  const result = await uploadFn({
                    task_id: sessionId,
                    fileName: prepared.file.name,
                    file: prepared.file,
                  })

                  // 返回上传后的URL
                  resolve(assertUploadedUrl(result, 'preview image'))
                } catch (uploadError) {
                  reject(uploadError)
                }
              },
              'image/png',
              1
            )
          } catch (error) {
            reject(error)
          }
        }

        img.onerror = () => {
          reject(new Error('Failed to load image'))
        }

        // 处理跨域问题
        img.crossOrigin = 'anonymous'
        img.src = imageUrl
      })
    },
    [uploadFn]
  )

  /**
   * 上传base64图片
   * @param base64Data base64格式的图片数据
   * @param fileName 文件名
   * @returns 上传后的URL
   */
  const uploadBase64Image = useCallback(
    async (
      base64Data: string,
      fileName: string,
      sessionId: string
    ): Promise<string> => {
      if (!sessionId) {
        throw new Error('Session ID is required')
      }

      // 将base64转换为blob
      // base64太大时，部分浏览器会抛出错误
      // const response = await fetch(base64Data)
      const blob = base64ToBlob(base64Data)

      if (!blob) {
        throw new Error('Failed to convert base64 to blob')
      }

      // 创建文件对象
      const file = new File([blob], fileName, { type: 'image/png' })
      const prepared = await prepareCanvasImageFile(file)
      if (!prepared.ok) {
        throw new CanvasImageCompressionLimitError(file.name)
      }

      // 上传文件
      const result = await uploadFn({
        task_id: sessionId,
        fileName: prepared.file.name,
        file: prepared.file,
      })

      // 返回上传后的URL
      return assertUploadedUrl(result, 'marked image')
    },
    [uploadFn]
  )

  return {
    cropAndUploadImage,
    uploadBase64Image,
  }
}
