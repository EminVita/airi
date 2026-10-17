<script setup lang="ts">
import type { Snapshot } from '../../../../libs/livestream/session'

import { errorMessageFrom } from '@moeru/std'
import { Button, FieldInput } from '@proj-airi/ui'
import { useClipboard } from '@vueuse/core'
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

import { rehearsalMarkdown, rehearsalTime } from '../../../../libs/livestream/rehearsal'

const props = defineProps<{ state: Snapshot, pending: boolean }>()
const emit = defineEmits<{ comment: [] }>()
const nickname = defineModel<string>('nickname', { required: true })
const message = defineModel<string>('message', { required: true })
const { t } = useI18n()
const showAll = shallowRef(false)
const copyError = shallowRef('')
const { copy, copied } = useClipboard({ legacy: true })
const entries = computed(() => (showAll.value ? props.state.transcript : props.state.transcript.slice(-30)).toReversed())
const canSend = computed(() => props.state.phase === 'running' && !props.pending
  && nickname.value.trim().length > 0 && nickname.value.length <= 80
  && message.value.trim().length > 0 && message.value.length <= 500)

async function exportTranscript() {
  copyError.value = ''
  try {
    await copy(rehearsalMarkdown(props.state))
  }
  catch (cause) {
    copyError.value = errorMessageFrom(cause) ?? t('stage.livestream.copy-failed')
  }
}
</script>

<template>
  <div :class="['flex flex-col gap-3']">
    <p v-if="state.durationMs !== null" role="status" :class="['font-mono text-sm']">
      {{ t('stage.livestream.clock', { elapsed: rehearsalTime(state.elapsedMs), total: rehearsalTime(state.durationMs) }) }}
      <span v-if="state.completed"> · {{ t('stage.livestream.completed') }}</span>
    </p>
    <form v-if="state.phase !== 'stopped'" :class="['flex flex-col gap-2']" @submit.prevent="canSend && emit('comment')">
      <FieldInput v-model="nickname" :label="t('stage.livestream.viewer-name')" />
      <FieldInput v-model="message" :label="t('stage.livestream.viewer-comment')" :placeholder="t('stage.livestream.comment-placeholder')" />
      <Button type="submit" size="sm" color="primary" :disabled="!canSend" :loading="pending">
        {{ t('stage.livestream.send-comment') }}
      </Button>
      <p :class="['text-xs text-neutral-500 dark:text-neutral-400']">
        {{ t('stage.livestream.comment-help') }}
      </p>
    </form>
    <div v-if="state.transcript.length" :class="['flex flex-wrap gap-2']">
      <Button size="sm" @click="exportTranscript">
        {{ t(copied ? 'stage.livestream.copied' : 'stage.livestream.export') }}
      </Button>
      <Button size="sm" :aria-pressed="showAll" @click="showAll = !showAll">
        {{ t(showAll ? 'stage.livestream.recent-log' : 'stage.livestream.full-log') }}
      </Button>
    </div>
    <p v-if="copyError" role="alert" :class="['text-xs text-red-600 dark:text-red-300']">
      {{ copyError }}
    </p>
    <ol :aria-label="t('stage.livestream.transcript')" :class="['flex flex-col gap-3']">
      <li v-for="entry in entries" :key="entry.id" :class="['break-words rounded-lg p-2', entry.kind === 'host' ? 'bg-primary-100/40 dark:bg-primary-900/20' : 'bg-neutral-100 dark:bg-neutral-900']">
        <p :class="['text-xs text-neutral-500 dark:text-neutral-400']">
          {{ rehearsalTime(entry.elapsedMs) }} · {{ entry.kind === 'comment' ? entry.nickname : t(`stage.livestream.log-kind.${entry.kind}`) }}
          <span v-if="entry.action"> · {{ t(`stage.livestream.action.${entry.action}`) }}</span>
        </p>
        <p v-for="(reply, index) in entry.replies" :key="index" :class="['text-xs text-neutral-500 dark:text-neutral-400']">
          {{ t('stage.livestream.reply-to', { nickname: reply.nickname, text: reply.text }) }}
        </p>
        <p :class="['whitespace-pre-wrap']">
          {{ entry.text }}
        </p>
      </li>
    </ol>
  </div>
</template>
