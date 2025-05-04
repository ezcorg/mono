Random notes

TODO:
- [ ] Investigate potential existing WASM (and WASM-cloud/FaaS runtimes) and their trade-offs (https://wasmcloud.com/, https://scale.sh/)
- [ ] Investigate utilization of minimal WASM OS as compute environment for the VM https://wanix.run/
- [ ] Consider application/cloud infrastructure (and providers)

Editor architecture high-level ideas:
- [ ] Each new post is associated with an empty WASM VM initially (but should be able to easily reference/fork state from an existing project)
- [ ] Throughout the notebook, code execution and block execution updates VM state
- [ ] alt+/ offers contextual dropdown based on where the cursor is and whats been selected (try out: pressing slash within existing text without prior escaping opens slash command dropdown)
- [ ] /slash commands function as expected (shortcuts for predefined and user-defined commands?)
- [ ] ```sh blocks which execute entire blocks or selected lines (these include a functional xtermjs terminal)
- [ ] 

WASM resources:

* https://www.youtube.com/watch?v=mQ58pLT8YQ4 - Building a WebAssembly-first OS – An Adventure Into the Unorthodox - Dan Phillips, Loophole Labs