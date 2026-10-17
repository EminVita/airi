<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { Button, FieldInput } from '@proj-airi/ui'
import { useFileDialog } from '@vueuse/core'
import { shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

import episodeTemplate from '../../../../libs/livestream/prompts/episode-template.md?raw'
import LivestreamMarkdown from '../../livestream/livestream-markdown.vue'

const direction = defineModel<string>('direction', { required: true })
const details = defineModel<string>('details', { required: true })
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
    <FieldInput v-model="direction" :label="t('stage.livestream.direction')" :placeholder="t('stage.livestream.direction-placeholder')" />
    <LivestreamMarkdown v-model="details" :label="t('stage.livestream.details')" :description="t('stage.livestream.brief-help')" :placeholder="t('stage.livestream.details-placeholder')" />
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
