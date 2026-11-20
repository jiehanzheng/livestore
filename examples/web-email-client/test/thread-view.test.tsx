import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }))
vi.mock('@livestore/react', () => ({ useStore: () => ({ useQuery }) }))
vi.mock('../src/stores/thread/index.ts', () => ({ threadStoreOptions: (id: string) => ({ storeId: id }) }))
vi.mock('../src/stores/mailbox/index.ts', () => ({ useMailboxStore: () => ({ useQuery: () => [] }) }))
vi.mock('../src/components/ThreadActions.tsx', () => ({ ThreadActions: () => null }))

import { ThreadView } from '../src/components/ThreadView.tsx'

const thread = { id: 'thread-1', subject: 'Retained thread', participants: '["alice@example.test"]' }
const render = (rows: (typeof thread)[]) => {
  useQuery.mockReturnValueOnce(rows).mockReturnValueOnce([]).mockReturnValueOnce([])
  return renderToStaticMarkup(<ThreadView threadId="thread-1" />)
}

describe('thread metadata availability', () => {
  beforeEach(() => useQuery.mockReset())

  it('explains a missing local record without crashing or an indefinite loading indicator', () => {
    expect(render([])).toContain('This thread is not available on this device.')
  })

  it('renders metadata for a separately supplied nonempty query result', () => {
    render([])
    const html = render([thread])
    expect(html).toContain('Retained thread')
    expect(html).toContain('alice@example.test')
    expect(html).not.toContain('not available')
  })

  it('renders retained metadata immediately without a network readiness dependency', () => {
    expect(render([thread])).toContain('Retained thread')
  })
})
