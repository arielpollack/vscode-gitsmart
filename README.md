# Smart Commit VS Code Extension

A VS Code extension that helps you create smart commits by filtering out console.log statements and generating commit messages using OpenAI.

## Features

- Automatically filters out console.log, console.error, and console.warn statements from staging
- Generates commit messages using OpenAI's GPT-3.5 model
- Provides a beautiful UI for reviewing and editing commit messages
- Shows staged changes for review
- One-click commit approval

## Requirements

- VS Code 1.85.0 or higher
- Git installed and configured
- OpenAI API key

## Setup

1. Clone this repository
2. Run `npm install` to install dependencies
3. Configure your OpenAI API key in VS Code settings:
   - Open VS Code settings (Cmd+, on macOS or Ctrl+, on Windows/Linux)
   - Search for "Smart Commit"
   - Enter your OpenAI API key in the "OpenAI API Key" field
4. Press F5 in VS Code to start debugging the extension

## Usage

1. Make some changes to your code
2. Open the command palette (Cmd+Shift+P / Ctrl+Shift+P)
3. Type "Smart Commit: Create Commit" and press Enter
4. The extension will:
   - Filter out console.log statements
   - Stage the remaining changes
   - Generate a commit message using OpenAI
   - Show you a review panel
5. Review the commit message and staged changes
6. Click "Approve" to commit the changes

## Development

- `npm run compile` - Compile the extension
- `npm run watch` - Compile the extension and watch for changes
- `npm run lint` - Lint the code

## License

MIT 