<!-- bundlebox:start -->
## bundlebox — zero-token facts about this repository

- Before searching for where a task lives, call the `bb_pinpoint` MCP tool (or run `bb pinpoint "<task>"`). It returns the files, the symbols and a packed brief that already fits the window.
- For layout, symbols and call sites read `.bundlebox/out/snapgen/INDEX.md` and the table it points to, instead of grepping the tree.
- Before opening a large scope run `bb context <files>` (or `bb_context`) to see whether it fits; read a range (offset/limit) when it does not.
- Never edit anything under `.bundlebox/out/`: it is generated and fingerprinted.
- Open findings: `bb findings` (or `bb_findings`); the derivation behind one: `bb explain <id>`.
<!-- bundlebox:end -->
