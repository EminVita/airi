<script setup lang="ts">
import type { Settings } from '../../../../libs/livestream/session'

import { errorMessageFrom } from '@moeru/std'
import { Button, FieldInput, FieldTextArea } from '@proj-airi/ui'
import { useFileDialog } from '@vueuse/core'
import { shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

import episodeTemplate from '../../../../libs/livestream/prompts/episode-template.md?raw'

const direction = defineModel<string>('direction', { required: true })
const details = defineModel<string>('details', { required: true })
const mode = defineModel<Settings['mode']>('mode', { required: true })
const { t } = useI18n()
const error = shallowRef('')
const dialog = useFileDialog({ accept: '.md,text/markdown,text/plain', multiple: false, reset: true })
dialog.onChange(async (files) => {
  const file = files?.[0]
  if (!file)
    return
  error.value = ''
  try {
    if (file.size > 60_000)
      throw new Error(t('stage.livestream.brief-too-long'))
    const content = await file.text()
    if (content.length > 12000)
      throw new Error(t('stage.livestream.brief-too-long'))
    details.value = content
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? t('stage.livestream.import-failed')
  }
})
</script>

<template>
  <div :class="['flex flex-col gap-3']">
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
    <FieldInput v-model="direction" :label="t('stage.livestream.direction')" :placeholder="t('stage.livestream.direction-placeholder')" />
    <FieldTextArea v-model="details" :label="t('stage.livestream.details')" :description="t('stage.livestream.brief-help')" :placeholder="t('stage.livestream.details-placeholder')" :rows="8" :required="mode === 'text'" />
    <div :class="['flex flex-wrap gap-2']">
      <Button size="sm" @click="dialog.open()">
        {{ t('stage.livestream.import-brief') }}
      </Button>
      <Button size="sm" :disabled="!!details.trim()" @click="details = episodeTemplate">
        {{ t('stage.livestream.fill-template') }}
      </Button>
    </div>
    <p v-if="details.length > 12000 || error" role="alert" :class="['text-xs text-red-600 dark:text-red-300']">
      {{ error || t('stage.livestream.brief-too-long') }}
    </p>
  </div>
</template>
