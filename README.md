# VoiceCoder

> Talk directly into your code editor. Natural language → syntactically correct code, instantly at your cursor.

---

## Install (Dev Mode)

```bash
cd VoiceCoder
node scripts/build.js
```

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `dist/` folder

---

## Setup

1. Click the VoiceCoder icon in your toolbar
2. Click **Settings** (⚙)
3. Paste your [OpenAI API key](https://platform.openai.com/api-keys)
4. Click **Save**

---

## Usage

| Action | How |
|--------|-----|
| Start/stop listening | `⌥ Space` or toolbar toggle |
| Switch language | `⌥ L` or language chips in popup |
| Undo last insertion | `⌥ Z` |

### Examples

| You say | Inserts (Python) |
|---------|-----------------|
| "create a for loop from 0 to n" | `for i in range(n):` |
| "write binary search" | Full binary search function |
| "make a hashmap" | `my_dict = {}` |
| "add try except" | `try: / except Exception as e:` |

| You say | Inserts (JavaScript) |
|---------|---------------------|
| "create an async function called fetchData" | `async function fetchData() { }` |
| "make a React useEffect" | `useEffect(() => { }, [])` |
| "add try catch" | `try { } catch (error) { }` |

---

## Supported Editors

- VS Code Web / vscode.dev / GitHub Codespaces
- LeetCode (Monaco + CodeMirror)
- Replit (Ace)
- CodeSandbox, StackBlitz
- HackerRank, Codeforces
- Any `<textarea>` or `contenteditable`

## Supported Languages

Python · JavaScript · TypeScript · C++ · Java · Go · Rust · Swift · Kotlin · Ruby · C#

---

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full pipeline, editor detection strategy, security model, and Phase 2 roadmap.
