"use client"

import {
  type RowData,
  type TableOptions,
  useReactTable,
} from "@tanstack/react-table"

/**
 * Keeps TanStack Table's intentionally mutable table instance outside React
 * Compiler memoization. TanStack's hook is currently identified by the
 * compiler as incompatible because returned methods cannot be memoized
 * without stale state.
 */
export function useUncompiledReactTable<TData extends RowData>(
  options: TableOptions<TData>
) {
  "use no memo"

  // eslint-disable-next-line react-hooks/incompatible-library -- This isolated, compiler-opted-out boundary is required by TanStack Table's mutable API.
  return useReactTable(options)
}
