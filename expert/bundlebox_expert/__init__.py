"""bundlebox_expert — the expert-system and ML half of bundlebox.

Stdlib only. Every verb reads one JSON object on stdin and writes one on
stdout; the Node side (`src/core/expert.js`) owns the store and the config and
hands this package the rows. Nothing here reads a file the caller did not name.
"""
__version__ = "0.7.1"
