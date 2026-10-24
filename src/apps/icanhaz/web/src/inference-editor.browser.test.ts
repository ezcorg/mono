import { describe, it, expect } from "vitest";
import { completeText } from "@joinezco/markdown-editor";
import { createEditor } from "@joinezco/markdown-editor";
import { connect } from "./wrpc";
import { editorInference, requestInferenceGrant } from "./inference";
import { WS } from "./test-ws";

// Needs the daemon's loopback provider (`ICANHAZ_ECHO=1`, set by the harness):
// `echo` answers with the last user turn.

async function until(condition: () => boolean, timeout = 5000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeout) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 20));
    }
}

describe("the editor's model is the daemon's inference capability", () => {
    it("streams an answer, asking for the grant once", async () => {
        const t = await connect({ ws: WS });
        let asked = 0;
        const inference = editorInference(t, () => {
            asked++;
            return requestInferenceGrant(t, "answer a note's questions");
        });
        const pieces: string[] = [];
        const text = await completeText(inference, { messages: [{ role: "user", content: "hello from a note" }] }, { onText: (p) => pieces.push(p) });
        expect(text).toBe("hello from a note");
        expect(pieces.length).toBeGreaterThan(0);
        expect(await completeText(inference, { messages: [{ role: "user", content: "again" }] })).toBe("again");
        expect(asked).toBe(1);
    });

    it("rewrites a selection in the editor with the answer", async () => {
        const t = await connect({ ws: WS });
        const inference = editorInference(t, () => requestInferenceGrant(t, "rewrite a sentence"));
        const el = document.createElement("div");
        document.body.append(el);
        const editor = createEditor({ element: el, content: "Keep. Rewrite me. Keep.", inference });
        let from = 0;
        editor.state.doc.descendants((node, pos) => {
            if (node.isText && node.text!.includes("Rewrite me.")) from = pos + node.text!.indexOf("Rewrite me.");
        });
        editor.commands.setTextSelection({ from, to: from + "Rewrite me.".length });
        expect(editor.commands.runProseAction("rewrite")).toBe(true);
        const apply = () => el.querySelector('.ezco-mde-ai button[data-action="apply"]') as HTMLButtonElement | null;
        await until(() => !!apply() && !apply()!.disabled);
        // The echo answers with the request itself, which carries the selection.
        expect(el.querySelector(".ezco-mde-ai-output")?.textContent).toContain("Rewrite me.");
        apply()!.click();
        const markdown = (editor.storage as any).markdown.getMarkdown() as string;
        expect(markdown.startsWith("Keep. ")).toBe(true);
        expect(markdown).toContain("The selected text:");
        editor.destroy();
        el.remove();
    });
});
