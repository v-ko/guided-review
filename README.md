# Guided Review
This extension offers a UI for working incrementally on specification documents or code review documents.

You tell the agent to open a document (markdown) in "suggest mode" or to open a "suggestion session" and then you interact with the agent through accepting suggestions, or giving targeted feedback through the suggestion-view UI. It's similar to editing a word document colaboratively with comments, strikethroughs, etc.

The markdown syntax is expanded to allow including diff sections. That way the agent can refer to changes it has made in the code and prepare entire review stories for you to stage through the suggestion view itself.

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
