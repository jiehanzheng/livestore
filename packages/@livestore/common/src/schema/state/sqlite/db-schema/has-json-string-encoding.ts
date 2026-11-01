import { type SchemaAST, SchemaRepresentation } from '@livestore/utils/effect'

const cache = new WeakMap<SchemaAST.AST, boolean>()

export const hasJsonStringEncoding = (ast: SchemaAST.AST): boolean => {
  const cached = cache.get(ast)
  if (cached !== undefined) return cached
  // Effect 4.1 carries actual encoding content on the public representation;
  // the old AST annotation is no longer present and plain annotations are not codecs.
  const document = SchemaRepresentation.toRepresentation(ast, { referencePolicy: () => undefined })
  const visited = new Set<string>()
  const hasJsonContent = (representation: SchemaRepresentation.Representation): boolean => {
    switch (representation._tag) {
      case 'String':
        return representation.content?.mediaType === 'application/json'
      case 'Union':
        return representation.types.some(hasJsonContent)
      case 'Suspend':
        return hasJsonContent(representation.thunk)
      case 'Reference': {
        if (visited.has(representation.$ref) === true) return false
        visited.add(representation.$ref)
        const target = document.references[representation.$ref]
        if (target === undefined) throw new Error(`Unresolved schema representation reference: ${representation.$ref}`)
        return hasJsonContent(target)
      }
      default:
        return false
    }
  }
  const result = hasJsonContent(document.representation)
  cache.set(ast, result)
  return result
}
