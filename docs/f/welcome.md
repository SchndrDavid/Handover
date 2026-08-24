# Welcome to the Handover demo

Everything you see here runs in your browser. There is no server behind this
page — `docs/demo.js` intercepts the app's API calls and answers from a
filesystem held in memory.

Things worth trying:

- Drop a file anywhere on the page. It gets added to the listing and you can
  preview it. It never leaves your machine.
- Right-click an item for rename, delete, download and "copy link".
- Drag a selection onto a folder in the sidebar to move it.
- Search finds files recursively from wherever you are.
- Reload the page and everything resets to this starting state.

The frontend here is byte-for-byte the one that runs in the real container.
Only the backend is faked.
