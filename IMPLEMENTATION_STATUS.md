# Implementation Status

## Completed

- Phase 0: Repository and environment audit.
- Phase 1: Django, SQLite, and local runtime foundation.
- Phase 2: Workspace and IndexedDB foundation.
- Phase 3: Local HTML5 Video Player.
- Phase 4: Subtitle Parser and Cue Management.
- Phase 5: Answer Engine.
- Phase 6: Progress Statistics.

## Phase 2 Scope

- Added a UUID-based SQLite `Workspace` record with active and archived states.
- Added local Workspace creation, selection, archive, and restore flows.
- Added IndexedDB database version 1 with `workspaces`, `settings`, and `pendingOperations` object stores.
- Workspace creation persists locally before server registration. Failed registrations remain queued for a later retry.
- Added CSRF-protected local JSON endpoints for Workspace listing, registration, archive, and restore.
- Generated and reviewed `core/migrations/0001_initial.py`, then applied it to the project SQLite database after the user's instruction to complete remaining phase-two work.

## Deferred to Later Phases

- Workspace deletion and tombstones.
- Practice projects, subtitles, cues, and progress stores.
- Vocabulary cache and synchronization.
- Workspace leases and fencing tokens.
- Persistent browser storage requests and cross-browser compatibility acceptance.

## Current Data Notes

- `shadowing.sqlite3` was preserved. It was zero bytes before the Workspace migration; it now contains the `core_workspace` table and Django migration history. It contains no Workspace records.
- IndexedDB data belongs to the current browser profile and local application origin.
- No new package dependencies were added.

## Phase 3 Scope

- Added local MP4/WebM selection and HTML5 playback using browser object URLs; video file bytes are never sent to Django or stored in IndexedDB.
- Added `canPlayType` checks and media error messages for unsupported containers/codecs and lost local-file access.
- Added object URL cleanup on file replacement, Workspace change, and page exit.
- Added Workspace-scoped video metadata in IndexedDB version 2, with an additive `videos` store and indexes. Existing version 1 stores and records are preserved by the upgrade routine.
- Added a versioned sampled fingerprint: SHA-256 hashes of 64 KiB samples from the beginning, midpoint, and end, combined with file size and sample offsets. It reads at most 192 KiB and is not a guarantee that two files are identical.
- Added optional File System Access API handle recovery with permission checks and a normal file-input fallback.
- No Django migration or dependency was added. The existing SQLite database was not modified.
- Browser-level playback and actual browser IndexedDB upgrade acceptance remain unverified because no browser was available in the session.

## Phase 4 Scope

- Added a dependency-free browser parser for English SRT and WebVTT subtitles. It reads cue boundaries and timestamps, strips common formatting and voice tags, decodes common entities, identifies likely speaker labels and non-speech cues, and reports malformed blocks while retaining valid cues.
- Added a local import preview with editable/removable speaker labels, non-speech classification and activation controls, and an explicit confirmation step before valid cues are stored.
- Added Workspace-scoped practice projects linked to a stable video fingerprint and subtitle-content SHA-256 digest. A different subtitle creates an independent project; importing identical normalized subtitle content reopens its existing project and preserves its progress.
- Upgraded IndexedDB additively from version 2 to version 3 with `practiceProjects`, `subtitles`, and `cues` stores. Existing Workspace, settings, pending operation, and video records are preserved by the version-change handler.
- Added Cue editing for text and independent start/end timing adjustments, a project-wide offset from -10 to +10 seconds in 0.1 second steps, and split suggestions based on sentence boundaries/text timing. Splitting deactivates and retains the parent history and creates two Not Attempted children.
- Subtitle files and complete video files remain in the browser only. The Django API and SQLite schema were not changed; no dependency was added and no server migration was generated or applied.
- Added parser, Cue logic, and IndexedDB schema-upgrade tests. JavaScript tests passed (13/13) with Node's `--test-isolation=none` option because normal worker spawning is denied in the environment. Django tests passed (17/17) with a test-only `DJANGO_SECRET_KEY` environment value.
- Interactive browser verification could not be performed because no browser was available. The IndexedDB version 2-to-3 upgrade is covered with schema simulation tests but still needs browser acceptance testing.

## Phase 5 Scope

- Added a standalone `answer-engine.js` module for answer normalization, comparison, attempt recording, status transitions, and the practice interface. Comparison follows section 8.1: case and extra whitespace normalization, ordinary punctuation removal, straight/curly apostrophe equivalence with internal apostrophes preserved, and hyphens converted to spaces. It does not correct spelling, match synonyms, or expand contractions. The expected text is the parser-cleaned Cue text; speaker labels remain separate.
- Added a practice action for active speech Cues. The Cue text is hidden in the practice view until the user submits an answer; Cue editing is collapsed by default. The interface shows clear correct/incorrect feedback, supports Retry and Continue after incorrect answers, and records Skip events separately. Continue selects the next active speech Cue when one remains.
- Persisted attempts, total attempt count, first-attempt correctness, status changes, Retry/Continue/Skip events, and timestamps in the existing Cue record. Raw typed answers are used only for in-memory comparison and are not included in the stored record or sent over the network.
- Added local sentence replay using effective Cue timestamps (original timing + project offset + Cue adjustments). Project-local before/after replay padding is adjustable from 0 to 2 seconds and defaults to 0.25 seconds on each side. These optional fields are stored on existing project records; IndexedDB remains version 3 and needs no object-store migration.
- Updated Cue text editing to remain collapsed by default so the expected answer is not shown in the exercise list before submission.
- Added answer-comparison, status-transition, history, and raw-answer privacy unit tests. All JavaScript tests passed (25/25) using `node --test --test-isolation=none tests/*.test.mjs`. Django tests passed (17/17) using the existing `.venv` and a test-only `DJANGO_SECRET_KEY` value. JavaScript syntax checks passed for the changed modules.
- No new dependencies, Django migrations, or SQLite schema/data changes were made. The actual SQLite file was checked read-only after tests; it still contains only the existing `core_workspace` and `django_migrations` tables, migration `core/0001_initial`, and zero Workspace records.
- Interactive browser verification could not be performed because the available browser inventory was empty. Playback, live IndexedDB writes, and UI behavior therefore still need a browser acceptance pass.

## Phase 6 Scope

- Added three Persian progress metrics for the current project: Correct Completion, Coverage, and First Attempt Accuracy. Each metric is calculated from the active Cue records already loaded from IndexedDB; inactive Cue versions and cues with `active: false` are excluded, including inactive Non-Speech cues. Active Non-Speech cues remain eligible.
- Correct Completion counts active Cues whose current status is `completed`. Coverage counts active Cues with `completed`, `attempted-incorrect`, or `skipped` status. First Attempt Accuracy counts active Cues whose first recorded attempt is correct over active Cues with at least one recorded attempt; a skipped Cue with no attempt is excluded.
- Statistics are recomputed when the project load event supplies Cue records and after the Answer Engine emits a saved Cue progress event. No aggregate statistics are stored. IndexedDB remains version 3 and no record schema was changed.
- Added boundary, mixed-state, inactive Cue, skipped-without-answer, progress-update, and persisted-record reload-simulation tests. Added Django homepage assertions for the three metric labels and module.
- All JavaScript tests passed (33/33) with `node --test --test-isolation=none tests/*.test.mjs`. All Django tests passed (17/17) with the existing `.venv` and a test-only `DJANGO_SECRET_KEY` value.
- The actual SQLite database was inspected read-only before and after test execution: integrity check is `ok`; it retains only `core_workspace` and `django_migrations` tables, the existing `core/0001_initial` migration record, and zero Workspace rows. No SQLite data/schema changes, Django migrations, or dependencies were added.
- No browser was available in the session. The rendered progress panel, event-driven UI update, and actual browser IndexedDB reload could not be interactively verified. The JavaScript test simulates reloading persisted Cue records and rebuilding the aggregates; browser acceptance remains outstanding.

## Phase 7 Scope

- Added Workspace-owned `VocabularyEntry` and `VocabularyMeaning` Django models. A database uniqueness constraint uses the normalized word/phrase per Workspace; normalization folds case and collapses whitespace while preserving apostrophes and inflected forms. Meanings are manually entered Persian text and no translation service is used.
- Added CSRF-protected local Django endpoints to list/search, create, edit, and delete entries. Meaning lists support adding, editing, and removing meanings. Duplicate writes return the existing entry with HTTP 409 so the UI can open it for editing. Archived Workspaces are read-only and all notebook queries are Workspace-scoped.
- Added subtitle selection after a submitted answer (correct or incorrect) and after Skip. A one-click word selection and a two-click inclusive phrase-selection mode populate the manual form. The form also supports words and phrases that do not occur in a subtitle.
- Added notebook UI for manual entry, search, edit, meaning visibility (hidden by default), and confirmed deletion. When SQLite cannot be reached, cached entries can be searched and read; writes require the canonical SQLite database. Outbox and offline writes remain for Phase 9.
- Upgraded IndexedDB additively from version 3 to version 4 with a Workspace-indexed `vocabularyCache` store. Existing stores and records are preserved by the upgrade path. Successful full server reads refresh that Workspace's cache. No pending operations or synchronization behavior was added.
- Generated and reviewed `core/migrations/0002_vocabularyentry_vocabularymeaning_and_more.py`. It creates the two vocabulary tables, Workspace and entry foreign keys, validation checks, and uniqueness constraints. It has **not** been applied to `shadowing.sqlite3`; the real database remains at `core/0001_initial` until separately approved.
- Added API/model, Workspace isolation, duplicate normalization, phrase selection, IndexedDB additive-upgrade, raw-answer handling, and notebook request-scope tests. Final JavaScript tests passed (38/38) with `node --test --test-isolation=none tests/*.test.mjs`. Final Django tests passed (24/24) using an in-memory SQLite database and test-only `DJANGO_SECRET_KEY`. Changed JavaScript syntax checks passed, and `makemigrations --check --dry-run` reported no model/migration drift.
- Raw typed answers are compared and reduced to attempt statistics by the existing Answer Engine; they are not part of the IndexedDB Cue record. The notebook module does not read the exercise answer input and sends only the selected form and manually entered meanings to same-origin Django. No answer or subtitle text is logged by notebook code, no external request is made, and the new API rejects unexpected `answer` fields.
- The project SQLite file was inspected read-only after tests: integrity check `ok`, only `core_workspace` and `django_migrations` application tables, only `core/0001_initial` recorded, and zero Workspace records. No SQLite schema or data was changed and no new dependency was installed.
- Interactive browser verification could not be performed because the available browser inventory was empty. The selection gestures and visual management flow therefore still need browser acceptance. Vocabulary API operations also remain unavailable against the project SQLite file until the new migration is reviewed and separately approved for execution.

## Phase 8 Scope

- Added dependency-free offline lemma suggestions in `core/lemmatization.py`, using English inflection rules and compact, source-maintained irregular-form maps. No external dictionary, NLP package, or large data file was added. The implementation handles common regular verb, plural noun, and comparative/superlative adjective patterns; selected phrases are processed token by token, including common phrasal verbs such as `looking it up` → `look it up`.
- Added conservative ambiguity handling, including separate `see` and `saw` suggestions for `saw`. The interface does not preselect a suggestion: users may select a candidate, edit the proposed base form, confirm the relation, or reject all suggestions.
- Added strict JSON endpoints for suggestions (`{"form": ...}` only) and relation confirmation (`{"form": ..., "lemma": ...}`). Input validation accepts bounded English words/phrases, rejects punctuation/control characters and common sentence-like forms, and refuses unknown JSON fields. Requests contain only the selected form; the notebook module does not read or send the practice answer or subtitle text.
- Added a nullable self-reference from `VocabularyEntry` to its base entry. The confirmation endpoint creates or reuses both independent entries in the path Workspace and stores their relation transactionally. Duplicate spellings create no self-reference. Workspace scoping and archived-Workspace write protection are enforced at the API.
- Created and reviewed `core/migrations/0003_vocabularyentry_lemma_entry.py`, dependent on Phase 7 migration `0002_vocabularyentry_vocabularymeaning_and_more.py`. Neither migration was run on the project SQLite database. Enabling the vocabulary notebook and lemma relations there requires separate approval to apply Phase 7 migration `0002` first and this Phase 8 migration `0003` second.
- Added Python rule, phrase, ambiguity, sentence rejection, relation persistence, Workspace-isolation, archived-Workspace, and strict-input tests, plus JavaScript request-scope and explicit-choice tests. JavaScript tests passed (40/40). Django tests passed (34/34) using the test runner's temporary SQLite database; the configured database path was randomized under `%TEMP%` and checked not to match the project database. `makemigrations --check --dry-run` reported no model/migration drift.
- The real `shadowing.sqlite3` was inspected using SQLite read-only mode after test execution: integrity check `ok`, tables remain `core_workspace`, `django_migrations`, and `sqlite_sequence`; only `core/0001_initial` is recorded and the Workspace count is zero. No dependency was installed and the database schema/data was not changed.
- Browser inventory was checked again and remains empty. Interactive selection, correction, rejection, and relation confirmation could not be visually exercised. The hand-maintained lexicon/rules intentionally trade coverage for zero added data and dependencies; contextual disambiguation is unavailable, and the sentence-shape filter is heuristic rather than a full parser.

## Phase 9 Scope

- Upgraded IndexedDB additively from version 4 to version 5 with Workspace-indexed `syncOutbox` and `syncConflicts` stores. Existing Workspace, practice, cache, and Workspace-registration operation stores remain intact. Local vocabulary create, edit, delete, and confirmed lemma relations now queue UUID-addressed operations; repeated edits to the same queued entry coalesce without changing its idempotency key. Ordering is preserved for dependent lemma operations.
- Added server-side vocabulary `version` values and `ProcessedSyncOperation` receipts. Migration `core/migrations/0004_vocabulary_sync.py` depends on `0003_vocabularyentry_lemma_entry.py`, which depends on Phase 7 migration `0002_vocabularyentry_vocabularymeaning_and_more.py`. The migration was reviewed and was not applied to `shadowing.sqlite3`.
- Added `POST /api/workspaces/<uuid>/vocabulary/sync/` for batches of up to 50 strict vocabulary-only operations and `GET` on the same route for a Workspace-only snapshot. Each operation checks its base version, applies entry/meaning/lemma changes atomically, and stores an operation UUID receipt in the same transaction. Replaying identical operations returns the stored result; reusing an operation UUID with different data is rejected. Stale writes retain local payload and server snapshot in the browser conflict store, show base/server/local versions, and offer Keep Server, Keep Local, and manual merge paths.
- Sync payloads are allowlisted to operation UUID, Workspace/entry identifiers, operation type, base version, vocabulary form, meaning IDs/text, and optional lemma entry ID. Raw exercise answers, subtitle text, and video data are not read by the synchronization module or included in requests. No external requests or dependencies were added, and synchronization does not run migrations.
- Added Django coverage for batch creation, meanings and lemma links, Workspace separation, idempotent replay, UUID reuse, stale-version conflicts, strict payload rejection, and archived Workspaces. Added IndexedDB schema and JavaScript privacy/outbox tests. JavaScript tests passed (41/41); Django tests passed (39/39) against the isolated in-memory test database; `makemigrations --check --dry-run` reported no model/migration drift.
- `shadowing.sqlite3` was inspected before and after Django commands using SQLite read-only mode: integrity is `ok`, tables remain `core_workspace`, `django_migrations`, and `sqlite_sequence`, and only `core/0001_initial` is recorded. No real-database migration or write occurred.
- Browser inventory was empty in this session, so offline queueing and synchronization could not be exercised interactively. Automated tests cover schema preservation and the server synchronization behavior; browser acceptance remains outstanding.

## Phase 10 Scope

- Added a Workspace-scoped SQLite lease with a holder UUID, expiry timestamp, and monotonically increasing fencing token. New claims increment the token; the same active holder renews without incrementing it. The lease lasts 60 seconds and the browser sends a heartbeat every 15 seconds.
- Added lease acquire, heartbeat, and release endpoints. Vocabulary sync batches and legacy vocabulary create, edit, delete, and lemma-confirm writes now require a current holder/token pair. Sync operation fields and idempotency hashes remain unchanged; lease credentials travel in request headers. Reads and local Outbox writes remain available without a lease.
- Added `static/js/workspace-lease.js` to coordinate same-browser tabs with Web Locks and a per-browser holder identifier. Sync operations are serialized by Workspace lock. Lease metadata is not stored in IndexedDB; no IndexedDB version change was needed.
- Created and reviewed `core/migrations/0005_workspacelease.py`, dependent on `0004_vocabulary_sync.py`. The project SQLite database was not migrated. Django test runs used a separately configured temporary SQLite path and created their isolated test database there.
- Added lease lifecycle, heartbeat cadence, fencing rejection, stale-holder overwrite prevention, Workspace isolation, and privacy coverage. JavaScript tests passed (44/44); Django tests passed (46/46); changed JavaScript syntax checks passed; `makemigrations --check --dry-run` reported no model/migration drift.
- The project SQLite database was inspected read-only after tests: integrity remains `ok`, only `core/0001_initial` is recorded, and vocabulary/lease tables are absent. No dependency was added and no external service was contacted.
- Browser inventory was empty, so live Web Locks and visual interaction could not be checked in a browser. The API and lease manager are covered by automated tests; interactive browser acceptance remains outstanding.
