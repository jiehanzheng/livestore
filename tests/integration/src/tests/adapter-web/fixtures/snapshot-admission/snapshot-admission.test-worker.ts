import { makeWorker } from '@livestore/adapter-web/worker'

import { schema } from './snapshot-admission.test-schema.ts'

makeWorker({ schema })
