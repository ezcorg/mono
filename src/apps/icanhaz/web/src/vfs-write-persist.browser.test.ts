import { describe, it, expect } from "vitest";
import { connect, requestFilesystemGrant } from "./wrpc";
import { wrpcFilesystem } from "./vfs";

// writeFile must overwrite in place (no truncate-on-open — that empty window makes cargo-check
// read an empty file and cache "main function not found") AND trim a shorter overwrite so no
// stale tail remains.
import { WS } from "./test-ws";
const LONG = 'fn main() {\n    let x: i32 = "test";\n    println!("edit me over wRPC — rust-analyzer runs on the host");\n}\n';
const SHORT = 'fn main() {\n    println!("hi");\n}\n';

describe("writeFile overwrites+trims without an empty window", () => {
    it("overwriting longer content with shorter leaves exactly the shorter content", async () => {
        const t = await connect({ ws: WS });
        const grant = await requestFilesystemGrant(t, "write persist");
        const fs = await wrpcFilesystem(t, grant);
        await fs.writeFile("src/main.rs", LONG);
        await fs.writeFile("src/main.rs", SHORT); // shorter — must trim the tail
        const back = (await fs.readFile("src/main.rs")) as unknown as string;
        t.close();
        expect({ match: back === SHORT, hasMain: back.includes("fn main"), noTail: !back.includes("edit me") }).toEqual({ match: true, hasMain: true, noTail: true });
    }, 20000);
});
