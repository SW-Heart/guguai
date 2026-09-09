# Director canvas engine

This is a browser bundle of `CanvasApi` from `@8btc/whiteboard@0.0.20-alpha.40`, the same installed engine used by the user-provided `desktop-wujieai-global/wujie-ai/apps/desktop-global` reference. It includes its resolved runtime dependencies and their embedded license notices. No reference application credentials, shell runtime, or account state are included.

Rebuild using `scripts/director/build-whiteboard.mjs` with a reference installation containing this version and esbuild. The checked-in browser bundle means production does not depend on the reference directory or a package registry at runtime.

GuGu's `director-workspace.js` maps project resources, shots and generation jobs into canvas nodes. Imported reference files use the whiteboard engine's native `image` nodes so they remain images rather than business cards; story and shot metadata is rebuilt as HTML nodes from project data. Canvas imports stay in the desktop local library; they are only synchronized to the cloud when a model request actually needs a remote reference. Only viewport and layout are saved from the canvas. Chat cannot execute arbitrary JavaScript.
