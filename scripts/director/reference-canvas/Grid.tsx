import { useEffect, useState } from 'react'
import { whiteboardApiAtom } from './atom'
import { useAtomValue } from 'jotai'

/**
 * Modulate a value between two ranges.
 *
 * @example
 *
 * ```ts
 * const A = modulate(0, [0, 1], [0, 100])
 * ```
 *
 * @param value - The interpolation value.
 * @param rangeA - From [low, high]
 * @param rangeB - To [low, high]
 * @param clamp - Whether to clamp the the result to [low, high]
 * @public
 */
export function modulate(
  value: number,
  rangeA: number[],
  rangeB: number[],
  clamp = false
): number {
  const [fromLow, fromHigh] = rangeA
  const [v0, v1] = rangeB
  const result = v0 + ((value - fromLow) / (fromHigh - fromLow)) * (v1 - v0)

  return clamp
    ? v0 < v1
      ? Math.max(Math.min(result, v1), v0)
      : Math.max(Math.min(result, v0), v1)
    : result
}

const gridSteps = [
  {
    min: -1,
    mid: 0.15,
    step: 64,
  },
  {
    min: 0.05,
    mid: 0.375,
    step: 16,
  },
  {
    min: 0.15,
    mid: 1,
    step: 4,
  },
  {
    min: 0.7,
    mid: 2.5,
    step: 1,
  },
]

export function Grid() {
  const api = useAtomValue(whiteboardApiAtom)
  const [x, setX] = useState(0)
  const [y, setY] = useState(0)
  const [z, setZ] = useState(0.3)
  const [size, setSize] = useState(20)
  const [showGrid, setShowGrid] = useState(true)

  useEffect(() => {
    if (!api) {
      return
    }

    const unsubscribe = api.on('viewport:change', viewport => {
      setX(viewport.x / viewport.scale)
      setY(viewport.y / viewport.scale)
      setZ(viewport.scale)
    })

    return unsubscribe
  }, [api])

  if (!showGrid) {
    return null
  }

  return (
    <svg
      className="canvas-preview-grid w-full h-full absolute top-0 left-0"
      version="1.1"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        {gridSteps.map(({ min, mid, step }, i) => {
          const s = step * size * z
          const xo = 0.5 + x * z
          const yo = 0.5 + y * z
          const gxo = xo > 0 ? xo % s : s + (xo % s)
          const gyo = yo > 0 ? yo % s : s + (yo % s)
          const opacity = z < mid ? modulate(z, [min, mid], [0, 1]) : 1

          return (
            <pattern
              key={i}
              id={`grid_${step}`}
              width={s}
              height={s}
              patternUnits="userSpaceOnUse"
            >
              <circle
                className="tl-grid-dot"
                cx={gxo}
                cy={gyo}
                r={1}
                opacity={opacity}
              />
            </pattern>
          )
        })}
      </defs>
      {gridSteps.map(({ step }, i) => (
        <rect key={i} width="100%" height="100%" fill={`url(#grid_${step})`} />
      ))}
    </svg>
  )
}
