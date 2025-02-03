import * as vscode from "vscode";
import OpenAI from "openai";
import { getWebviewContent } from "./webview/commitPanel";
import * as crypto from "crypto";
import { spawn } from "child_process";
import * as path from "path";

interface GitChange extends vscode.SourceControlResourceState {
  uri: vscode.Uri;
  type: vscode.FileChangeType;
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
  diff(options?: { cached?: boolean }): Promise<string>;
  diffWithHEAD(path: string): Promise<string>;
  add(paths: string[]): Promise<void>;
  apply(patch: string): Promise<void>;
  commit(message: string): Promise<void>;
  stage(path: string, data: string): Promise<void>;
}

let commitPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log("Smart Commit extension is now active");

  let disposable = vscode.commands.registerCommand(
    "smart-commit.createCommit",
    async () => {
      // Check for API key first
      const config = vscode.workspace.getConfiguration("smartCommit");
      const apiKey = config.get<string>("openaiApiKey");

      if (!apiKey) {
        const setKeyAction = "Set API Key";
        const result = await vscode.window.showErrorMessage(
          "OpenAI API key is not configured. Please set it in the extension settings.",
          setKeyAction
        );

        if (result === setKeyAction) {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "smartCommit.openaiApiKey"
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
        // Stage changes interactively, filtering console.logs during staging
        await stageFilteredChanges(repo);

        // Get staged changes diff for commit message and display
        const stagedDiff = await repo.diff({ cached: true });
        if (!stagedDiff) {
          vscode.window.showInformationMessage("No changes staged for commit");
          return;
        }

        // Parse diffs for the webview (only staged changes)
        const diffs = await parseStagedDiffs(repo);

        // Generate commit message using OpenAI
        const commitMessage = await generateCommitMessage(repo, apiKey);

        // Show commit panel
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

    // For deleted files, stage them directly
    if ((change as GitChange).type === vscode.FileChangeType.Deleted) {
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
  const lines = diff.split("\n");
  const filteredLines: string[] = [];
  let currentHunk: string[] = [];
  let oldLineCount = 0;
  let newLineCount = 0;
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
          // Adjust the new line count by subtracting skipped console.log lines
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
        if (
          codeLine.startsWith("console.log(") ||
          codeLine.startsWith("console.error(") ||
          codeLine.startsWith("console.warn(")
        ) {
          // Count skipped console.log lines
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
  const diffs = [];
  for (const change of repo.state.workingTreeChanges) {
    const fileDiff = await repo.diff({ cached: true });
    if (fileDiff) {
      diffs.push(
        parseDiff(
          fileDiff,
          change.resource.resourceUri.fsPath,
          (change.resource as GitChange).type
        )
      );
    }
  }
  return diffs;
}

async function generateCommitMessage(
  repo: GitRepository,
  apiKey: string
): Promise<string> {
  const openai = new OpenAI({ apiKey });

  try {
    const diff = await repo.diff({ cached: true });

    if (!diff) {
      return "feat: update codebase";
    }

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant that generates concise and descriptive git commit messages based on code changes. Follow conventional commits format.",
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
  command: "approve";
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
      "smartCommit",
      "Smart Commit",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    // Handle messages from the webview
    commitPanel.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        if (message.command === "approve") {
          const gitExtension =
            vscode.extensions.getExtension<GitAPI>("vscode.git");
          if (!gitExtension) return;

          const api = gitExtension.exports.getAPI(1);
          const repo = api.repositories[0];

          await repo.commit(message.commitMessage);
          commitPanel?.dispose();
          vscode.window.showInformationMessage(
            "Changes committed successfully!"
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

  // Generate a nonce for CSP
  const nonce = crypto.randomBytes(16).toString("base64");

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
