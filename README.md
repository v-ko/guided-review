# Guided Review
Early alpha: committed for a tech preview. It's usable but ironically in a not-entirely-reviewed state.

This extension offers a UI for working incrementally on specification documents or code review documents. We work with Markdown (Mermaid supported) where we can add references to HEAD-to-working-tree diffs. The right side of the UI is for receiving agent suggestions for altering the specification/review doc we're working on. The changes are communicated via native VS Code language-model tools. This means you have to instruct the agent to connect to the document in Suggestion mode.

## Installation
### From GitHub Releases
Download the `.vsix` file from the [latest release](https://github.com/v-ko/guided-review/releases/latest). In VS Code, open the Extensions view, select **... > Install from VSIX...**, and choose the downloaded file.

### From Source
```
git clone https://github.com/v-ko/guided-review.git
cd guided-review
npm ci
npm run package
code --install-extension dist/guided-review-0.X.0.vsix --force
```

## Usage
For any markdown documemt use the action from the command palette **Guided Review: Open in Suggestion Mode**.

Or tell the bot to generate a guided review for the unstaged code. Either by connecting to the document session (preferably) or by producing it at once.

![Guided Review screenshot](https://github.com/user-attachments/assets/6885c5da-183c-4e0e-bc68-c083f33289f3)
