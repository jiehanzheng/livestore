import type { RowComponentProps } from 'react-window'

import { queryDb } from '@livestore/livestore'

import { tables } from '../../../livestore/schema/index.ts'
import { useAppStore } from '../../../livestore/store.ts'
import { Row } from './row.tsx'

const rowStyle = { height: '100%' } as const

export const VirtualRow = ({ data, index, style, ariaAttributes }: RowComponentProps<{ data: readonly number[] }>) => {
  const store = useAppStore()
  const issue = store.useQuery(
    queryDb(tables.issue.where({ id: data[index]! }).first({ behaviour: 'error' }), { deps: [data[index]] }),
  )
  // Keep list-item ARIA metadata separate from the row's keyboard button semantics.
  return (
    <div
      {...ariaAttributes}
      style={style}
      className="border-b last:border-b-0 border-neutral-200 dark:border-neutral-700"
    >
      <Row key={`issue-${issue.id}`} issue={issue} style={rowStyle} />
    </div>
  )
}
