<script setup lang="ts">
import { queryDb } from '@livestore/livestore'

import { tables } from './livestore/schema.ts'
import { useQuery } from './livestore/store.ts'

const visibleTodos$ = queryDb(() => tables.todos.where({ completed: false }), { label: 'visibleTodos' })

const todos = useQuery(visibleTodos$)

void todos
</script>

<template>
  <div>
    <ul>
      <li v-for="todo in todos" :key="todo.id">
        {{ todo.text }}
      </li>
    </ul>
  </div>
</template>
