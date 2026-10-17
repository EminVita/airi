<script setup lang="ts">
import type { Settings, Snapshot } from '../../../../libs/livestream/session'
import type { LivestreamCommand } from '../../../../services/livestream'

import { defineInvoke } from '@moeru/eventa'
import { errorMessageFrom } from '@moeru/std'
import { Button, FieldInput, GhostButton } from '@proj-airi/ui'
import { computed, onMounted, onScopeDispose, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

import LivestreamRehearsal from './livestream-rehearsal.vue'

import { getLivestreamContext, livestreamCommand, livestreamRequestSnapshot, livestreamSnapshot } from '../../../../services/livestream'
import { useLivestreamSettingsStore } from '../../../../stores/livestream-settings'

const props = defineProps<{ characterId: string, standalone?: boolean, unsaved?: boolean }>()
const emit = defineEmits<{ configure: [route: '/settings/livestream'] }>()
const { t } = useI18n()
const settings = useLivestreamSettingsStore()
const opened = shallowRef(!!props.standalone)
const direction = computed(() => settings.saved.config.direction)
const details = computed(() => settings.saved.config.details)
const mode = shallowRef<Settings['mode']>('text')
const nickname = shallowRef('')
const message = shallowRef('')
const guidance = shallowRef('')
const connected = shallowRef(false)
const pending = shallowRef(false)
const error = shallowRef('')
const state = shallowRef<Snapshot>()
const mockEnabled = shallowRef(false)
const active = computed(() => state.value?.phase === 'running')
const paused = computed(() => state.value?.phase === 'paused')
const canStart = computed(() => connected.value && !props.unsaved && !active.value && !paused.value
  && direction.value.trim().length > 0 && direction.value.length <= 200
  && details.value.length <= 12000 && (mode.value === 'speech' || details.value.trim().length > 0))
const context = getLivestreamContext()
const invoke = defineInvoke(context, livestreamCommand)
const stopSnapshot = context.on(livestreamSnapshot, ({ body }) => {
  if (!body)
    return
  connected.value = body.connected
  state.value = body.state
  mockEnabled.value = body.mockEnabled
})
onMounted(() => context.emit(livestreamRequestSnapshot, undefined))
onScopeDispose(stopSnapshot)

async function send(command: LivestreamCommand) {
  pending.value = true
  error.value = ''
  try {
    const result = await invoke(command, { signal: AbortSignal.timeout(8000) })
    if (!result.accepted)
      error.value = t('stage.livestream.rejected')
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? t('stage.livestream.unavailable')
  }
  finally {
    pending.value = false
  }
}

function control(type: 'pause' | 'resume' | 'stop') {
  if (state.value)
    void send({ type, sessionId: state.value.sessionId })
}

function sample(automatic: boolean) {
  if (!state.value)
    return
  const samples = Array.from({ length: 16 }, (_, index) => t(`stage.livestream.samples.${index}`))
  const sessionId = state.value.sessionId
  void send(automatic ? { type: 'mock', sessionId, enabled: !mockEnabled.value, samples } : { type: 'sample', sessionId, samples })
}

async function redirect() {
  if (!state.value || !guidance.value.trim())
    return
  await send({ type: 'redirect', sessionId: state.value.sessionId, direction: guidance.value.trim() })
  if (!error.value)
    guidance.value = ''
}

async function sendComment() {
  if (!state.value)
    return
  await send({ type: 'comment', sessionId: state.value.sessionId, nickname: nickname.value.trim(), text: message.value.trim() })
  if (!error.value)
    message.value = ''
}
</script>

<template>
  <div :class="['w-full text-sm']">
    <GhostButton
      v-if="!props.standalone"
      :aria-expanded="opened"
      :class="['w-full justify-between']"
      @click="opened = !opened"
    >
      <span :class="['flex items-center gap-2']">
        <span :class="['i-solar:microphone-3-linear']" aria-hidden="true" />
        {{ t('stage.livestream.title') }}
      </span>
      <span :class="['text-xs', active ? 'text-primary-600 dark:text-primary-300' : 'text-neutral-500']">
        {{ t(`stage.livestream.phase.${state?.phase ?? 'stopped'}`) }}
      </span>
    </GhostButton>
    <section v-if="props.standalone || opened" :aria-label="t('stage.livestream.title')" :class="['flex flex-col gap-3', !props.standalone && 'max-h-[65vh] overflow-y-auto', 'rounded-xl bg-neutral-50 p-4 dark:bg-neutral-950']">
      <p :class="['text-xs text-neutral-500 dark:text-neutral-400']">
        {{ t('stage.livestream.description') }}
      </p>
      <Button v-if="!props.standalone" size="sm" @click="emit('configure', '/settings/livestream')">
        {{ t('stage.livestream.editor.open') }}
      </Button>
      <template v-if="!active && !paused">
        <p :class="['break-words text-sm']">
          {{ t('stage.livestream.editor.saved-topic', { topic: direction || t('stage.livestream.editor.no-topic') }) }}
        </p>
        <div role="group" :aria-label="t('stage.livestream.mode')" :class="['flex flex-wrap gap-2']">
          <Button size="sm" :aria-pressed="mode === 'text'" @click="mode = 'text'">
            {{ t('stage.livestream.text-mode') }}
          </Button>
          <Button size="sm" :aria-pressed="mode === 'speech'" @click="mode = 'speech'">
            {{ t('stage.livestream.speech-mode') }}
          </Button>
        </div>
        <p v-if="mode === 'text'" :class="['text-xs text-neutral-500 dark:text-neutral-400']">
          {{ t('stage.livestream.text-description') }}
        </p>
        <p v-if="props.unsaved" role="status" :class="['text-sm text-amber-700 dark:text-amber-300']">
          {{ t('stage.livestream.editor.save-before-start') }}
        </p>
      </template>
      <div :class="['flex flex-wrap gap-2']">
        <Button v-if="!active && !paused" size="sm" color="primary" variant="primary" :disabled="!canStart" :loading="pending" @click="send({ type: 'start', characterId: props.characterId, settings: { direction: direction.trim(), details, mode } })">
          {{ t(mode === 'text' ? 'stage.livestream.start-rehearsal' : 'stage.livestream.start') }}
        </Button>
        <Button v-if="active" size="sm" :loading="pending" @click="control('pause')">
          {{ t('stage.livestream.pause') }}
        </Button>
        <Button v-if="paused" size="sm" :loading="pending" @click="control('resume')">
          {{ t('stage.livestream.resume') }}
        </Button>
        <Button v-if="active || paused" size="sm" color="red" @click="control('stop')">
          {{ t('stage.livestream.stop') }}
        </Button>
      </div>
      <p v-if="!connected" role="status" :class="['text-xs text-neutral-500']">
        {{ t('stage.livestream.unavailable') }}
      </p>
      <p v-if="error || state?.error" role="alert" :class="['break-words text-xs text-red-600 dark:text-red-300']">
        {{ t('stage.livestream.error', { message: error || state?.error }) }}
      </p>
      <template v-if="state && (active || paused)">
        <div :class="['flex flex-col gap-2']">
          <FieldInput v-model="guidance" :label="t('stage.livestream.guidance')" :placeholder="t('stage.livestream.guidance-placeholder')" />
          <Button size="sm" :disabled="!guidance.trim()" :loading="pending" @click="redirect">
            {{ t('stage.livestream.redirect') }}
          </Button>
        </div>
        <div :class="['flex flex-wrap gap-2']">
          <Button size="sm" :disabled="!active || pending" @click="sample(false)">
            {{ t('stage.livestream.sample') }}
          </Button>
          <Button size="sm" :disabled="!active || pending" :aria-pressed="mockEnabled" @click="sample(true)">
            {{ t(mockEnabled ? 'stage.livestream.mock-stop' : 'stage.livestream.mock-start') }}
          </Button>
        </div>
        <p role="status" :class="['text-xs text-neutral-500 dark:text-neutral-400']">
          {{ t('stage.livestream.counts', { pending: state.comments.length, played: state.metrics.played }) }}
        </p>
        <p v-if="state.playing" aria-live="polite" :class="['break-words']">
          <strong>{{ t('stage.livestream.speaking') }}</strong> {{ state.playing }}
        </p>
        <p v-if="state.ready" :class="['break-words text-xs text-neutral-500 dark:text-neutral-400']">
          <strong>{{ t('stage.livestream.ready') }}</strong> {{ state.ready }}
        </p>
        <p v-else-if="state.preparing" :class="['text-xs text-neutral-500']">
          {{ t('stage.livestream.preparing') }}
        </p>
        <details :class="['text-xs text-neutral-500 dark:text-neutral-400']">
          <summary :class="['cursor-pointer']">
            {{ t('stage.livestream.diagnostics') }}
          </summary>
          <p>{{ t('stage.livestream.timings', { generation: Math.round(state.metrics.lastGenerationMs), speech: Math.round(state.metrics.lastSynthesisMs), gap: state.metrics.lastGapMs ?? '—', wait: state.metrics.lastReplyWaitMs ?? '—' }) }}</p>
          <p>{{ t('stage.livestream.usage', { generated: state.metrics.synthesizedCharacters, discarded: state.metrics.discardedCharacters }) }}</p>
          <ol :class="['mt-2 flex flex-col gap-1']">
            <li v-for="comment in state.comments" :key="comment.key">
              {{ comment.nickname }}: {{ comment.text }}
            </li>
          </ol>
        </details>
      </template>
      <LivestreamRehearsal v-if="state?.sessionId" v-model:nickname="nickname" v-model:message="message" :state="state" :pending="pending" @comment="sendComment" />
    </section>
  </div>
</template>
