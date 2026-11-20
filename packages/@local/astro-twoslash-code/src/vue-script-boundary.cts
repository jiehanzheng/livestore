import type { VueLanguagePlugin } from '@vue/language-core'

const plugin: VueLanguagePlugin = () => ({
  version: 2.2,
  order: 1,
  resolveEmbeddedCode(_fileName, { scriptSetup }, { id, content }) {
    if (scriptSetup === undefined || /^script_(?:js|jsx|ts|tsx)$/.test(id) === false) return

    const boundary = content.findIndex((segment, index) => {
      const next = content[index + 1]
      return (
        typeof segment !== 'string' &&
        segment[0].length > 0 &&
        segment[1] === scriptSetup.name &&
        segment[2] + segment[0].length === scriptSetup.content.length &&
        typeof next === 'string' &&
        /^(?:const|let|type) __VLS_/.test(next)
      )
    })
    if (boundary === -1) return

    // Vue 3.3.14 can append template declarations directly to the last setup token.
    // The separator belongs to the generated script and has no source mapping.
    content.splice(boundary + 1, 0, '\n;\n')
  },
})

module.exports = plugin
