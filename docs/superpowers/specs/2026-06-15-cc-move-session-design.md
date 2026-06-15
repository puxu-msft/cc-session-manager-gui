# cc-move-session — Design Spec

**Date:** 2026-06-15
**Status:** Approved for implementation planning

## 1. Purpose

A desktop GUI tool (Electron + React) that **moves Claude Code sessions** from one
working directory to another. "Moving" relocates a session so it is filed under the
target directory's project folder and, when opened/resumed in the target directory,
behaves consistently. The tool also maintains a queryable SQLite index of all projects
and sessions, and keeps a recoverable backup of every move.

## 2. Background: how Claude Code stores sessions

Verified against real data on this machine (read-only audit).

- **Project folders:** `~/.claude/projects/<encoded-cwd>/`. The folder name is the
  absolute cwd with **every non-alphanumeric character replaced by `-`**:
  `encode(p) = p.replace(/[^a-zA-Z0-9]/g, '-')`. No separator collapsing; a leading `/`
  becomes a leading `-`. Example: `/home/xp/.codex` → `-home-xp--codex`.
  **Decoding folder → path is lossy and ambiguous** (`/` `.` `_` `-` all map to `-`).
  → The real path is ALWAYS read from the `cwd` field inside session files, never
  reverse-engineered from the folder name.
- **Session file:** `<sessionId>.jsonl`, one JSON object per line.
- **Per-line `cwd`:** `user`/`assistant`/`system`/`attachment` lines carry a top-level
  `"cwd"`. Other line types (`queue-operation`, `file-history-snapshot`, `ai-title`,
  `custom-title`, `last-prompt`, `mode`, `permission-mode`) have **no** `cwd`.
  **`cwd` is NOT constant within a session** — a session that `cd`s into subdirs or
  `/tmp`/`~/.cache` accumulates many distinct cwd values (one real session had 22).
- **Nested cwd:** `attachment.response.cwd` is a second, nested cwd field that also
  reflects the working directory.
- **Source path also appears in message bodies / tool I/O** (hundreds to >1000 lines
  per session): `tool_input.command`, `tool_response.stdout`, `<ide_opened_file>` text,
  `structuredPatch`, embedded `transcript_path`, etc. These are **historical facts** and
  MUST NOT be rewritten.
- **Sidecar subtree `<sessionId>/`** (present for richer sessions) contains:
  - `subagents/*.jsonl` — full subagent transcripts; **DO contain `cwd`** (must be
    rewritten). `subagents/*.meta.json` — `agentType`/`description`/`toolUseId`,
    **no path** (moved verbatim, never rewritten).
  - `tool-results/*.txt` — overflow storage for large tool outputs (can be **multi-MB**,
    one was 1.4M tokens). Moved verbatim, never rewritten.
  - `hook-*-stdout.txt` — captured hook stdout. Moved verbatim.
- **`memory/`** is at **project-folder level** (sibling of session jsonls), shared across
  the project's sessions. It does NOT move with a single session. It **may be a symlink**
  (e.g. into the working tree) — use `lstat`, never follow/copy.
- **`~/.claude.json`** has a `projects` dict keyed by absolute path. Per-project values
  include `allowedTools`, `mcpServers`, `enabled/disabledMcpjsonServers`,
  `hasTrustDialogAccepted`, plus stale-after-move state: `lastSessionId`,
  `lastSessionMetrics`, `exampleFiles`, costs. The file also has ~24 unrelated top-level
  keys (including `userID`) that must be preserved. It is `0600` and written by every
  live Claude Code instance.
- **Data hazards:** session jsonl can contain **corrupt/partial lines** (embedded NUL
  bytes from interrupted writes). Main jsonl files can reach **100MB+**. → Always stream
  line-by-line, skip/pass-through unparseable lines, never load-and-parse-all.

**Source of truth is always the on-disk jsonl. Claude Code reads files, not our DB.**

## 3. Confirmed product decisions

1. **Operation = MOVE** (source removed). Multi-session selection supported.
2. **cwd rewrite = prefix re-rooting.** For each structural cwd field (top-level `cwd`
   AND nested `attachment.response.cwd`): if the value equals the source root or is under
   it, re-root the prefix to the target (`<src>/crates/x` → `<dst>/crates/x`). cwd values
   outside the source root (`/tmp`, `~/.cache`, sibling dirs) are left untouched.
   **Message bodies and tool output are never rewritten.** `gitBranch` is never rewritten.
3. **Full `<sessionId>/` subtree moves** with the session (subagents + tool-results +
   hooks). `*.meta.json` and `tool-results`/`hooks` move verbatim; only `*.jsonl` files
   get cwd rewriting.
4. **`memory/` never moves** (project-level; may be a symlink).
5. **Live-session guard:** refuse to move a session whose file mtime is within N seconds
   (default 60) or is otherwise detected as actively written. Clear message asks the user
   to close it first.
6. **Recovery via retained trash + compact SQLite record:**
   - Files we rewrite (main jsonl + subagent jsonls): original is `rename`d into
     `~/.claude/.cc-move-trash/<moveId>/`; the rewritten version is written to target.
   - Unchanged sidecars (tool-results/meta/hooks): `rename`d source → target (no second
     copy of large files).
   - **Trash is retained indefinitely — NO automatic GC.** A manual "purge" action and
     per-move + total disk-usage display are provided in the UI.
   - SQLite stores move history + metadata + a **compact per-line cwd-change record**
     (line_no, old, new). Full byte-level recovery comes from trash. Small jsonls (under
     a size cap) may additionally store a full line snapshot.
7. **`~/.claude.json`:** auto-create `projects[<target>]` if missing, cloning a **field
   allowlist** from the source entry (`allowedTools`, `mcpServers`,
   `enabled/disabledMcpjsonServers`, `hasTrustDialogAccepted`); reset/omit stale fields
   (`lastSessionId`, `lastSessionMetrics`, `exampleFiles`, costs). Read-modify-write under
   a short lock, re-read immediately before atomic temp+rename, merge only the `projects`
   subtree, preserve all other keys. Source entry left untouched.
8. **Pre-move confirmation/preview dialog** lists: sessions, A→B, # structural cwd fields
   to rewrite, sidecars involved (incl. tool-results size), whether `.claude.json` gains
   an entry, and trash backup size.
9. **SQLite index covers ALL projects/sessions** (rich metadata, NOT message content),
   refreshed manually. Move operations update the relevant rows immediately.

## 4. Architecture

**Stack:** electron-vite (Vite + Electron + React + TypeScript); **better-sqlite3** in
the **main** process; renderer is pure React with `contextIsolation` + a preload IPC
bridge. ALL filesystem / SQLite / move logic lives in the main process.

### Main-process modules (small, single-purpose, independently testable)

| Module | Responsibility | Depends on |
|---|---|---|
| `pathCodec` | `encode(absPath)` → folder name (`[^a-zA-Z0-9]→-`). Prefix re-root helper `reRoot(cwd, srcRoot, dstRoot)`. Decode is unsupported (lossy) by contract. | — |
| `jsonlScanner` | Stream a `<id>.jsonl`; extract metadata (first user message preview via `custom-title`>`ai-title`>first user msg; started/last timestamp from message lines only; message_count; line_count; gitBranch; version; entrypoint; isSidechain; distinct cwds; size; mtime). Skip corrupt lines. Detect sidecar subtree + counts. | — |
| `scanner` | Walk `~/.claude/projects/*`; per session call `jsonlScanner`; aggregate by real (first) cwd; cache by (size,mtime) to skip unchanged files; produce index diff. | jsonlScanner, db |
| `fsBrowser` | List subdirectories of an arbitrary path for the right pane (name, isDir, isGitRepo flag). | — |
| `cwdRewriter` | Given source lines + (srcRoot,dstRoot), parse each line as JSON, re-root top-level `cwd` and nested `attachment.response.cwd` by prefix rule, leave everything else byte-identical (incl. lines without cwd and corrupt lines). Emit rewritten content + per-line change record. | pathCodec |
| `mover` | The move + staging + commit + reconcile + rollback core (see §5). | db, pathCodec, cwdRewriter, claudeJson |
| `claudeJson` | Read / atomic merge-write `~/.claude.json` projects subtree (allowlist clone, lock, re-read-before-rename, preserve other keys). | — |
| `db` | better-sqlite3 schema + migrations + queries. | — |
| `ipc` | Typed IPC handlers exposed to renderer via preload. | all |

### Renderer (React)

3-pane CSS-grid layout + bottom action bar + modals.

- **Left — DirectoryPane:** projects aggregated by real cwd (tree or flat list), session
  count, "has moved sessions" badge. Reads `projects`/`sessions` from DB.
- **Middle — SessionPane:** sessions in the selected directory, **multi-select**. Columns:
  title/preview, message count, size, last activity, moved badge.
- **Right — FsBrowserPane:** full filesystem directory browser, breadcrumb, **single-select**
  target. Indicates if target is already a known project.
- **MoveBar:** `Move N sessions → <target>` (enabled with ≥1 session + a target) →
  **ConfirmModal** (preview per §3.8) → execute → progress → per-session result.
- **Refresh:** manual; re-scans disk, diffs vs `sessions`, shows `+N / -M / ~K` preview;
  scan errors surfaced as a non-blocking warning (never silent).
- **History view (secondary):** lists `moves`, shows trash disk usage, supports **undo**
  (rollback a completed move from trash) and **purge** (manual trash deletion).

## 5. Move algorithm (per session)

Batch semantics: each selected session is an **independent committed unit**
(continue-on-error); the summary reports per-session success/failure.

Pre-flight (before any mutation, per session):
1. **Live guard:** stat the jsonl; if mtime within threshold → refuse with message.
2. **Collision guard:** if target folder already contains `<id>.jsonl` or `<id>/` → block
   (never overwrite); report conflict in preview.
3. **Encode-collision guard:** if `encode(target)` folder already exists and its sessions'
   real cwd differs from `target` → block (lossy-encoding collision).
4. Compute `srcRoot` (the selected directory's real path), `dstRoot` (target),
   `targetFolder = encode(dstRoot)`; create target folder if missing.

Commit (copy → verify → commit → delete-last; never delete source first):
5. **Snapshot/record:** open `moves` row (status=`pending`); record metadata.
6. **Rewrite + write to target:** stream main jsonl through `cwdRewriter`, write rewritten
   file to target; same for each `subagents/*.jsonl`. Record per-line cwd changes.
7. **Move unchanged sidecars:** `rename` `tool-results/`, `hooks`, `*.meta.json` source → target.
8. **Verify:** confirm target files exist, line counts match, no write errors.
9. **Stage originals to trash:** `rename` original main jsonl + original subagent jsonls
   into `~/.claude/.cc-move-trash/<moveId>/` (preserving relative layout).
10. **Update `.claude.json`** per §3.7; set `claude_json_updated`.
11. **Commit:** `moves.status=done`; update `sessions`/`projects` index rows.

Failure / crash handling:
- Any error before step 11 → **rollback**: restore originals from trash/source, remove
  partial target files, mark `moves.status=failed`.
- **Startup reconciler:** on launch, find `moves.status=pending`; based on what is on disk,
  either complete or roll back; never leave a half-moved session.

Undo (user-initiated, on a `done` move while trash exists):
- Move target sidecars back to source; restore trash originals to source; delete target
  rewritten jsonls; revert `.claude.json` change; mark `rolledback`.

## 6. SQLite schema

```
projects(
  project_path_abs PK, folder_name, exists_on_disk, in_claude_json,
  session_count, total_size_bytes, last_activity_at,
  first_indexed_at, last_indexed_at )

sessions(
  session_id PK, project_path_abs, folder_name, cwd,
  title, first_message_preview, started_at, last_activity_at,
  message_count, line_count, size_bytes, mtime,
  git_branch, claude_version, entrypoint, is_sidechain,
  has_sidecar, subagent_count, tool_results_bytes,
  moved_flag, last_move_id, first_indexed_at, last_indexed_at )

moves(
  id PK, session_id, project_name,
  source_dir_abs, source_folder, source_cwd,
  target_dir_abs, target_folder,
  moved_at, status,                 -- pending|done|failed|rolledback
  rewritten_field_count, sidecar_bytes, trash_path, claude_json_updated )

cwd_changes(move_id, file_rel, line_no, old_cwd, new_cwd)  -- compact rewrite record

snapshot_lines(move_id, file_rel, line_no, content)        -- only for small jsonls under cap

meta(schema_version)
```

`sessions`/`projects` are a display cache. The mover **always re-validates** target files
(size+mtime) immediately before mutating; it never trusts the DB for the move itself.

## 7. Error handling & edge cases

- Stream + skip corrupt (NUL) lines; pass them through byte-identical on rewrite.
- Size cap for SQLite `snapshot_lines`; large files rely on trash only.
- Cross-filesystem target: `rename` may fail across mounts → fall back to copy+delete,
  with the same verify-before-delete discipline.
- `memory/` symlink: `lstat`, never follow or move.
- Self-referential `~/.claude` project (cwd is the data dir): warn; allow only with
  explicit confirmation since rewriting could touch the tool's own storage paths.
- `.claude.json` concurrent writers: lock + re-read-before-rename + merge `projects` only.
  Consistent with the refuse-on-live stance (advise no running Claude during a move).
- Refresh scan errors surfaced, never silently swallowed.

## 8. Testing

- **vitest.** Pure modules with fixtures: `pathCodec` (snapshot-tested against real folder
  names incl. leading `-` and `--`), `cwdRewriter` (fixture with the source path in BOTH a
  cwd field and a message body — asserts body untouched, prefix re-rooted, `/tmp` cwd kept,
  corrupt line passed through), `jsonlScanner` (multi-cwd, no-cwd line types, missing
  timestamps, title precedence).
- **mover** integration tests against a temp fake `~/.claude` tree: happy path, multi-session
  batch with one failure, collision block, live-session refusal, crash-mid-move reconciler,
  undo-from-trash, cross-filesystem fallback.
- Target ≥80% coverage.

## 9. Out of scope (v1, YAGNI)

- `fs.watch` live sync (manual refresh only).
- Copy (non-destructive duplicate) mode.
- Editing session content beyond cwd re-rooting.
- Automatic trash GC (manual purge only, by explicit user request).
