# GitSmart VS Code Extension

Streamline your Git workflow with AI-powered smart staging, commit message generation, and enhanced code review outputs. GitSmart helps teams ship code faster by automating Git operations and improving code review quality.

## Features

- **Smart Staging**: Intelligently identifies and stages relevant changes while filtering out debug artifacts
  - Automatically filters console.log statements and other debug code
  - Groups related changes for more meaningful commits
  - Suggests optimal file groupings for atomic commits

- **AI-Powered Commit Messages**: 
  - Generates clear, descriptive commit messages using OpenAI
  - Follows commit message best practices
  - Includes relevant context and impact of changes

- **Enhanced Code Review Experience**:
  - Provides structured change summaries
  - Highlights key modifications and their implications
  - Generates helpful context for reviewers

- **Streamlined Workflow**:
  - Beautiful UI for reviewing and editing commit messages
  - One-click commit approval
  - Integrated change preview

## Requirements

- VS Code 1.85.0 or higher
- Git installed and configured
- OpenAI API key

## Setup

1. Install the extension from VS Code Marketplace
2. Configure your OpenAI API key in VS Code settings:
   - Open VS Code settings (Cmd+, on macOS or Ctrl+, on Windows/Linux)
   - Search for "GitSmart"
   - Enter your OpenAI API key in the "OpenAI API Key" field

## Usage

1. Make changes to your code
2. Open the command palette (Cmd+Shift+P / Ctrl+Shift+P)
3. Type "Smart Commit: Create Commit" and press Enter
4. The extension will:
   - Analyze your changes and suggest optimal groupings
   - Filter out debug artifacts
   - Stage the relevant changes
   - Generate a descriptive commit message
   - Show you a comprehensive review panel
5. Review the suggested changes and commit message
6. Click "Approve" to commit the changes

## Development

- `npm run compile` - Compile the extension
- `npm run watch` - Compile the extension and watch for changes
- `npm run lint` - Lint the code

## License

MIT

## Repository

https://github.com/arielpollack/vscode-gitsmart 