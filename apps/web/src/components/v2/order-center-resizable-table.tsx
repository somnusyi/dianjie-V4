'use client'

import type { CSSProperties, Key, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

const HEADER_HORIZONTAL_SPACE = 32
const CJK_CHARACTER_WIDTH = 13
const LATIN_CHARACTER_WIDTH = 8
const KEYBOARD_RESIZE_STEP = 8

export type OrderCenterTableColumn<Row> = Readonly<{
  id: string
  header: string
  defaultWidth: number
  minWidth?: number
  align?: 'left' | 'right'
  cellClassName?: string
  renderCell: (row: Row, rowIndex: number) => ReactNode
}>

type DragState = {
  columnId: string
  pointerId: number
  captureTarget: HTMLElement
  startClientX: number
  startWidth: number
}

type OrderCenterResizableTableProps<Row> = {
  ariaLabel: string
  columns: readonly OrderCenterTableColumn<Row>[]
  rows: readonly Row[]
  rowKey: (row: Row, rowIndex: number) => Key
  footer?: ReactNode
}

/**
 * Approximates the width needed to keep a table heading on one line, including
 * the cell padding and resize handle. CJK characters consume a full text unit;
 * latin characters and digits consume roughly half a unit.
 */
export function orderCenterHeaderMinimumWidth(header: string) {
  const textWidth = Array.from(header).reduce((width, character) => {
    return width + (/[^\u0000-\u00ff]/.test(character) ? CJK_CHARACTER_WIDTH : LATIN_CHARACTER_WIDTH)
  }, 0)
  return Math.ceil(textWidth + HEADER_HORIZONTAL_SPACE)
}

export function clampOrderCenterColumnWidth(width: number, minimumWidth: number, maximumWidth: number) {
  const safeMinimum = Math.min(minimumWidth, maximumWidth)
  if (!Number.isFinite(width)) return maximumWidth
  return Math.min(maximumWidth, Math.max(safeMinimum, Math.round(width)))
}

function initialWidths<Row>(columns: readonly OrderCenterTableColumn<Row>[]) {
  return Object.fromEntries(columns.map(column => [column.id, column.defaultWidth]))
}

function minimumWidth<Row>(column: OrderCenterTableColumn<Row>) {
  return Math.min(column.defaultWidth, column.minWidth ?? orderCenterHeaderMinimumWidth(column.header))
}

/**
 * Shared, column-resizable table used by both order and delivery queries.
 * Width state belongs to the mounted table and is intentionally capped at each
 * column's original width. Narrow cells wrap naturally so their rows grow.
 */
export function OrderCenterResizableTable<Row>({
  ariaLabel,
  columns,
  rows,
  rowKey,
  footer,
}: OrderCenterResizableTableProps<Row>) {
  const [widths, setWidths] = useState<Record<string, number>>(() => initialWidths(columns))
  const dragRef = useRef<DragState | null>(null)
  const previousBodyCursorRef = useRef('')
  const previousBodyUserSelectRef = useRef('')

  const columnsById = useMemo(
    () => new Map(columns.map(column => [column.id, column] as const)),
    [columns],
  )

  const tableWidth = columns.reduce((total, column) => total + (widths[column.id] ?? column.defaultWidth), 0)

  function resizeColumn(columnId: string, requestedWidth: number) {
    const column = columnsById.get(columnId)
    if (!column) return
    const nextWidth = clampOrderCenterColumnWidth(
      requestedWidth,
      minimumWidth(column),
      column.defaultWidth,
    )
    setWidths(current => current[columnId] === nextWidth ? current : { ...current, [columnId]: nextWidth })
  }

  function restoreBodyInteraction() {
    document.body.style.cursor = previousBodyCursorRef.current
    document.body.style.userSelect = previousBodyUserSelectRef.current
  }

  function stopDragging(event?: PointerEvent) {
    const drag = dragRef.current
    if (!drag) return
    if (event && event.pointerId !== drag.pointerId) return
    dragRef.current = null
    if (drag.captureTarget.hasPointerCapture?.(drag.pointerId)) {
      drag.captureTarget.releasePointerCapture?.(drag.pointerId)
    }
    restoreBodyInteraction()
  }

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const drag = dragRef.current
      if (!drag || event.pointerId !== drag.pointerId) return
      resizeColumn(drag.columnId, drag.startWidth + event.clientX - drag.startClientX)
    }
    const handleWindowBlur = () => stopDragging()

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopDragging)
    window.addEventListener('pointercancel', stopDragging)
    window.addEventListener('blur', handleWindowBlur)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopDragging)
      window.removeEventListener('pointercancel', stopDragging)
      window.removeEventListener('blur', handleWindowBlur)
      if (dragRef.current) {
        stopDragging()
      }
    }
  }, [columnsById])

  function beginDragging(event: ReactPointerEvent<HTMLElement>, columnId: string) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (dragRef.current) return
    event.preventDefault()
    previousBodyCursorRef.current = document.body.style.cursor
    previousBodyUserSelectRef.current = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = {
      columnId,
      pointerId: event.pointerId,
      captureTarget: event.currentTarget,
      startClientX: event.clientX,
      startWidth: widths[columnId] ?? columnsById.get(columnId)?.defaultWidth ?? 0,
    }
  }

  const tableStyle: CSSProperties = {
    width: tableWidth,
    minWidth: tableWidth,
    maxWidth: tableWidth,
  }

  return (
    <table aria-label={ariaLabel} className="table-fixed text-left text-caption" style={tableStyle}>
      <colgroup>
        {columns.map(column => (
          <col key={column.id} style={{ width: widths[column.id] ?? column.defaultWidth }} />
        ))}
      </colgroup>
      <thead className="bg-bg text-gray3">
        <tr>
          {columns.map(column => {
            const width = widths[column.id] ?? column.defaultWidth
            const min = minimumWidth(column)
            return (
              <th
                key={column.id}
                className={`relative box-border whitespace-nowrap px-4 py-3 ${column.align === 'right' ? 'text-right' : ''}`}
                style={{ width }}
              >
                {column.header}
                <span
                  aria-label={`调整${column.header}列宽`}
                  aria-orientation="vertical"
                  aria-valuemax={column.defaultWidth}
                  aria-valuemin={min}
                  aria-valuenow={width}
                  className="group absolute inset-y-0 right-0 z-10 w-3 cursor-col-resize touch-none outline-none"
                  onDoubleClick={() => resizeColumn(column.id, column.defaultWidth)}
                  onKeyDown={event => {
                    if (event.key === 'ArrowLeft') {
                      event.preventDefault()
                      resizeColumn(column.id, width - KEYBOARD_RESIZE_STEP)
                    } else if (event.key === 'ArrowRight') {
                      event.preventDefault()
                      resizeColumn(column.id, width + KEYBOARD_RESIZE_STEP)
                    } else if (event.key === 'Home') {
                      event.preventDefault()
                      resizeColumn(column.id, min)
                    } else if (event.key === 'End') {
                      event.preventDefault()
                      resizeColumn(column.id, column.defaultWidth)
                    }
                  }}
                  onPointerDown={event => beginDragging(event, column.id)}
                  onLostPointerCapture={() => stopDragging()}
                  role="separator"
                  tabIndex={0}
                  title="拖动调整列宽，双击恢复"
                >
                  <span className="absolute inset-y-2 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-gray3 group-focus:bg-gray3" />
                </span>
              </th>
            )
          })}
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((row, rowIndex) => (
          <tr key={rowKey(row, rowIndex)} className="hover:bg-bg/50">
            {columns.map(column => (
              <td
                key={column.id}
                className={`box-border whitespace-normal break-words px-4 py-4 align-top leading-5 ${column.align === 'right' ? 'text-right' : ''} ${column.cellClassName || ''}`}
              >
                {column.renderCell(row, rowIndex)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
      {footer}
    </table>
  )
}
