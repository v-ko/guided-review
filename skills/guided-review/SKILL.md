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

`guidedReview_listSuggestions` returns the exact `replacement` Markdown by default, alongside each suggestion's id, anchors, kind and current problems. Pass `ids` to inspect specific pending suggestions in saved order; unknown ids are errors, and `ids: []` returns none. Set `includeContent: false` for a compact inventory. Use this to recover pending content after reconnecting instead of recreating proposals from memory.

Suggestions have a kind. layout (the default) only restructures: keep the wording, since the view shows it by colouring the text it keeps. edit changes wording, shown to the reader as a word diff; offer edits only when the reader's request asks for wording changes, and give them a from/to span.

A suggestion replaces the span from..to, inserts after a quote, or appends to the end without an anchor. Quotes are plain text without Markdown syntax; from and after must be unique. A span covering whole lines also replaces their markers (-, 1., #, >), and a span covers the inline markup around or inside it (**, `, links), so repeat what you keep in the replacement.

Choose an explicit `operation`: `replace`, `insert-block`, `insert-list-items` or `insert-table-rows`. Anchors are readable plain-text quotes, not literal source edits. Missing or ambiguous anchors and unsupported structures return problems. For compatibility, omitting the operation still means replace with from/to, otherwise insert-block.

`replace` keeps fenced examples/diagrams, tables and review-reference/recorded-approval pairs whole: supply the complete replacement unit. Ordinary paragraph endpoints stay exact. `insert-block` adds spacing and inserts after the quoted container, never inside a fence.

`insert-list-items` adds single-line sibling items after the complete target item, including its children. Supply marked items; the planner uses the target indentation and marker style. New ordered items count up from the target number; existing numbers do not change. Nested replacement payloads and list items inside block quotes are unsupported.

`insert-table-rows` adds headerless pipe-table rows after a body row, or after the delimiter when quoting a header. Supply the target column count and no header/delimiter. The same operation provides row-only card rendering and a row navigation target. Nested tables are unsupported. For example:

```json
{
  "operation": "insert-table-rows",
  "after": "Similar responsibilities",
  "replacement": "| Queue | Actions | Different execution models |"
}
```

`mode` and `preview` are no longer accepted. Saved literal/preview proposals remain visible with an incompatibility problem; inspect or remove them and recreate with an operation rather than accepting them as block edits.

Remove stale suggestions with `guidedReview_removeSuggestions`. An empty list shows OK in the view.

## Feedback loop

Call `guidedReview_waitForFeedback` to wait until the reader asks for new suggestions. Call it again on timeout; do not advance without feedback. Re-read the document after each answer. Requests arrive as `{"type":"request","text"?,"selection"?:{"text","source"},"selected"?,"accepted"?,"declined"?,"outdated"?}`:

The returned `suggestions` are compact by default. Pass `includeContent: true` to include their exact `replacement` Markdown, or inspect selected ids with `guidedReview_listSuggestions`. Declined suggestions in feedback already include their original content.

- text guides the next suggestions and wins over the defaults above when they conflict; without it, offer more of the same kind. selection is rendered text the reader selected; source is "document", "comment" for the agent's reply, or the suggestion id it was selected in.
- selected: id of the suggestion the reader picked out; text is about it (for example, rework it). It stays in the view until you remove it.
- accepted: ids applied to the document since the previous request. Accepts may break other suggestions' quotes; the returned list shows their problems.
- declined: suggestions the reader rejected, already removed. Do not offer them again unchanged; text may say why.
- outdated: code blocks whose lines changed. Capture them again (below) and suggest the updated block.

The reader uses one **Send** button, labelled **Suggest** when the prompt is empty. Based on their text and context, choose whether to offer suggestions or answer with a comment. For explanations and discussion, call `guidedReview_addComment` with the `session` and nonempty `markdown`; no request ID is needed. It returns the saved `revision` and exact `markdown`. A comment does not edit the document or change suggestions. Currently only the latest comment is saved and shown, not a history. Then wait again.

For each reader request, offer suggestions or reply with a comment, not both. When offering suggestions, put any needed explanation in the suggestions; do not also post an acknowledgement, affirmation or progress comment. Use a comment when the reader needs an answer or discussion instead of document changes.

After opening or rejoining a session, call `guidedReview_readComment` before replacing its previous explanation. It returns `{comment: {revision, markdown}}`, or `{comment: null}` when none exists. This recovers exact saved Markdown even when chat tool history is unavailable. It does not recover reader requests or delivery state.

## Interactive HTML blocks

Use a fenced `review-html` block for a local animation, visualization or mock
prototype. Create the HTML file and its assets with normal file tools, then
propose the Markdown block through suggestions:

````markdown
```review-html
{"src":"./history-diagrams/replay.html","title":"Replay animation","height":460}
```
````

- `src` and a descriptive `title` are required. The optional integer `height`
  defaults to 460 pixels and must be from 120 to 1200. No other fields are accepted.
- Paths resolve from the Markdown document's folder, including in suggestions
  and comments. The page must be `.html` or `.htm`, inside the trusted workspace,
  and at most 256 KiB.
- Relative URLs in the page resolve from the page's folder. Scripts, ES modules
  (`import "./shared.mjs"`), stylesheets, images, fonts and `fetch()` work for
  files inside the workspace, so several pages can share code. Remote URLs,
  local servers, nested frames, workers and forms are blocked.
- Inline `<script>`, `<style>` and event handler attributes work. Raw HTML in
  Markdown remains disabled.
- Each block runs when the review renders. **Reload** restarts the page with
  the loaded HTML. After editing the page, refresh the review (for example, save
  the Markdown file) to load it. Changed shared files load on the next Reload.
- Unchanged frames keep their state during review updates when the browser
  supports atomic DOM moves. Older browsers restart them.
- The page runs in its own iframe, so its errors and globals do not affect the
  review. It is not a security boundary: only embed HTML the reader trusts.
- Other Markdown viewers show the JSON as an ordinary fenced code block.

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
