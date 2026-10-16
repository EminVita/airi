<script setup lang="ts">
import type { ChatGPTSession } from '@proj-airi/stage-shared/chatgpt'
import type { OnboardingStepNextHandler, OnboardingStepPrevHandler } from '@proj-airi/stage-ui/components/scenarios/dialogs/onboarding/types'

import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { errorMessageFrom } from '@moeru/std'
import { chatgptModels, chatgptSelect, chatgptSession, chatgptSignIn, chatgptSignOut } from '@proj-airi/stage-shared/chatgpt'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { useProviderStore } from '@proj-airi/stage-ui/stores/providers/provider'
import { Button, Callout, FieldSelect, ScrollableArea } from '@proj-airi/ui'
import { computed, onMounted, onScopeDispose, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  onNext?: OnboardingStepNextHandler
  onPrevious?: OnboardingStepPrevHandler
}>()
const { t, te } = useI18n()
const providers = useProviderStore()
const cards = useAiriCardStore()
const consciousness = useConsciousnessStore()
const eventa = createContext(window.electron.ipcRenderer)
const session = shallowRef<ChatGPTSession>({ accounts: [] })
const models = shallowRef<Array<{ slug: string, display_name: string }>>([])
const selectedModel = shallowRef('')
const busy = shallowRef(false)
const signingIn = shallowRef(false)
const error = shallowRef('')
const revocationUnconfirmed = shallowRef(false)
let attempt: AbortController | undefined
const key = 'settings.pages.providers.provider.chatgpt.'
const activeAccount = computed(() => session.value.accounts.find(account => account.id === session.value.activeId))
const accountOptions = computed(() => session.value.accounts.map((account, index) => ({ value: account.id, label: `${index + 1}. ${account.email ?? t(`${key}account`)}` })))
const modelOptions = computed(() => models.value.map(model => ({ value: model.slug, label: model.display_name })))

async function refresh() {
  const current = consciousness.activeProvider === 'chatgpt' ? consciousness.activeModel : selectedModel.value
  models.value = []
  selectedModel.value = ''
  session.value = await defineInvoke(eventa.context, chatgptSession)()
  await providers.initializeProvider('chatgpt')
  await providers.validateProvider('chatgpt', { force: true })
  models.value = activeAccount.value?.sharing ? await defineInvoke(eventa.context, chatgptModels)() : []
  selectedModel.value = models.value.some(model => model.slug === current) ? current : models.value[0]?.slug ?? ''
}

async function run(action?: () => Promise<unknown>) {
  if (busy.value)
    return
  busy.value = true
  error.value = ''
  try {
    await action?.()
    await refresh()
  }
  catch (cause) {
    const message = `${key}errors.${errorMessageFrom(cause)}`
    error.value = te(message) ? t(message) : t(`${key}errors.CHATGPT_REQUEST_FAILED`)
    // A failed first exchange can still leave a reusable registration. Show it without masking the original error.
    try {
      session.value = await defineInvoke(eventa.context, chatgptSession)()
    }
    catch {
      models.value = []
    }
  }
  finally {
    busy.value = false
  }
}

async function signIn(accountId?: string) {
  attempt = new AbortController()
  signingIn.value = true
  try {
    await run(() => defineInvoke(eventa.context, chatgptSignIn)({ accountId }, { signal: attempt?.signal }))
  }
  finally {
    signingIn.value = false
    attempt = undefined
  }
}

function selectAccount(value: string | undefined) {
  if (!value)
    return
  return run(async () => {
    await defineInvoke(eventa.context, chatgptSelect)({ accountId: value })
    if (consciousness.activeProvider === 'chatgpt')
      consciousness.activeModel = ''
  })
}

function signOut() {
  return run(async () => {
    const result = await defineInvoke(eventa.context, chatgptSignOut)()
    revocationUnconfirmed.value = !result.revoked
    if (consciousness.activeProvider === 'chatgpt')
      consciousness.activeModel = ''
  })
}

function activate() {
  return run(() => cards.updateActiveCardConsciousness({ provider: 'chatgpt', model: selectedModel.value }))
}

async function next() {
  if (busy.value)
    return
  await run()
  if (!error.value && activeAccount.value?.sharing && models.value.length)
    await props.onNext?.({ apiKey: '', baseUrl: '', accountId: '' })
}

onMounted(() => run())
onScopeDispose(() => {
  attempt?.abort()
  eventa.dispose()
})
</script>

<template>
  <div :class="['min-h-0 flex flex-col gap-4']" :aria-busy="busy">
    <div v-if="props.onNext" :class="['flex shrink-0 items-center gap-2']">
      <Button :disabled="busy" @click="props.onPrevious?.()">
        {{ t(`${key}back`) }}
      </Button>
      <h2 :class="['flex-1 text-xl font-semibold']">
        {{ t('settings.dialogs.onboarding.configureProvider', { provider: t(`${key}title`) }) }}
      </h2>
    </div>
    <ScrollableArea :class="['min-h-0 flex-1']">
      <div :class="['flex flex-col gap-4']">
        <p>{{ t(`${key}description`) }}</p>
        <FieldSelect
          v-if="accountOptions.length" :model-value="session.activeId ?? ''"
          :label="t(`${key}account`)" :options="accountOptions" :disabled="busy"
          @update:model-value="selectAccount"
        />
        <p v-if="activeAccount?.sharing">
          {{ t(`${key}using-plan`) }}
        </p>
        <p v-else>
          {{ t(`${key}sign-in-required`) }}
        </p>
        <div :class="['flex flex-wrap gap-2']">
          <Button :disabled="busy" variant="primary" color="primary" @click="signIn(session.activeId)">
            {{ t(`${key}sign-in`) }}
          </Button>
          <Button v-if="accountOptions.length" :disabled="busy" @click="signIn()">
            {{ t(`${key}add-account`) }}
          </Button>
          <Button v-if="activeAccount?.connected" :disabled="busy" @click="signOut">
            {{ t(`${key}sign-out`) }}
          </Button>
          <Button v-if="signingIn" @click="attempt?.abort()">
            {{ t(`${key}cancel`) }}
          </Button>
        </div>
        <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer" :class="['text-primary-600 dark:text-primary-400 underline']">
          {{ t(`${key}manage-usage`) }}
        </a>
        <Callout v-if="error" theme="orange" role="alert">
          {{ error }}
        </Callout>
        <Callout v-if="revocationUnconfirmed" theme="orange">
          {{ t(`${key}revocation-unconfirmed`) }}
        </Callout>
        <template v-if="activeAccount?.sharing && !props.onNext">
          <FieldSelect v-model="selectedModel" :label="t(`${key}model`)" :options="modelOptions" :disabled="busy" />
          <Button :disabled="busy || !selectedModel" variant="primary" color="primary" @click="activate">
            {{ t(`${key}use-model`) }}
          </Button>
          <p v-if="consciousness.activeProvider === 'chatgpt' && consciousness.activeModel === selectedModel && selectedModel">
            {{ t(`${key}active-model`, { model: selectedModel }) }}
          </p>
        </template>
        <p :class="['text-sm text-neutral-500 dark:text-neutral-400']">
          {{ t(`${key}speech-note`) }}
        </p>
      </div>
    </ScrollableArea>
    <Button
      v-if="props.onNext" :disabled="busy || !activeAccount?.sharing || !models.length || !!error"
      :label="t('settings.dialogs.onboarding.next')" @click="next"
    />
  </div>
</template>
