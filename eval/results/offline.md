# VoiceCoder evaluation — offline

Measured 2026-11-19T09:33:21.644Z on darwin-arm64 (Apple M3), Node v22.11.0. No model calls (offline mode).

## Intent classification (144 commands)

| Metric | Value |
|---|---|
| Intent accuracy (kind) | 90.3% |
| Field accuracy (line numbers, targets, actions; 82 checks) | 100% |
| Handled by local grammar (no model) | 56.9% |
| Local grammar precision | 100% |
| Classification latency · local (n=82) | p50 0.013 ms · p95 0.177 ms |
| Classification latency · heuristic (n=62) | p50 0.015 ms · p95 0.455 ms |

| Kind | n | accuracy |
|---|---|---|
| navigate | 27 | 100% |
| control | 22 | 100% |
| rename | 4 | 100% |
| test | 9 | 100% |
| terminal | 7 | 100% |
| git | 11 | 100% |
| explain | 8 | 87.5% |
| dictation | 3 | 100% |
| generate | 16 | 100% |
| modify | 20 | 40% |
| refactor | 6 | 83.3% |
| debug | 6 | 100% |
| agent | 5 | 100% |

| Slice | n | accuracy |
|---|---|---|
| navigation | 27 | 100% |
| control | 22 | 100% |
| asr-noise | 7 | 57.1% |
| follow-up | 5 | 80% |
| multilingual | 4 | 50% |
| model | 62 | 77.4% |

## Duplicate execution (500 simulated speech sessions)

| Engine | utterances | executions | duplicates | missed | duplicate rate |
|---|---|---|---|---|---|
| Original engine (v1) | 600 | 800 | 200 | 0 | 33.3% |
| Current (controller + gate) | 600 | 600 | 0 | 0 | 0% |

## Edit application (10 cases)

10/10 handled correctly (applied when valid, refused when ambiguous/stale/overlapping).

- ✔ exact anchor — applied
- ✔ model re-indented anchor — applied
- ✔ trailing whitespace in file — applied
- ✔ CRLF file — applied
- ✔ import + body in one plan — applied
- ✔ insert at cursor — applied
- ✔ ambiguous anchor (must refuse) — refused: The text to change appears 2 times; the edit is ambiguous.
- ✔ stale anchor (must refuse) — refused: Could not find the code the model wanted to change. The file
- ✔ overlapping edits (must refuse) — refused: Two proposed edits overlap.
- ✔ empty plan (must refuse) — refused: The model proposed no changes.

## Agent error recovery (8 scripted fault scenarios)

8/8 handled as expected.

- ✔ transient model errors (429, 5xx) then success → complete
- ✔ failing test → fix → passing test → complete
- ✔ invalid tool arguments → corrected → complete
- ✔ malformed argsJson → corrected → complete
- ✔ tool timeout → alternative action → complete
- ✔ tool exception → alternative action → complete
- ✔ non-retryable auth error → clean failure → failed
- ✔ runaway loop → step bound → failed

## Misclassified commands

| Command | Expected | Got | Path |
|---|---|---|---|
| add JWT authentication | modify | generate | heuristic |
| add input validation | modify | generate | heuristic |
| use a map instead of an object here | modify | generate | heuristic |
| change the return type to a promise | modify | generate | heuristic |
| handle the empty list case | modify | generate | heuristic |
| add type hints | modify | generate | heuristic |
| make the timeout configurable | modify | generate | heuristic |
| add a retry with exponential backoff | modify | generate | heuristic |
| remove the duplicated logic | refactor | generate | heuristic |
| add jay w t authentication | modify | generate | heuristic |
| parse the jason response | modify | generate | heuristic |
| switch the database to post gress | modify | generate | heuristic |
| इस फंक्शन में एरर हैंडलिंग जोड़ो | modify | generate | heuristic |
| ఈ ఫంక్షన్ ఏమి చేస్తుందో వివరించు | explain | generate | heuristic |
