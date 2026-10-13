/**
 * A settings file opened as code: completion, checking and hover from its
 * schema, through `codemirror-json-schema` (its YAML or JSON mode, loaded
 * only when such a file is opened: the editor's own files are read with
 * the schema in mind, nothing else is).
 */
import type { Extension } from '@codemirror/state'
import type { Schema } from '@joinezco/config'

export async function settingsFileExtensions(path: string, schema: Schema): Promise<Extension[]> {
    if (/\.ya?ml$/i.test(path)) {
        const { yamlSchema } = await import('codemirror-json-schema/yaml')
        return [yamlSchema(schema as never)]
    }
    if (/\.json$/i.test(path)) {
        const { jsonSchema } = await import('codemirror-json-schema')
        return [jsonSchema(schema as never)]
    }
    return []
}
