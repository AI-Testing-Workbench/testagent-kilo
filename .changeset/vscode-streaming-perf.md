---
"TestAgent": patch
---

Speed up chat streaming in the VS Code webview: bridge data with fine-grained getters, batch stream updates per animation frame, flush the focused session every 16ms, lift on-screen sessions out of the background lane, and keep message rows stable during streaming.
