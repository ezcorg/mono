import { CodeblockFS, createCodeblock } from "@ezcodelol/codeblock"
import { useEffect, useRef, useState } from "react"
import { configureSingle, promises as fs } from "@zenfs/core"
import { WebStorage } from '@zenfs/dom';
import { NodeViewWrapper } from "@tiptap/react";

await configureSingle({ backend: WebStorage })
await fs.writeFile('/example.ts', `// Example TypeScript file\nconsole.log('Hello, world!');\n`)

export default function CodeblockComponent({ node, updateAttributes, extension, index }: any) {
    const [codeblock, setCodeblock] = useState<any>(null)
    const ref = useRef<HTMLDivElement>(null)
    console.debug({ node, updateAttributes, extension, index, codeblock })

    useEffect(() => {

        if (ref.current && !codeblock) {
            const content = node.content?.content?.length > 0 ? node.content.content[0].text : ''

            const codeblock = createCodeblock({ parent: ref.current, language: node.attrs.language, fs: CodeblockFS.fromNodelike(fs), file: node.attrs.file, content, toolbar: !!node.attrs.file, index });
            setCodeblock(codeblock)
        }

        return () => {
            if (codeblock) {
                codeblock.destroy()
                setCodeblock(null)
            }
        }
    }, [ref.current])


    return <NodeViewWrapper>
        <div ref={ref}></div>
    </NodeViewWrapper>
}