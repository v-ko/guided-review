---
name: guided-review
description: 'Collaborate on Markdown documents in suggestion sessions: structure notes, draft specifications, revise documentation, and explain code with live review-diff blocks. Use when the reader wants to develop a document through suggestions or review code changes with user-controlled acceptance and staging.'
argument-hint: 'Markdown file to work on, or nothing for a blank document'
---

# Guided Review

The suggestion session shows a Markdown document next to your suggestions. Follow the reader's task: structure notes, draft specifications, revise documentation, or explain code. The reader accepts, declines or asks for more.

## Session

- Start with `guidedReview_openSession`: pass `path` for an existing Markdown file, or omit it to start a suggestion session with a blank document. It returns the `session` name that every other tool takes, and the document path. Opening a file that already has a session joins it.
- To join a suggestion session the reader already opened, find it with `guidedReview_listSessions` and pass its `session` name to the other tools.
- The document is read-only for you. Read it with your normal file tools; `guidedReview_waitForFeedback` returns the current path.

## Suggestions

Add suggestions with `guidedReview_addSuggestions`; `guidedReview_listSuggestions` shows the current ones and their problems. All your changes go through suggestions, even on an empty document. Follow the user's task rather than defaulting to restructuring. Present at most 2-3 bullet points at a time, then wait for feedback before continuing.

Suggestions have a kind. layout (the default) only restructures: keep the wording, since the view shows it by colouring the text it keeps. edit changes wording, shown to the reader as a word diff; offer edits only when the reader's request asks for wording changes, and give them a from/to span.

A suggestion replaces the span from..to, inserts after a quote, or appends to the end without an anchor. Quotes are plain text without Markdown syntax; from and after must be unique. A span covering whole lines also replaces their markers (-, 1., #, >), and a span covers the inline markup around or inside it (**, `, links), so repeat what you keep in the replacement.

Remove stale suggestions with `guidedReview_removeSuggestions`. An empty list shows OK in the view.

## Feedback loop

Call `guidedReview_waitForFeedback` to wait until the reader asks for new suggestions. Call it again on timeout; do not advance without feedback. Re-read the document after each answer. Requests arrive as `{"type":"request","text"?,"selection"?:{"text","source"},"selected"?,"accepted"?,"declined"?,"outdated"?}`:

- text guides the next suggestions and wins over the defaults above when they conflict; without it, offer more of the same kind. selection is rendered text the reader selected; source is "document" or the suggestion id it was selected in.
- selected: id of the suggestion the reader picked out; text is about it (for example, rework it). It stays in the view until you remove it.
- accepted: ids applied to the document since the previous request. Accepts may break other suggestions' quotes; the returned list shows their problems.
- declined: suggestions the reader rejected, already removed. Do not offer them again unchanged; text may say why.
- outdated: code blocks whose lines changed. Capture them again (below) and suggest the updated block.

## Code blocks

A `review-diff` block shows changed lines of a file live: HEAD against the working tree. The reader approves a block in the view, which stages exactly its lines and embeds them as a `diff` fence under the block. Never write that `diff` fence yourself.

1. Call `guidedReview_captureCodeChanges` with absolute file paths. It does not edit or stage code. Give `ranges` to pick lines: new line numbers (`"41-42"`, `"41"`) or removed lines by base line number (`"old:40"`). Removed lines next to a new-line range come along, unless the call names `old:` ranges. Without ranges, it captures every change that no block in the document shows yet; `covered: true` means the file has none left.
2. Each file result has `block` (`repo`, `file`, `spans`), `shows` (changed-line ranges) and `inspection`. Before adding a block, check `inspection.boundaries`: each core's first and last line, with up to three `preceding` and `following` diff lines outside that core. Check that the endpoints match the intended functions or excerpt. Ranges are literal; a matching hash or `shows` range does not prove that the selection is correct. Recapture a mistaken range.
   - `inspection.preview` uses the same hunks as the rendered block. Each hunk has `head`, `omittedLines` and `tail`; previews keep at most 16 lines per hunk. Long lines are cut at 500 characters with `omittedCharacters`. If anything is omitted, read that source before approving the selection.
   - Neighboring lines are inspection-only, not extra lines to stage. Added lines outside the core are excluded from rendered context, so inspect the neighbors even when the preview looks complete. Each line includes its diff `kind`, text and available old/new numbers.
   - Prefer complete declarations for a walkthrough. If only part of a function is intentional, say which excerpt the block shows. Spans of different blocks cannot overlap. To capture a block again, pass its id as `block`.
3. Add an `id` (unique in the document, short kebab-case) to the returned block and put it in a `review-diff` fence inside a suggestion, next to the text that explains it:

````markdown
```review-diff
{"id": "parse-defaults", "repo": "..", "file": "src/cli.ts", "spans": [{"before": 1, "lines": 2, "after": 1, "hash": "d41f9a0c2b7e5a13"}]}
```
````

- Copy `repo`, `file` and `spans` exactly. `repo` is relative to the document's folder.
- One change can be split over blocks down to single lines. Each block stages only its own lines, so the reader can approve them one at a time. Choose splits that leave working intermediate states.
- Write the prose in ASD-STE100 Simplified Technical English, with about 20% flexibility.
