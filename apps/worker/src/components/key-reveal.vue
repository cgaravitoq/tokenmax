<script setup lang="ts">
defineProps<{ apiKey: string }>();
</script>

<template>
  <div>
    <h1>Your API key</h1>
    <p>Store this key in your collector config; it is shown once.</p>
    <p>
      <code>{{ apiKey }}</code>
    </p>
    <button type="button" @click="navigator.clipboard.writeText(apiKey)">
      Copy key
    </button>
  </div>
</template>
