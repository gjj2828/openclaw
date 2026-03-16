# Design: Chat Channel Session Switching

## Background

OpenClaw's TUI already supports `/sessions` listing and `/session <key>` switching, but chat channels (Feishu, DingTalk, Telegram DM, etc.) do not expose these commands. This proposal implements **SessionId switching within the same SessionKey** for chat channels, allowing users to navigate between past conversations.

Related Issues:

- [#9959](https://github.com/openclaw/openclaw/issues/9959) - Session list and switch from chat interface (Open)
- [#8397](https://github.com/openclaw/openclaw/issues/8397) - Topic-based Session Switching (Closed as dup of #14276)
- [#14276](https://github.com/openclaw/openclaw/issues/14276) - Named sessions with navigation/recall (Closed as dup of #9959)
- [#28168](https://github.com/openclaw/openclaw/issues/28168) - Session sidebar should show human-readable title + preview (Open)

## Core Concept

```
SessionKey (stable)                  SessionId (new UUID per /new)
agent:main:feishu:default:direct:ou_xxx
    ├── 5d4c0726... (active)        ← 5d4c0726.jsonl
    ├── 9931a580... (3/16 08:00)    ← 9931a580.jsonl
    ├── 57118706... (3/15 21:03)    ← 57118706.jsonl
    └── 5d78736c... (3/12 15:39)    ← 5d78736c.jsonl
```

This proposal does **not** change SessionKey routing logic. It only switches SessionIds within the same SessionKey.

## Design Decisions

### 1. When to Add to the History Queue

**On creation (immediately).**

Whenever a new SessionId is generated (`/new`, `/reset`, daily reset), the outgoing SessionId is immediately pushed into the history queue. Simple and ensures the list is always complete.

### 2. History Queue Data Structure

Uses an **LRU queue** model. A new `sessionHistory` field is added to SessionEntry:

```typescript
interface SessionHistoryItem {
  sessionId: string; // UUID
  createdAt: number; // timestamp ms
  label?: string; // user-assigned label (future extension)
  derivedTitle?: string; // auto-generated title (future extension)
  // Metadata snapshot restored when switching back
  metadata?: {
    systemSent?: boolean;
    thinkingLevel?: string;
    verboseLevel?: string;
    reasoningLevel?: string;
    ttsAuto?: string;
    modelOverride?: string;
    providerOverride?: string;
    label?: string;
  };
}

interface SessionEntry {
  // ... existing fields
  sessionHistory?: SessionHistoryItem[]; // new, tail = most recently used
}
```

### 3. Queue Size Limit

**Default limit: 5 entries.** Configurable via `session.historyLimit`.

When the limit is exceeded, the oldest entry (queue head) is evicted. JSONL transcript files are never deleted.

### 4. Queue Operations (LRU)

**`/new`, `/reset`, daily reset:**

1. Current sessionId + metadata snapshot → push to queue tail
2. If queue exceeds limit → evict queue head
3. Generate new sessionId, make it active

**`/session <number>` (selecting a different session):**

1. Current sessionId + metadata snapshot → push to queue tail
2. Target session removed from queue
3. Target sessionId becomes active, metadata snapshot restored
4. If queue exceeds limit → evict queue head

**`/session <number>` (selecting the current session):**

- No-op, reply "Already in that session."

**`/session back`:**

- Equivalent to selecting the queue tail entry (most recently deactivated session)

### 5. Ordering Strategy

The queue itself is the ordering — tail is the most recently used, head is the least recently used. `/sessions` lists entries from tail to head.

`/sessions` output example:

```
📋 Sessions:
1. [current] (active, 140k tokens)
2. (6h ago) Last: What about DingTalk topic isolation?
3. (2d ago) Last: Server migration completed...
4. (5d ago) Last: OpenClaw upgraded to 2026.3.13...

Use /session <number>, /session <sessionId>, or /session back.
```

The current session is included in the list, marked with `[current]`.

### 6. Daily Reset Behavior

Daily reset (4 AM) is **not a timer-triggered event** — it is lazily evaluated when the next message arrives. Active conversations are never interrupted.

When daily reset triggers:

- Current sessionId is pushed into sessionHistory (queue tail)
- New sessionId is generated
- **History queue is preserved, not cleared** (users can switch back to yesterday's conversation)

### 7. Metadata Restored on Switch

| Field            | Description                          | Restored                                                  |
| ---------------- | ------------------------------------ | --------------------------------------------------------- |
| systemSent       | Whether system prompt has been sent  | ✅                                                        |
| thinkingLevel    | Thinking level setting               | ✅                                                        |
| verboseLevel     | Verbose level setting                | ✅                                                        |
| reasoningLevel   | Reasoning level setting              | ✅                                                        |
| ttsAuto          | TTS auto-play mode                   | ✅                                                        |
| modelOverride    | Model override                       | ✅                                                        |
| providerOverride | Provider override                    | ✅                                                        |
| label            | Session label                        | ✅                                                        |
| token counts     | inputTokens/outputTokens/totalTokens | ❌ Not restored; recalculated from JSONL is more accurate |
| abortedLastRun   | Whether last run was aborted         | ❌ Not relevant after switch                              |

Metadata is captured as a snapshot in `SessionHistoryItem.metadata` when a session is deactivated, and restored when switching back.

### 8. Post-Switch Reply

```
🔄 Switched to session #2 (5d4c0726).

Recent: 👤 What about DingTalk topic isolation?
```

### 9. Command Summary

| Command                | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `/sessions`            | List all sessions under the current SessionKey (incl. current)     |
| `/session <number>`    | Switch to the Nth session in the list                              |
| `/session <sessionId>` | Switch to a specific UUID (prefix matching supported, e.g. `5d4c`) |
| `/session back`        | Switch to the most recently deactivated session (queue tail)       |

## Files Modified

### Core Changes (4 files)

| File                                       | Change                                                                    | Risk                                              |
| ------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------- |
| `src/config/sessions/types.ts`             | Add `SessionHistoryItem` type and `sessionHistory` field to SessionEntry  | Low — new optional field, backward compatible     |
| `src/auto-reply/reply/session.ts`          | Push outgoing sessionId into history queue on `/new`/`/reset`/daily reset | Medium — inserting a step in existing reset logic |
| `src/auto-reply/reply/commands-session.ts` | Extend handleSessionCommand for switching + add handleSessionsListCommand | Medium — new logic, existing logic unchanged      |
| `src/auto-reply/commands-registry.data.ts` | Register `/sessions` command                                              | Low — pure addition                               |

### Auxiliary Changes (2 files)

| File                                    | Change                                          | Risk                     |
| --------------------------------------- | ----------------------------------------------- | ------------------------ |
| `src/auto-reply/reply/commands-core.ts` | Add handleSessionsListCommand to HANDLERS array | Low — one-line addition  |
| `src/config/types.base.ts`              | Add `historyLimit` to SessionConfig             | Low — new optional field |

### Files Not Modified

- `src/routing/session-key.ts` — SessionKey resolution logic untouched
- `src/gateway/server-methods/sessions.ts` — Gateway RPC not affected
- Channel plugins (Feishu, DingTalk, etc.) — commands handled at the Gateway layer

## Future Extensions (Out of Scope)

- Auto-generated session titles (LLM-derived `derivedTitle`)
- `/session name <label>` for manual naming
- Cross-SessionKey switching (requires VirtualClient abstraction)
- Feishu interactive card picker
- Expired session cleanup
- session-memory hook integration (auto-archive memory on session switch)
