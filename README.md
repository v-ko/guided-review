# Guided Code Review

For the projects you're not coding entirely on vibes - you want to do proper code reviews. One of the cumbersome tasks, sepecially when agents generate heaps of code, is to do the review in proper order and with a good idea about the intent of the developer behind the implementation.

This extension offers a markdown/mermaid based format for presenting the unstaged changes. It's primarily usecase is for an agent to write a guided tour of the unstaged changes. Diffs are included in the document.

When doing the review you can accept/stage changes directly from the preview-tab. The extension itself includes skill definitions for the agent, so by just requesting the creation of a code review document - the agent should understand the format and use the included tools for format validation, etc.

Staged changes count as reviewed, including changes staged outside the preview. Editing the explanation does not reset that state; unstaging does.

If the review is not already open, run **Guided Code Review: Open Review** from the Command Palette.

For optional cleanup, run **Guided Code Review: Clean Up Completed Reviews** from the Command Palette and confirm removal.

**Experimental alpha.** Functional, but expect rough edges.

## Implementation details
As per A.Karpathy's idea - the review instructions include a request to the agent to use the ASD-STE100 simplified english specification.

## Limitations
- Requires VS Code 1.134+, Git and a trusted local workspace; regular UTF-8 files only.
- Only Linux has been verified; macOS and Windows are targets, not verified platforms.
- Git line-ending conversions are unsupported; keep `core.autocrlf` false or unset.

## Future development ideas
- A convention for ignoring the review md files and generated snapshot json files
- VSC platform (GitHub etc.) integration/compatibility
