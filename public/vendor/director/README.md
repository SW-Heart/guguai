# Director canvas engine

This is a browser bundle of `CanvasApi` from `@8btc/whiteboard@0.0.20-alpha.40`, the same installed engine used by the user-provided `desktop-wujieai-global/wujie-ai/apps/desktop-global` reference. It includes its resolved runtime dependencies and their embedded license notices. No reference application credentials, shell runtime, or account state are included.

Rebuild using `scripts/director/build-whiteboard.mjs` with a reference installation containing this version and esbuild. The checked-in browser bundle means production does not depend on the reference directory or a package registry at runtime.

GuGu's `director-workspace.js` maps project resources, shots and generation jobs into HTML nodes. Only viewport and layout are saved from the canvas; generated HTML is rebuilt from project data. Chat cannot execute arbitrary JavaScript.
