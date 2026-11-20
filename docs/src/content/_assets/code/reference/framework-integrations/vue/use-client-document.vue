<script setup lang="ts">
import { useUiState } from '../../../getting-started/vue/livestore/store.ts'

const { newTodoText, filter } = useUiState()
</script>

<template>
  <div>
    <input type="text" v-model="newTodoText" />

    <select v-model="filter">
      <option value="all">All</option>
      <option value="active">Active</option>
      <option value="completed">Completed</option>
    </select>
  </div>
</template>
