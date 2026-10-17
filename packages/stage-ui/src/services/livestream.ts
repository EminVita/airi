import type { InferOutput } from 'valibot'

import type { Batch, Snapshot } from '../libs/livestream/session'

import { defineEventa, defineInvokeEventa } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/broadcast-channel'
import { array, boolean, literal, maxLength, minLength, object, pipe, string, variant } from 'valibot'

const identifier = pipe(string(), minLength(1), maxLength(100))
const direction = pipe(string(), minLength(1), maxLength(200))
const samples = pipe(array(pipe(string(), minLength(1), maxLength(500))), minLength(1), maxLength(40))
/** Validates commands before the stage changes runtime state or starts provider calls. */
export const commandSchema = variant('type', [
  object({ type: literal('start'), characterId: identifier, settings: object({ direction, details: pipe(string(), maxLength(6000)) }) }),
  object({ type: literal('pause'), sessionId: identifier }),
  object({ type: literal('resume'), sessionId: identifier }),
  object({ type: literal('stop'), sessionId: identifier }),
  object({ type: literal('redirect'), sessionId: identifier, direction }),
  object({ type: literal('mock'), sessionId: identifier, enabled: boolean(), samples }),
  object({ type: literal('sample'), sessionId: identifier, samples }),
])

/** The stage is the only host. Controls and collectors send commands or batches through this channel. */
export type LivestreamCommand = InferOutput<typeof commandSchema>

export const livestreamCommand = defineInvokeEventa<{ accepted: boolean }, LivestreamCommand>('eventa:livestream:command')
export const livestreamBatch = defineEventa<Batch>('eventa:livestream:batch')
export const livestreamRequestSnapshot = defineEventa('eventa:livestream:request-snapshot')
export const livestreamSnapshot = defineEventa<{ connected: boolean, state: Snapshot, mockEnabled: boolean }>('eventa:livestream:snapshot')

let context: ReturnType<typeof createContext>['context'] | undefined

/** Shares typed events within the app's renderer origin. External collectors bridge into this event contract. */
export function getLivestreamContext() {
  context ??= createContext(new BroadcastChannel('proj-airi:livestream')).context
  return context
}
