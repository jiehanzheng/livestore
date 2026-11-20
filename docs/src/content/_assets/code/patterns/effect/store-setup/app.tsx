import { Suspense, useState } from 'react'
import { unstable_batchedUpdates } from 'react-dom'
import { ErrorBoundary } from 'react-error-boundary'

import { StoreRegistry } from '@livestore/livestore'
import { StoreRegistryProvider } from '@livestore/react'

import { CompleteAllButton } from '../batch-example/batch.tsx'
import { TodoStats } from '../derived-example/derived.tsx'
import { CreateTodo } from './services.tsx'
import { TodoList } from './todo-list.tsx'

const renderLoadError = ({ error }: { error: unknown }) => (
  <p role="alert">Could not load todos: {error instanceof Error ? error.message : 'Unknown application error'}</p>
)
const loadingFallback = <p>Opening saved todos…</p>

export const App = () => {
  const [storeRegistry] = useState(
    () => new StoreRegistry({ defaultOptions: { batchUpdates: unstable_batchedUpdates } }),
  )
  return (
    <StoreRegistryProvider storeRegistry={storeRegistry}>
      <ErrorBoundary fallbackRender={renderLoadError}>
        <Suspense fallback={loadingFallback}>
          <CreateTodo />
          <TodoList />
          <TodoStats />
          <CompleteAllButton />
        </Suspense>
      </ErrorBoundary>
    </StoreRegistryProvider>
  )
}
