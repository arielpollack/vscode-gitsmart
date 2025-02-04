import * as vscode from "vscode";
import OpenAI from "openai";
import { getWebviewContent } from "./webview/commitPanel";
import { spawn } from "child_process";
import * as path from "path";

interface GitChange extends vscode.SourceControlResourceState {
  uri: vscode.Uri;
  type: number;
  linesToStage: number[] | "all";
}

interface GitAPI {
  repositories: GitRepository[];
  getAPI(version: number): GitAPI;
}

interface GitRepository {
  state: {
    workingTreeChanges: { resource: vscode.SourceControlResourceState }[];
  };
  diff(cached?: boolean): Promise<string>;
  diffWithHEAD(path: string): Promise<string>;
  add(paths: string[]): Promise<void>;
  apply(patch: string): Promise<void>;
  commit(message: string): Promise<void>;
  stage(path: string, data: string): Promise<void>;
}

interface GitSmartConfig {
  openaiApiKey: string;
  filterPatterns: string[];
  systemMessageEnhancement: string;
}

let commitPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log("GitSmart extension is now active");

  let disposable = vscode.commands.registerCommand(
    "gitsmart.stageChanges",
    async () => {
      // Update config retrieval
      const config = vscode.workspace.getConfiguration("gitsmart");
      const settings: GitSmartConfig = {
        openaiApiKey: config.get<string>("openaiApiKey") || "",
        filterPatterns: config.get<string[]>("filterPatterns") || [
          "^\\s*console\\.(log|error|warn)\\(",
          "^\\s*debugger;",
        ],
        systemMessageEnhancement:
          config.get<string>("systemMessageEnhancement") || "",
      };

      if (!settings.openaiApiKey) {
        const setKeyAction = "Set API Key";
        const result = await vscode.window.showErrorMessage(
          "OpenAI API key is not configured. Please set it in the extension settings.",
          setKeyAction
        );

        if (result === setKeyAction) {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "gitsmart.openaiApiKey"
          );
        }
        return;
      }

      const gitExtension = vscode.extensions.getExtension<GitAPI>("vscode.git");
      if (!gitExtension) {
        vscode.window.showErrorMessage("Git extension not found");
        return;
      }

      const api = gitExtension.exports.getAPI(1);
      const repo = api.repositories[0];

      if (!repo) {
        vscode.window.showErrorMessage("No repository found");
        return;
      }

      try {
        await stageFilteredChanges(repo);

        const stagedDiff = await repo.diff(true);
        if (!stagedDiff) {
          vscode.window.showInformationMessage("No changes staged for commit");
          return;
        }

        const diffs = await parseStagedDiffs(repo);
        const commitMessage = await generateCommitMessage(
          repo,
          settings.openaiApiKey
        );

        showCommitPanel(context, commitMessage, diffs);
      } catch (error: any) {
        console.error("Error:", error);
        vscode.window.showErrorMessage(`Error: ${error.message}`);
      }
    }
  );

  context.subscriptions.push(disposable);
}

async function stageFilteredChanges(repo: GitRepository): Promise<void> {
  const changes = repo.state.workingTreeChanges.map(
    (change) => change.resource
  );

  for (const change of changes) {
    if (!change.resourceUri) continue;
    const uri = change.resourceUri;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (!workspaceFolder) continue;

    // For deleted or added files, stage them directly
    // 6 => deleted, 7 => untracked
    if ([6, 7].includes((change as GitChange).type)) {
      await repo.add([uri.fsPath]);
      continue;
    }

    // Get the diff for the current file
    const diff = await repo.diffWithHEAD(uri.fsPath);
    if (!diff) continue;

    // Create filtered patch content
    const filteredPatch = createFilteredPatch(diff, uri.fsPath);

    // Create temporary patch file
    const tempPatchPath = path.join(
      workspaceFolder,
      `.temp-${Date.now()}.patch`
    );
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(tempPatchPath),
      Buffer.from(filteredPatch)
    );

    try {
      // Apply the patch directly to the index using git apply --cached
      await new Promise<void>((resolve, reject) => {
        const apply = spawn("git", ["apply", "--cached", tempPatchPath], {
          cwd: workspaceFolder,
        });

        apply.on("error", reject);
        apply.on("exit", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`git apply failed with code ${code}`));
          }
        });
      });
    } catch (error) {
      throw error;
    } finally {
      // Clean up temp patch file
      await vscode.workspace.fs.delete(vscode.Uri.file(tempPatchPath));
    }
  }
}

function createFilteredPatch(diff: string, filePath: string): string {
  const config = vscode.workspace.getConfiguration("gitsmart");
  const patterns = config.get<string[]>("filterPatterns") || [
    "^\\s*console\\.(log|error|warn)\\(",
    "^\\s*debugger;",
  ];

  const filterRegexes = patterns.map((pattern) => new RegExp(pattern));

  const lines = diff.split("\n");
  const filteredLines: string[] = [];
  let currentHunk: string[] = [];
  let skippedLines = 0;

  for (const line of lines) {
    // Keep file headers
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      filteredLines.push(line);
      continue;
    }

    // Start of a new hunk
    if (line.startsWith("@@")) {
      // Process previous hunk if it exists
      if (currentHunk.length > 0) {
        const headerMatch = currentHunk[0].match(
          /@@ -(\d+),(\d+) \+(\d+),(\d+) @@/
        );
        if (headerMatch) {
          const oldStart = parseInt(headerMatch[1]);
          const newStart = parseInt(headerMatch[3]);
          const newFinalCount = parseInt(headerMatch[4]) - skippedLines;
          currentHunk[0] = `@@ -${oldStart},${headerMatch[2]} +${newStart},${newFinalCount} @@`;
        }
        filteredLines.push(...currentHunk);
      }

      // Reset counters for new hunk
      currentHunk = [line];
      skippedLines = 0;
      continue;
    }

    // Process line in current hunk
    if (currentHunk.length > 0) {
      if (line.startsWith("+")) {
        const codeLine = line.substring(1).trim();
        // Check if line matches any of the filter patterns
        const shouldFilter = filterRegexes.some((regex) =>
          regex.test(codeLine)
        );

        if (shouldFilter) {
          skippedLines++;
          continue;
        } else {
          currentHunk.push(line);
        }
      } else {
        currentHunk.push(line);
      }
    }
  }

  // Process the last hunk
  if (currentHunk.length > 0) {
    const headerMatch = currentHunk[0].match(
      /@@ -(\d+),(\d+) \+(\d+),(\d+) @@/
    );
    if (headerMatch) {
      const oldStart = parseInt(headerMatch[1]);
      const newStart = parseInt(headerMatch[3]);
      const newFinalCount = parseInt(headerMatch[4]) - skippedLines;
      currentHunk[0] = `@@ -${oldStart},${headerMatch[2]} +${newStart},${newFinalCount} @@`;
    }
    filteredLines.push(...currentHunk);
  }

  return filteredLines.join("\n");
}

async function parseStagedDiffs(repo: GitRepository) {
  // Get all staged changes at once
  const stagedDiff = await repo.diff(true);
  if (!stagedDiff) {
    return [];
  }

  // Split the diff by file
  const fileRegex = /^diff --git a\/(.*?) b\/(.*?)$/m;
  const fileDiffs = stagedDiff.split("diff --git").filter(Boolean);

  const diffs = [];
  for (const fileDiff of fileDiffs) {
    const fullDiff = "diff --git" + fileDiff;
    const match = fileRegex.exec(fullDiff);
    if (match) {
      const filePath = match[2]; // Use the 'b' path as it represents the new file
      const fullFilePath = path.join(
        vscode.workspace.workspaceFolders?.[0].uri.fsPath || "",
        filePath
      );
      diffs.push(
        parseDiff(fullDiff, fullFilePath, getFileChangeType(fullDiff))
      );
    }
  }

  return diffs;
}

// Helper function to determine file change type
function getFileChangeType(diff: string): number {
  if (diff.includes("new file mode")) {
    return 7; // Untracked/new file
  } else if (diff.includes("deleted file mode")) {
    return 6; // Deleted file
  }
  return 1; // Modified file
}

async function generateCommitMessage(
  repo: GitRepository,
  apiKey: string
): Promise<string> {
  const openai = new OpenAI({ apiKey });
  const config = vscode.workspace.getConfiguration("gitsmart");
  const baseSystemMessage =
    "You are a helpful assistant that generates concise and descriptive git commit messages based on code changes. Follow conventional commits format.";
  const enhancement = config.get<string>("systemMessageEnhancement") || "";
  const systemMessage = enhancement
    ? `${baseSystemMessage}\n\n${enhancement}`
    : baseSystemMessage;

  try {
    const diff = await repo.diff(true);

    if (!diff) {
      return "feat: update codebase";
    }

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: systemMessage,
        },
        {
          role: "user",
          content: `Generate a commit message for the following changes:\n\n${diff}`,
        },
      ],
    });

    return response.choices[0].message.content || "feat: update codebase";
  } catch (error: any) {
    if (error.response?.status === 401) {
      throw new Error("Invalid OpenAI API key. Please check your settings.");
    }
    throw new Error(`Failed to generate commit message: ${error.message}`);
  }
}

interface WebviewMessage {
  command: "approve" | "decline";
  commitMessage: string;
}

function showCommitPanel(
  context: vscode.ExtensionContext,
  commitMessage: string,
  diffs: any[]
): void {
  if (commitPanel) {
    commitPanel.reveal(vscode.ViewColumn.One);
  } else {
    commitPanel = vscode.window.createWebviewPanel(
      "gitsmart",
      "GitSmart",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    // Handle messages from the webview
    commitPanel.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        const gitExtension =
          vscode.extensions.getExtension<GitAPI>("vscode.git");
        if (!gitExtension) return;

        const api = gitExtension.exports.getAPI(1);
        const repo = api.repositories[0];

        if (message.command === "approve") {
          await repo.commit(message.commitMessage);
          commitPanel?.dispose();
          vscode.window.showInformationMessage(
            "Changes committed successfully!"
          );
        } else if (message.command === "decline") {
          // Reset the index (unstage all changes)
          await new Promise<void>((resolve, reject) => {
            const git = spawn("git", ["reset"], {
              cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath,
            });

            git.on("error", reject);
            git.on("exit", (code) => {
              if (code === 0) {
                resolve();
              } else {
                reject(new Error(`git reset failed with code ${code}`));
              }
            });
          });

          commitPanel?.dispose();
          vscode.window.showInformationMessage(
            "Changes unstaged successfully!"
          );
        }
      },
      undefined,
      context.subscriptions
    );

    commitPanel.onDidDispose(
      () => {
        commitPanel = undefined;
      },
      null,
      context.subscriptions
    );
  }

  const content = getWebviewContent(
    commitPanel,
    commitMessage,
    diffs,
    context.extensionUri
  );
  commitPanel.webview.html = content;
}

function parseDiff(
  diff: string,
  filePath: string,
  type: vscode.FileChangeType
) {
  const hunks = [];
  const lines = diff.split("\n");
  let currentHunk: any = null;
  let currentLineNumber = 0;

  for (const line of lines) {
    // Skip file header lines
    if (line.startsWith("---") || line.startsWith("+++")) {
      continue;
    }

    if (line.startsWith("@@")) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      // Parse the hunk header to get the starting line number
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      currentLineNumber = match ? parseInt(match[1], 10) : 0;

      currentHunk = {
        header: line,
        lines: [],
      };
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({
        type: "added",
        content: line.substring(1),
        lineNumber: currentLineNumber++,
      });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({
        type: "removed",
        content: line.substring(1),
        lineNumber: currentLineNumber, // Don't increment for removed lines
      });
    } else if (!line.startsWith("\\")) {
      currentHunk.lines.push({
        type: "context",
        content: line.substring(1), // Remove the space at the start of context lines
        lineNumber: currentLineNumber++,
      });
    }
  }

  if (currentHunk && currentHunk.lines.length > 0) {
    hunks.push(currentHunk);
  }

  return {
    filePath,
    type,
    hunks,
  };
}

export function deactivate() {}
