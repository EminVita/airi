<script setup lang="ts">
import { LivestreamSettings } from '@proj-airi/stage-ui/components'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { shallowRef } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'

import UnsavedChangesDialog from './airi-card/components/UnsavedChangesDialog.vue'

const cards = useAiriCardStore()
const dirty = shallowRef(false)
const showDiscard = shallowRef(false)
const router = useRouter()
let destination = ''

onBeforeRouteLeave((to) => {
  if (!dirty.value)
    return true
  destination = to.fullPath
  showDiscard.value = true
  return false
})

async function discard() {
  dirty.value = false
  showDiscard.value = false
  await router.push(destination)
}
</script>

<template>
  <LivestreamSettings :character-id="cards.activeCardId" :character-name="cards.activeCard?.name ?? cards.activeCardId" @dirty="dirty = $event" />
  <UnsavedChangesDialog v-model="showDiscard" @discard="discard" @cancel="showDiscard = false" />
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: stage.livestream.editor.title
  subtitleKey: settings.title
  descriptionKey: stage.livestream.editor.summary
  icon: i-solar:microphone-3-bold-duotone
  settingsEntry: true
  order: 7
  stageTransition:
    name: slide
</route>
