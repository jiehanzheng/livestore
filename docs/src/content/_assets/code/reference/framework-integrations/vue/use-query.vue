<script setup lang="ts">
import { queryDb } from '@livestore/livestore'

import { useQuery } from '../../../getting-started/vue/livestore/store.ts'
import { tables } from './schema.ts'

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
