<script setup lang="ts">
import { ProviderSettingsContainer, ProviderSettingsLayout } from '@proj-airi/stage-ui/components'
import { useI18n } from 'vue-i18n'

import ChatGPTAccountSettings from '../../../../components/chatgpt-account-settings.vue'

const { t } = useI18n()
</script>

<template>
  <ProviderSettingsLayout :provider-name="t('settings.pages.providers.provider.chatgpt.title')" provider-icon="i-lobe-icons:openai">
    <ProviderSettingsContainer>
      <ChatGPTAccountSettings />
    </ProviderSettingsContainer>
  </ProviderSettingsLayout>
</template>

<route lang="yaml">
alias: /settings/providers/vision/chatgpt
meta:
  layout: settings
</route>
