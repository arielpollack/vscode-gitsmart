import * as vscode from "vscode";

interface DiffLine {
  type: "added" | "removed" | "context";
  content: string;
  lineNumber: number;
}

interface FileDiff {
  filePath: string;
  oldPath?: string;
  newPath?: string;
  hunks: {
    header: string;
    lines: DiffLine[];
  }[];
  type: vscode.FileChangeType;
}

export function getWebviewContent(
  commitMessage: string,
  diffs: FileDiff[],
  nonce: string
): string {
  return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
        <title>Smart Commit</title>
        <style nonce="${nonce}">
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
                padding: 20px;
                color: var(--vscode-foreground);
                background-color: var(--vscode-editor-background);
                line-height: 1.5;
            }
            textarea {
                width: 100%;
                height: 100px;
                margin: 10px 0;
                padding: 8px;
                background-color: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border);
                font-family: var(--vscode-editor-font-family);
                font-size: var(--vscode-editor-font-size);
            }
            .changes {
                margin: 20px 0;
            }
            .file-diff {
                margin: 10px 0;
                border: 1px solid var(--vscode-panel-border);
                border-radius: 6px;
                overflow: hidden;
            }
            .file-header {
                padding: 8px 16px;
                background-color: var(--vscode-sideBar-background);
                border-bottom: 1px solid var(--vscode-panel-border);
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            .file-header:hover {
                background-color: var(--vscode-list-hoverBackground);
            }
            .file-path {
                font-weight: 600;
            }
            .diff-stats {
                color: var(--vscode-descriptionForeground);
            }
            .diff-content {
                font-family: var(--vscode-editor-font-family);
                font-size: var(--vscode-editor-font-size);
                tab-size: 4;
                overflow-x: auto;
            }
            .diff-line {
                display: flex;
                min-width: fit-content;
            }
            .line-number {
                color: var(--vscode-editorLineNumber-foreground);
                text-align: right;
                padding: 0 8px;
                min-width: 50px;
                user-select: none;
                border-right: 1px solid var(--vscode-panel-border);
            }
            .line-content {
                padding: 0 8px;
                white-space: pre;
            }
            .line-added {
                background-color: var(--vscode-diffEditor-insertedLineBackground);
            }
            .line-added .line-content {
                color: var(--vscode-diffEditor-insertedTextColor);
            }
            .line-removed {
                background-color: var(--vscode-diffEditor-removedLineBackground);
            }
            .line-removed .line-content {
                color: var(--vscode-diffEditor-removedTextColor);
            }
            .collapse-button {
                padding: 2px 6px;
                background: transparent;
                border: 1px solid var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                cursor: pointer;
                border-radius: 3px;
            }
            .collapse-button:hover {
                background-color: var(--vscode-button-hoverBackground);
            }
            .commit-button {
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 10px 20px;
                cursor: pointer;
                font-size: 14px;
                border-radius: 4px;
                margin-top: 20px;
            }
            .commit-button:hover {
                background-color: var(--vscode-button-hoverBackground);
            }
            .hunk-header {
                color: var(--vscode-descriptionForeground);
                background-color: var(--vscode-sideBar-background);
                padding: 4px 8px;
                font-style: italic;
            }
        </style>
    </head>
    <body>
        <h2>Commit Message</h2>
        <textarea id="commitMessage">${escapeHtml(commitMessage)}</textarea>
        
        <h2>Changes to be Committed</h2>
        <div class="changes">
            ${generateDiffHtml(diffs)}
        </div>
        
        <button class="commit-button" onclick="approve()">Approve and Commit</button>

        <script nonce="${nonce}">
            const vscode = acquireVsCodeApi();
            
            function toggleDiff(fileId) {
                const content = document.getElementById('diff-content-' + fileId);
                const button = document.getElementById('collapse-button-' + fileId);
                if (content.style.display === 'none') {
                    content.style.display = 'block';
                    button.textContent = '−';
                } else {
                    content.style.display = 'none';
                    button.textContent = '+';
                }
            }
            
            function approve() {
                const commitMessage = document.getElementById('commitMessage').value;
                vscode.postMessage({
                    command: 'approve',
                    commitMessage: commitMessage
                });
            }
        </script>
    </body>
    </html>`;
}

function generateDiffHtml(diffs: FileDiff[]): string {
  return diffs
    .map((diff, index) => {
      const fileChangeText = getFileChangeText(diff.type);
      const diffStats = getDiffStats(diff);

      return `
        <div class="file-diff">
            <div class="file-header" onclick="toggleDiff(${index})">
                <div class="file-path">
                    <button class="collapse-button" id="collapse-button-${index}">−</button>
                    ${fileChangeText} ${escapeHtml(diff.filePath)}
                </div>
                <div class="diff-stats">${diffStats}</div>
            </div>
            <div class="diff-content" id="diff-content-${index}">
                ${diff.hunks
                  .map(
                    (hunk) => `
                    <div class="hunk-header">${escapeHtml(hunk.header)}</div>
                    ${hunk.lines
                      .map((line) => {
                        const prefix =
                          line.type === "added"
                            ? "+"
                            : line.type === "removed"
                            ? "-"
                            : " ";
                        const lineClass =
                          line.type === "added"
                            ? "line-added"
                            : line.type === "removed"
                            ? "line-removed"
                            : "";
                        return `
                        <div class="diff-line ${lineClass}">
                            <span class="line-number">${line.lineNumber}</span>
                            <span class="line-content">${prefix}${escapeHtml(
                          line.content
                        )}</span>
                        </div>`;
                      })
                      .join("")}
                `
                  )
                  .join("")}
            </div>
        </div>`;
    })
    .join("");
}

function getFileChangeText(type: vscode.FileChangeType): string {
  switch (type) {
    case vscode.FileChangeType.Changed:
      return "Modified:";
    case vscode.FileChangeType.Deleted:
      return "Deleted:";
    case vscode.FileChangeType.Created:
      return "Added:";
    default:
      return "Changed:";
  }
}

function getDiffStats(diff: FileDiff): string {
  let additions = 0;
  let deletions = 0;

  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "added") additions++;
      if (line.type === "removed") deletions++;
    }
  }

  const stats = [];
  if (additions > 0) stats.push(`+${additions}`);
  if (deletions > 0) stats.push(`−${deletions}`);
  return stats.join(" ");
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
