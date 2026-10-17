<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { Button } from '@proj-airi/ui'
import { useClipboard, useEventListener, useFileDialog } from '@vueuse/core'
import { safeParse } from 'valibot'
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import LivestreamControl from '../chat/components/livestream-control.vue'
import LivestreamSetup from '../chat/components/livestream-setup.vue'
import LivestreamMarkdown from './livestream-markdown.vue'

import { defaultLivestreamConfig, livestreamConfigSchema, useLivestreamSettingsStore } from '../../../stores/livestream-settings'

const props = defineProps<{ characterId: string, characterName: string }>()
const emit = defineEmits<{ dirty: [value: boolean] }>()
const { t } = useI18n()
const store = useLivestreamSettingsStore()
const tab = shallowRef<'episode' | 'soul' | 'rules'>('episode')
const baseline = shallowRef(store.saved)
const draft = shallowRef({ ...baseline.value.config })
const saving = shallowRef(false)
const error = shallowRef('')
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(baseline.value.config))
const conflict = computed(() => baseline.value.revision !== store.saved.revision)
const valid = computed(() => safeParse(livestreamConfigSchema, draft.value).success)
const markdownField = computed(() => tab.value === 'episode' ? 'details' : tab.value)
const markdown = computed({
  get: () => draft.value[markdownField.value],
  set: value => draft.value = { ...draft.value, [markdownField.value]: value },
})
const direction = computed({
  get: () => draft.value.direction,
  set: value => draft.value = { ...draft.value, direction: value },
})
const details = computed({
  get: () => draft.value.details,
  set: value => draft.value = { ...draft.value, details: value },
})
const { copy, copied } = useClipboard({ legacy: true })
const dialog = useFileDialog({ accept: '.md,text/markdown,text/plain', multiple: false, reset: true })
let importTarget: 'soul' | 'rules' = 'soul'

function reload() {
  baseline.value = store.saved
  draft.value = { ...store.saved.config }
  error.value = ''
}

watch(() => store.saved, () => {
  if (!dirty.value)
    reload()
})
watch(dirty, value => emit('dirty', value), { immediate: true })
useEventListener(window, 'beforeunload', (event) => {
  if (dirty.value) {
    event.preventDefault()
    event.returnValue = ''
  }
})

async function save() {
  saving.value = true
  error.value = ''
  try {
    const result = await store.save({ ...draft.value }, baseline.value.revision)
    if (result.accepted) {
      baseline.value = result.saved
      draft.value = { ...result.saved.config }
    }
    else {
      error.value = t('stage.livestream.editor.conflict')
    }
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? t('stage.livestream.editor.save-failed')
  }
  finally {
    saving.value = false
  }
}

function importMarkdown() {
  if (tab.value === 'episode')
    return
  importTarget = tab.value
  dialog.open()
}

dialog.onChange(async (files) => {
  const file = files?.[0]
  if (!file)
    return
  const target = importTarget
  error.value = ''
  try {
    if (file.size > 60_000)
      throw new Error(t('stage.livestream.brief-too-long'))
    const content = await file.text()
    if (content.length > 12000)
      throw new Error(t('stage.livestream.brief-too-long'))
    draft.value = { ...draft.value, [target]: content }
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? t('stage.livestream.import-failed')
  }
})

async function copyMarkdown() {
  try {
    await copy(markdown.value)
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? t('stage.livestream.editor.copy-failed')
  }
}
</script>

<template>
  <div :class="['flex flex-col gap-6 pb-10']">
    <fieldset :disabled="saving" :class="['min-w-0 flex flex-col gap-4']" :aria-label="t('stage.livestream.editor.title')">
      <p :class="['text-sm text-neutral-600 dark:text-neutral-400']">
        {{ t('stage.livestream.editor.description') }}
      </p>
      <div role="group" :aria-label="t('stage.livestream.editor.sections')" :class="['flex flex-wrap gap-2']">
        <Button v-for="item in (['episode', 'soul', 'rules'] as const)" :key="item" :aria-pressed="tab === item" :variant="tab === item ? 'primary' : 'secondary'" @click="tab = item">
          {{ t(`stage.livestream.editor.${item}`) }}
        </Button>
      </div>
      <div :class="['rounded-xl border border-neutral-200 p-4 dark:border-neutral-800', 'flex flex-col gap-4']">
        <p :class="['text-sm text-neutral-600 dark:text-neutral-400']">
          {{ t(`stage.livestream.editor.${tab}-help`) }}
        </p>
        <LivestreamSetup v-if="tab === 'episode'" v-model:direction="direction" v-model:details="details" />
        <LivestreamMarkdown v-else v-model="markdown" :label="t(`stage.livestream.editor.${tab}`)" />
        <div :class="['flex flex-wrap items-center gap-2']">
          <Button v-if="tab !== 'episode'" size="sm" @click="importMarkdown">
            {{ t('stage.livestream.editor.import') }}
          </Button>
          <Button size="sm" :disabled="!markdown" @click="copyMarkdown">
            {{ t(copied ? 'stage.livestream.editor.copied' : 'stage.livestream.editor.copy') }}
          </Button>
          <Button v-if="tab !== 'episode'" size="sm" @click="markdown = defaultLivestreamConfig[tab]">
            {{ t('stage.livestream.editor.restore') }}
          </Button>
          <span :class="['text-xs text-neutral-500']">{{ markdown.length }} / 12000</span>
        </div>
      </div>
      <div :class="['flex flex-wrap items-center gap-3']">
        <Button color="primary" variant="primary" :disabled="!dirty || !valid || conflict" :loading="saving" @click="save">
          {{ t('stage.livestream.editor.save') }}
        </Button>
        <Button :disabled="(!dirty && !conflict) || saving" @click="reload">
          {{ t('stage.livestream.editor.reload') }}
        </Button>
        <span role="status" :class="['text-sm text-neutral-500 dark:text-neutral-400']">
          {{ t(dirty ? 'stage.livestream.editor.unsaved' : 'stage.livestream.editor.saved') }}
        </span>
      </div>
      <p :class="['text-xs text-neutral-500 dark:text-neutral-400']">
        {{ t('stage.livestream.editor.storage-help') }}
      </p>
      <p v-if="!valid" role="alert" :class="['text-sm text-red-600 dark:text-red-300']">
        {{ t('stage.livestream.editor.invalid') }}
      </p>
      <p v-if="conflict || error || store.loadError" role="alert" :class="['break-words text-sm text-red-600 dark:text-red-300']">
        {{ conflict ? t('stage.livestream.editor.conflict') : error || t('stage.livestream.editor.load-failed', { message: store.loadError }) }}
      </p>
    </fieldset>
    <section :class="['flex flex-col gap-3']">
      <h2 :class="['text-lg font-semibold']">
        {{ t('stage.livestream.editor.rehearsal') }}
      </h2>
      <p :class="['text-sm text-neutral-500']">
        {{ t('stage.livestream.editor.character', { name: props.characterName }) }}
      </p>
      <LivestreamControl :character-id="props.characterId" standalone :unsaved="dirty || conflict" />
    </section>
  </div>
</template>
