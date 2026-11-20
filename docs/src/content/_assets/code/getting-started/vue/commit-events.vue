<script setup lang="ts">
import { ref } from 'vue'

import { events } from './livestore/schema.ts'
import { useStore } from './livestore/store.ts'

const store = useStore()

const newTodoText = ref('')

const createTodo = () => {
  store.commit(events.todoCreated({ id: crypto.randomUUID(), text: newTodoText.value }))
  newTodoText.value = ''
}

void createTodo
</script>

<template>
  <div>
    <input v-model="newTodoText" />
    <button @click="createTodo">Create</button>
  </div>
</template>
