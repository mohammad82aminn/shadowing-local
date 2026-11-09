# Shadowing — Project Specification & Software Requirements

**Project:** Shadowing  
**Version:** 1.0 (Initial Product Specification)  
**Status:** Approved Architecture — Pending Implementation  
**Primary Language:** Persian  
**Secondary Language:** English

---

# 1. Project Overview

## 1.1. Purpose

Shadowing is a local, personal English-learning application designed to help users practice English sentences using movies and TV series.

The user selects a video file from their local computer and imports its subtitle file in SRT or VTT format.

The application plays the video sentence by sentence. The user listens to each sentence and types what they hear. The application compares the typed response with the expected subtitle text and determines whether the answer is correct.

The user can retry incorrect answers, skip sentences, select unfamiliar words and phrases, save vocabulary with Persian meanings, and monitor learning progress.

The application must work without external internet services during normal usage.

## 1.2. Main Objectives

- Practice English through real movie and TV-series dialogue.
- Provide sentence-based listening and typing exercises.
- Identify and save unfamiliar English words and phrases.
- Provide offline Lemmatization suggestions.
- Maintain a personal vocabulary notebook.
- Track learning progress and exercise history.
- Preserve all important data locally.
- Support encrypted backup and recovery.
- Provide Persian and English interfaces.

## 1.3. Target Usage

This is a personal desktop application running locally on the user's computer.

The application is not intended to be a public website or cloud service.

The user does not need to create an account or log in.

**Important:** Previous proposals for email registration, password-based authentication, and multi-user accounts have been superseded. Version 1 must not implement user registration or login.

Workspaces are independent personal working environments, not user accounts.

---

# 2. Technology Stack

The following technology choices are approved.

| Component | Technology |
|---|---|
| Backend | Python + Django |
| Database | SQLite |
| Database Runtime | Local SQLite database file |
| Frontend | Django Templates |
| UI Framework | Bootstrap |
| Frontend Logic | Vanilla JavaScript |
| Browser Database | IndexedDB |
| Video Player | HTML5 Video |
| Subtitle Formats | SRT and VTT |
| Local Server | Django Development Server |
| Static Files | WhiteNoise |
| Operating Environment | Local Windows Desktop |
| Startup | start.bat |
| Shutdown | stop.bat and stop-all.bat |

## 2.1. Backend

Django is responsible for:

- Workspace management.
- Vocabulary management.
- Lemmatization.
- Synchronization.
- Backup-related backend operations.
- Data validation.
- Health checks.

## 2.2. Frontend

The frontend must use Django Templates, Bootstrap, and JavaScript.

Do not introduce React, Vue, Angular, or another frontend framework without explicit approval.

Use modular JavaScript files with clear responsibilities.

All frontend dependencies, Bootstrap files, JavaScript libraries, CSS, and fonts must be stored locally.

Do not use external CDNs.

## 2.3. Database

SQLite is stored in a local file in the project directory by default. It does not need a separate database service or Docker. The database file must be preserved during normal application shutdown and must be included in the backup and recovery design where applicable.

## 2.4. Local Server

Use Django Development Server bound to:

`127.0.0.1:8000`

Configuration:

- `DEBUG=False`
- WhiteNoise for static file delivery.
- Auto Reload disabled during normal execution.
- No public network exposure.
- No automatic execution of unapproved migrations.

This is a local personal application, not a production web service.

---

# 3. Application Architecture

The application has two primary data-storage layers.

## 3.1. IndexedDB

IndexedDB is responsible for local practice data.

It stores:

- Workspaces' local metadata.
- Practice projects.
- Subtitle content.
- Cue information.
- Cue progress.
- Attempt history.
- Application settings.
- Video metadata.
- File handles when supported.
- Vocabulary cache.
- Pending synchronization operations.
- Import journals.
- Deletion journals.

## 3.2. SQLite

SQLite is the canonical server-side storage layer for:

- Workspace records.
- Workspace leases.
- Workspace deletion records.
- Vocabulary entries.
- Vocabulary meanings.
- Lemma relationships.
- Processed synchronization operations.

The vocabulary notebook is cached in IndexedDB to allow offline access.

SQLite remains the authoritative source for synchronized vocabulary records within this local application instance.

## 3.3. Data Ownership

| Data | Primary Storage |
|---|---|
| Video files | User's local filesystem |
| Subtitle content | IndexedDB |
| Practice projects | IndexedDB |
| Cue progress | IndexedDB |
| Attempt statistics | IndexedDB |
| Application settings | IndexedDB |
| Vocabulary records | SQLite |
| Vocabulary cache | IndexedDB |
| Pending vocabulary operations | IndexedDB |
| Workspace metadata | SQLite + local metadata |
| Backup files | User-selected local location |

**Critical privacy requirement:**

Raw text typed by the user as an exercise response must never be persisted in SQLite, IndexedDB, logs, or backup files.

Only the required attempt statistics must be stored.

The complete video file must never be uploaded to Django or an external service.

The browser reads the video directly from the local filesystem.

---

# 4. Workspace Management

## 4.1. Workspace Concept

A Workspace is an independent personal environment containing its own:

- Practice projects.
- Vocabulary notebook.
- Settings.
- Progress information.
- Backup history metadata.

Each Workspace has a UUID.

## 4.2. Workspace States

- Active
- Archived
- Deletion Pending
- Deleted

## 4.3. Archive

Archiving a Workspace must:

- Preserve all data.
- Remove it from the active Workspace list.
- Prevent normal editing.
- Allow restoration through Unarchive.

Archive and Unarchive require database connectivity.

## 4.4. Delete

Permanent deletion requires explicit confirmation.

The application must:

- Display the consequences of deletion.
- Display the number of pending operations.
- Delete local Workspace data.
- Delete corresponding SQLite records.
- Preserve other Workspaces.
- Keep external Backup files untouched.

If SQLite is unavailable, deletion must use a Deletion Tombstone.

The application must display `Deletion Pending` until server-side deletion is confirmed.

A local Tombstone cannot guarantee server deletion if the browser's local data is cleared before synchronization. This limitation must be communicated to the user.

## 4.5. Offline Workspace Creation

If SQLite is unavailable when the application starts for the first time, a provisional Workspace may be created in IndexedDB.

It must have:

- A UUID.
- A local registration state.
- Local IndexedDB storage.
- A pending registration operation.

After SQLite becomes available, the Workspace is registered.

A provisional Workspace is not automatically available in other browsers.

---

# 5. Video Management

## 5.1. Local Video Selection

The user selects a video file from the local computer.

The video must not be uploaded to Django.

Use browser-supported local file access and HTML5 Video.

## 5.2. Supported Formats

Version 1 supports:

- MP4 with browser-compatible codecs.
- WebM with browser-compatible codecs.

The file extension alone does not guarantee compatibility.

The application must detect unsupported media and show an understandable error.

FFmpeg is not included in Version 1.

## 5.3. Video Identification

Use a sampled fingerprint by default.

The fingerprint consists of:

- File size.
- Hash of selected data from the beginning.
- Hash of selected data from the middle.
- Hash of selected data from the end.

An optional full-file hash may be calculated when stronger identification is required.

A sampled fingerprint is not a cryptographic guarantee that two files are identical.

## 5.4. File Handle Recovery

Attempt to restore the previous file handle when supported and authorized by the browser.

If restoration fails, ask the user to select the video again.

Do not store actual video files in IndexedDB.

---

# 6. Subtitle Management

## 6.1. Supported Formats

Version 1 supports:

- SRT
- VTT

Only English subtitles are supported initially.

The user manually imports the subtitle file.

## 6.2. Subtitle Parsing

The parser must:

- Read timestamps.
- Extract subtitle text.
- Identify cue boundaries.
- Handle common formatting tags.
- Identify speaker labels where possible.
- Identify non-speech descriptions.
- Validate malformed cues.

If some cues are invalid:

1. Display parsing errors.
2. Preserve valid cues.
3. Ask the user for confirmation.
4. Continue with valid cues only after confirmation.

## 6.3. Subtitle Change

Importing a different subtitle file for the same video creates a separate practice project.

The previous project and its progress must remain unchanged.

## 6.4. Cue Structure

Each subtitle Cue is one exercise by default.

The user can manually split a Cue.

The application must suggest a split point based on subtitle text and timing.

The user can modify the suggested point.

When a completed Cue is split:

- Preserve the original Cue history.
- Create new child Cues.
- Set their initial status to Not Attempted.

## 6.5. Speaker Labels

Automatically detect common speaker-label patterns.

Examples:

`JOEY: How are you?`

`JOEY`

The application must display detected labels in the import preview.

The user can correct or remove them.

Speaker labels must not be included in the expected typing answer.

## 6.6. Non-Speech Cues

Examples:

- `[Music]`
- `[Door Opens]`
- `[Laughing]`

These cues are classified as Non-Speech.

They are inactive by default but can be activated manually.

Inactive Non-Speech cues must not be included in progress denominators.

## 6.7. Subtitle Offset

Each project has a global subtitle offset.

Initial proposed range:

- Minimum: -10 seconds.
- Maximum: +10 seconds.
- Step: 0.1 seconds.

Individual Cue timing can also be adjusted manually.

Original timestamps must remain unchanged.

Effective timestamps are calculated from original timestamps, global offset, and individual adjustment.

---

# 7. Video Player

The main layout:

- Video at the top.
- Typing area below.
- Vocabulary selection panel as an overlay.
- Responsive behavior across screen sizes.

The default visual style is Hybrid.

The user can change the overall appearance through Settings.

## 7.1. Sentence Replay

Allow configurable additional time before and after each Cue.

The application must replay the current sentence without requiring manual seeking.

## 7.2. Vocabulary Overlay

When the vocabulary overlay opens:

- Pause the video.
- Preserve the current playback position.
- Resume from the same position after closing the overlay.

## 7.3. Automatic Playback

After a correct response:

- Move to the next Cue.
- Wait for the configurable delay.
- Automatically play the next Cue.

All automatic behavior must be configurable through Settings.

Selecting a word must stop automatic advancement until the user presses Continue.

---

# 8. Answer Engine

The user selected the normal comparison mode.

## 8.1. Normalization Rules

The comparison engine must:

- Ignore uppercase/lowercase differences.
- Normalize repeated and extra whitespace.
- Ignore ordinary punctuation.
- Preserve internal apostrophes.
- Treat straight and curly apostrophes as equivalent.
- Convert hyphens to spaces.
- Avoid automatic spelling correction.
- Avoid synonym matching.
- Never expand contractions.

Examples:

| Expected | User Input | Result |
|---|---|---|
| Hello, world! | hello world | Correct |
| I'm happy. | i'm happy | Correct |
| I'm happy. | I am happy | Incorrect |
| We're ready. | were ready | Incorrect |
| Don't go. | don’t go | Correct |
| Well-known | well known | Correct |
| beautiful | beautifull | Incorrect |

`don't` must not be considered equivalent to `dont`.

## 8.2. Incorrect Answer

After an incorrect response, the user chooses:

- Retry.
- Continue.

Retry behavior:

- Hide the original sentence.
- Clear the previous input.
- Allow replaying the sentence.
- Preserve the attempt count.

## 8.3. Cue States

The application must support:

- Not Attempted
- Completed
- Attempted / Incorrect
- Skipped

Rules:

1. A correct answer sets the Cue to Completed.
2. A wrong answer followed by Continue sets it to Attempted / Incorrect.
3. Skipping without a submitted answer sets it to Skipped.
4. Skipping after an incorrect answer preserves Attempted / Incorrect and records a separate Skip event.
5. If a previously skipped Cue is completed later, its current state becomes Completed, while Skip history remains.
6. Retrying a Completed Cue preserves Completed and appends new attempts.

## 8.4. Attempt History

Store:

- Total attempts.
- Whether the first submitted answer was correct.
- Attempt timestamps if needed for statistics.
- Cue status transitions.

Never store the raw typed answer.

## 8.5. Word Selection

After a registered answer, correct or incorrect, the user can select vocabulary.

After skipping without an answer, the subtitle is displayed and vocabulary selection is still available.

---

# 9. Progress Statistics

Display three independent metrics.

## 9.1. Correct Completion

Completed Cues divided by all active Cues.

## 9.2. Coverage

Cues that have been addressed divided by all active Cues.

Addressed means:

- Completed
- Attempted / Incorrect
- Skipped

## 9.3. First Attempt Accuracy

Cues answered correctly on the first attempt divided by Cues with at least one submitted answer.

Skipped Cues without a submitted answer are excluded.

Inactive Non-Speech Cues are excluded from all denominators.

---

# 10. Vocabulary Notebook

## 10.1. Word Selection

The user can select:

- A single word with one click.
- A multi-word phrase using Select Phrase mode and two clicks to identify the beginning and ending words.

Phrasal Verbs and arbitrary multi-word expressions must be supported.

## 10.2. Manual Vocabulary Entry

The user can save any word or phrase, including words not suggested by the application.

## 10.3. Duplicate Detection

Duplicate detection uses the exact selected word or phrase.

Normalization rules:

- Ignore uppercase/lowercase differences.
- Ignore extra whitespace.
- Preserve internal apostrophes.
- Do not merge different inflected forms automatically.

For example, `running` and `run` are separate entries.

If a duplicate is found:

- Display a duplicate notification.
- Offer to edit the existing record.
- Do not silently create another record.

## 10.4. Persian Meanings

The user enters Persian meanings manually.

Each entry may contain multiple meanings.

Meanings are hidden by default and can be revealed or hidden by the user.

No online translation API is allowed.

## 10.5. Vocabulary Editing

The user can:

- Edit the word.
- Edit meanings.
- Add meanings.
- Remove meanings.
- Delete an entry with confirmation.
- Search entries.

## 10.6. Lemma Relationships

Both observed word forms and base forms are stored as independent vocabulary entries.

Example:

`running` → `run`

The application must preserve their relationship.

---

# 11. Lemmatization

Lemmatization must work completely offline.

The selected architecture is hybrid:

1. Offline Dictionary.
2. Morphological Rules.
3. Phrase Processing.

The system must handle:

- Inflected verbs.
- Plural nouns.
- Adjective forms.
- Irregular forms where supported.
- Phrasal Verbs.
- Multi-word expressions.

The user chooses whether to accept or modify a suggested Lemma.

For ambiguous words, display multiple valid suggestions.

For example:

`saw`:

- see
- saw

The system must not silently choose an uncertain Lemma.

Only the selected word or phrase may be sent to the local Django backend for Lemmatization.

Do not send the full sentence, subtitle file, video, or unrelated text.

The user manually confirms the suggested base form.

Words without a meaningful base form remain independent entries without a Lemma relationship.

Exact library and dictionary choices require evaluation of:

- Accuracy.
- Offline compatibility.
- Package size.
- License.
- Maintenance.
- Compatibility with the selected Python version.

Do not add a large NLP model without explaining its benefits and costs.

---

# 12. Workspace Synchronization

## 12.1. Architecture

Use:

- IndexedDB Vocabulary Cache.
- IndexedDB Outbox.
- SQLite canonical records.
- Version numbers.
- Operation UUIDs.
- Idempotent synchronization.
- Fencing Tokens.
- Server-side Workspace Lease.

## 12.2. Lease

Initial design:

- Heartbeat every 15 seconds.
- Lease validity: 60 seconds.

Use Web Locks for tabs in the same browser.

Use SQLite Lease records to coordinate different browsers using the same local application instance when the database is available.

## 12.3. Offline Behavior

If SQLite becomes unavailable:

- Continue local practice.
- Allow local vocabulary operations.
- Store changes in Outbox.
- Preserve local progress.
- Do not assume cross-browser exclusive ownership can be guaranteed offline.

After reconnecting:

- Verify ownership.
- Validate Fencing Tokens.
- Compare record versions.
- Detect conflicts.
- Ask the user to resolve conflicts.

## 12.4. Conflict Resolution

For conflicting vocabulary records, show:

- Base Version.
- Server Version.
- Local Version.

Allow:

- Keep Server.
- Keep Local.
- Manual Merge.

Never silently overwrite user data.

Archive and Unarchive require SQLite connectivity.

---

# 13. Backup and Recovery

## 13.1. Backup Scope

Only the current Workspace is included.

## 13.2. Backup Contents

Include:

- Workspace information.
- Practice projects.
- Subtitles.
- Cue information.
- Progress.
- Attempt statistics.
- Settings.
- Vocabulary records and meanings.
- Vocabulary Cache.
- Outbox.
- Sync metadata.
- Conflict information.
- Relevant deletion and recovery metadata.

Do not include:

- Actual video files.
- Portable browser File Handles.
- Raw typed answers.

Video metadata and fingerprints may be included.

## 13.3. Backup Encryption

Backup files must be encrypted.

Minimum password length: 12 characters.

Do not store the backup password.

The cryptographic algorithm, key derivation method, and iteration parameters must be selected using current security recommendations and approved before implementation.

Use authenticated encryption and random salts/nonces.

## 13.4. Backup Threshold

Display a notification after 100 meaningful changes.

Backup is manual.

The user must confirm that the exported Backup has been saved before the change counter resets.

## 13.5. Backup Procedure

Temporarily pause:

- Video playback.
- Practice actions.
- Data modifications.

Prepare a consistent snapshot of IndexedDB and SQLite.

Verify integrity.

Encrypt and export the file.

Resume normal operation.

If SQLite is unavailable, export the local Cache, Outbox, and last-known database snapshot, clearly marked as potentially stale.

## 13.6. Import

Allow:

- Import into the current Workspace.
- Import as a new Workspace.

Before applying changes, display a preview.

Show project and vocabulary conflicts.

Let the user decide how each conflict is resolved.

Import must be recoverable if one storage layer fails.

Use an Import Journal and compensating operations because IndexedDB and SQLite do not share a transaction.

Backup export remains allowed even when unresolved conflicts exist. All conflict versions must be preserved.

---

# 14. Startup and Shutdown

## 14.1. start.bat

The script should:

1. Check required software.
2. Check that the local SQLite database can be opened.
3. Check database health.
4. Check migration status without silently applying migrations.
5. Start Django.
6. Open or display the local application URL.

If SQLite is unavailable, Django should still run in Degraded Mode.

The local interface and IndexedDB practice features remain usable.

Database-dependent features are disabled with clear warnings.

## 14.2. stop.bat

Stop only the Django process started by the application.

## 14.3. stop-all.bat

Stop Django. Preserve the SQLite database file during ordinary shutdown.

## 14.4. Migration Policy

Never apply unreviewed migrations automatically.

Generate migrations, inspect their effects, explain risks, and obtain approval before applying them.

When migrations are pending:

- Keep local practice available.
- Disable database-dependent functionality until migration approval and successful execution.
- Never silently alter or delete existing data.

---

# 15. User Interface and Localization

## 15.1. Languages

Support:

- Persian (default).
- English.

The user can switch languages at any time.

## 15.2. Layout

Persian:

- RTL.
- Jalali calendar.

English:

- LTR.
- Gregorian calendar.

## 15.3. Appearance

Hybrid is the default visual style.

The user can change the overall appearance through Settings.

## 15.4. Layout

- Video at the top.
- Typing area below.
- Vocabulary panel as an overlay.
- Responsive behavior across screen sizes.

---

# 16. Security and Privacy

Requirements:

- Bind Django to localhost only.
- Do not expose the application to LAN or public internet.
- Keep CSRF protection enabled.
- Validate all backend inputs.
- Validate uploaded subtitle files.
- Protect Backup import against malicious archives and oversized inputs.
- Never execute untrusted content.
- Keep secrets outside Git.
- Do not log raw answers or full subtitle content.
- Do not send user data to external services.
- Do not use external AI APIs.
- Preserve database data during normal shutdown.
- Keep Workspace records isolated.

Because there is no login, Workspace UUIDs are not authentication credentials or a complete security boundary.

---

# 17. Error Handling

## 17.1. Subtitle Errors

Display invalid cues and allow continuation with valid cues after user confirmation.

## 17.2. IndexedDB Errors

If IndexedDB storage fails:

- Display a persistent warning.
- Allow retry.
- Allow limited continued practice where safe.
- Never claim that unsaved data has been persisted.

## 17.3. SQLite Errors

Use Degraded Mode.

Preserve local operations in Outbox.

## 17.4. Import Errors

Use Import Journal and recovery procedures.

Never leave the user with an unexplained partially imported Workspace.

## 17.5. File Errors

If video access is lost, ask the user to reselect the file.

Preserve the associated subtitle and progress.

---

# 18. Non-Functional Requirements

The application should be:

- Modular.
- Maintainable.
- Testable.
- Secure for local personal use.
- Offline-capable.
- Responsive.
- Resource-conscious.
- Understandable to its owner.
- Suitable for future extension.

Code requirements:

- Follow PEP 8.
- Follow Django best practices.
- Use clear English identifiers.
- Use English code comments and docstrings.
- Avoid unnecessary abstractions.
- Avoid giant views and giant JavaScript files.
- Separate business logic from presentation.
- Use database constraints where appropriate.
- Write meaningful automated tests.
- Document architectural decisions.

---

# 19. Development Roadmap

Implement the project in the following order.

0. Repository and environment audit.
1. Django, SQLite, and local runtime.
2. Workspace and IndexedDB foundation.
3. Video Player.
4. Subtitle Parser and Cue Management.
5. Answer Engine.
6. Progress Statistics.
7. Vocabulary Notebook.
8. Offline Lemmatization.
9. Vocabulary Cache and Synchronization.
10. Workspace Lease and Fencing Token.
11. Backup and Recovery.
12. Persian/English UI and Settings.
13. Security and Error Handling.
14. Automated and Acceptance Testing.

Do not implement the entire application in one large code-generation operation.

Each milestone must be implemented, tested, reviewed, and approved before proceeding.

---

# 20. Acceptance Criteria

Version 1 is not complete until the following scenarios pass.

## Video and Subtitle

- Local video plays without uploading it to Django.
- Compatible MP4 and WebM files work.
- Unsupported codecs produce clear errors.
- SRT and VTT imports work.
- Invalid cues are reported.
- Valid cues can be used after confirmation.
- Subtitle offset works.
- Individual Cue timing can be adjusted.
- Manual Cue splitting preserves history.
- Speaker labels are excluded from expected answers.

## Answer Engine

- Comparison rules work exactly as specified.
- Contractions are not expanded.
- Retry hides the original text.
- Wrong-answer Continue updates status correctly.
- Skip history is preserved.
- Completed status survives additional attempts.
- Raw typed answers are never persisted.

## Vocabulary

- Single words can be selected.
- Multi-word phrases can be selected.
- Duplicates are detected correctly.
- Multiple Persian meanings can be stored.
- Meanings are hidden by default.
- Entries can be edited and deleted.
- Lemma suggestions work offline.
- Ambiguous suggestions require user confirmation.

## Storage and Synchronization

- Practice data survives browser restart.
- Vocabulary Cache works while the local SQLite database is unavailable.
- Outbox preserves pending changes.
- Synchronization is idempotent.
- Conflicts are displayed.
- Fencing Token prevents stale server writes.
- Independent Workspaces remain isolated.

## Backup and Recovery

- Backup is encrypted.
- Incorrect passwords are rejected.
- Current Workspace can be exported.
- New Workspace import works.
- Existing Workspace import works.
- Conflicts are displayed before application.
- Backup can include unresolved conflicts.
- Interrupted Import can recover safely.
- Browser File Handles are not assumed portable.

## Runtime

- start.bat starts the application.
- SQLite errors do not prevent local practice.
- stop.bat stops Django only.
- stop-all.bat stops Django and preserves the SQLite database file.
- Application works without external internet.

---

# 21. Implementation Decisions Requiring Explicit Review

The architecture is approved, but some implementation details must still be evaluated before coding.

Codex must present recommendations and trade-offs for:

1. Exact Python, Django, SQLite, and dependency versions.
2. Browser compatibility baseline.
3. Offline dictionary and Lemmatization packages.
4. Exact IndexedDB schema and migrations.
5. SQLite model relationships and constraints.
6. Backup encryption and key derivation parameters.
7. Lease and Fencing Token implementation.
8. Synchronization operation format and retry policy.
9. Storage quota and persistent browser storage.
10. Exact video fingerprint sampling strategy.

Do not silently make consequential architectural decisions.

---

# 22. Final Product Definition

Shadowing Version 1 is a local, bilingual, offline-capable English listening and typing practice application.

It uses Django, SQLite, Bootstrap, JavaScript, and IndexedDB.

It supports local videos, manually imported English subtitles, sentence-level practice, intelligent but offline vocabulary suggestions, Persian vocabulary meanings, progress tracking, and encrypted backups.

The system must prioritize data integrity, user control, maintainability, and understandable code over unnecessary complexity.

**This document is the authoritative product specification.**

## Approved Database Decision Update

The user approved replacing the originally specified PostgreSQL + Docker stack with a local SQLite database. This decision supersedes all earlier PostgreSQL and Docker requirements in this document. SQLite is the local canonical Django database; IndexedDB remains the browser-side store for practice data and offline operations. No PostgreSQL service, Docker engine, database credentials, or database container is required.
