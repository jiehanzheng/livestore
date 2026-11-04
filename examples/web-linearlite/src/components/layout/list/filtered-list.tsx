import { type UIEventHandler, useCallback, useMemo } from 'react'
import { AutoSizer, type SizeProps } from 'react-virtualized-auto-sizer'
import { List } from 'react-window'

import { useDebouncedScrollState } from '../../../livestore/queries.ts'
import { VirtualRow } from './virtual-row.tsx'

const SizedList = ({
  height,
  width,
  data,
  onScroll,
  scrollOffset,
}: {
  height: number
  width: number
  data: readonly number[]
  onScroll: UIEventHandler<HTMLDivElement>
  scrollOffset: number
}) => {
  const style = useMemo(() => ({ height, width }), [height, width])
  const rowProps = useMemo(() => ({ data }), [data])
  return (
    <List
      style={style}
      rowCount={data.length}
      rowHeight={48}
      rowProps={rowProps}
      rowComponent={VirtualRow}
      overscanCount={10}
      onScroll={onScroll}
      defaultScrollOffset={scrollOffset}
    />
  )
}

export const FilteredList = ({ filteredIssueIds }: { filteredIssueIds: readonly number[] }) => {
  const [scrollState, setScrollState] = useDebouncedScrollState('filtered-list')
  const handleScroll = useCallback<UIEventHandler<HTMLDivElement>>(
    (event) => setScrollState({ list: event.currentTarget.scrollTop }),
    [setScrollState],
  )
  const scrollOffset = scrollState.list ?? 0
  const renderList = useCallback(
    ({ height = 0, width = 0 }: SizeProps) => (
      <SizedList
        height={height}
        width={width}
        data={filteredIssueIds}
        onScroll={handleScroll}
        scrollOffset={scrollOffset}
      />
    ),
    [filteredIssueIds, handleScroll, scrollOffset],
  )
  return (
    <div className="grow">
      <AutoSizer renderProp={renderList} />
    </div>
  )
}
