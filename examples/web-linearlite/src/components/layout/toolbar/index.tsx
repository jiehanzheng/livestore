import React from 'react'

import { Icon } from '../../icons/index.tsx'
import { DevtoolsButton } from './devtools-button.tsx'
import { DownloadButton } from './download-button.tsx'
import { ResetButton } from './reset-button.tsx'
import { SeedInput } from './seed-input.tsx'
import { ShareButton } from './share-button.tsx'
import { SyncToggle } from './sync-toggle.tsx'
import { UserInput } from './user-input.tsx'

const FPSMeter = React.lazy(() => import('@overengineering/fps-meter').then(({ FPSMeter }) => ({ default: FPSMeter })))

const ClientFPSMeter = () => {
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => {
    setMounted(true)
  }, [])
  // The meter reads browser APIs; keep its lazy import out of server rendering.
  return mounted === false ? null : (
    <React.Suspense fallback={null}>
      <FPSMeter height={28} className="hidden lg:block" />
    </React.Suspense>
  )
}

export const Toolbar = () => {
  return (
    <div className="w-screen h-10 bg-neutral-950 border-t border-neutral-700 text-neutral-400 flex items-center justify-between pl-1 pr-2">
      <div className="flex items-center gap-1">
        <a
          href="https://livestore.dev/"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 text-sm font-bold rounded text-neutral-300 bg-neutral-900 hover:bg-neutral-800 focus:bg-neutral-800 px-1.5 h-6"
        >
          <Icon name="livestore" className="size-5 mt-0.5" />
          <span>LiveStore</span>
        </a>
        <SyncToggle />
      </div>
      <div className="hidden lg:flex items-center gap-1">
        <UserInput />
        <ShareButton />
      </div>
      <div className="hidden lg:flex items-center gap-1">
        <span>Database:</span>
        <SeedInput />
        <ResetButton />
        <DownloadButton />
        {import.meta.env.DEV && <DevtoolsButton />}
      </div>
      <ClientFPSMeter />
    </div>
  )
}
