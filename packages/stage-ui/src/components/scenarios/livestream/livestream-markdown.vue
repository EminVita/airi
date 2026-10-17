<script setup lang="ts">
import { Textarea } from '@proj-airi/ui'
import { useId } from 'vue'

const props = defineProps<{ label: string, description?: string, placeholder?: string }>()
const model = defineModel<string>({ required: true })
const id = useId()
</script>

<template>
  <div :class="['flex flex-col gap-3']">
    <div>
      <label :for="id" :class="['text-sm font-medium']">{{ props.label }}</label>
      <p v-if="props.description" :id="`${id}-description`" :class="['text-xs text-neutral-500 dark:text-neutral-400']">
        {{ props.description }}
      </p>
    </div>
    <Textarea
      :id="id"
      v-model="model"
      :aria-describedby="props.description ? `${id}-description` : undefined"
      :placeholder="props.placeholder"
      :submit-on-enter="false"
      :class="['max-h-80 min-h-60 overflow-y-auto whitespace-pre-wrap!']"
      required
    />
  </div>
</template>
