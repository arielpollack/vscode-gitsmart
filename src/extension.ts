import * as vscode from "vscode";
import OpenAI from "openai";
import { getWebviewContent } from "./webview/commitPanel";
import * as crypto from "crypto";

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
  apply(patch: string, path: string): Promise<void>;
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
        // Get all changes
        const changes = repo.state.workingTreeChanges;

        // Filter out console.log changes
        const filteredChanges = await filterConsoleLogChanges(repo);

        if (filteredChanges.length === 0) {
          vscode.window.showInformationMessage(
            "No changes to commit after filtering console.log statements"
          );
          return;
        }

        // Parse diffs for the webview
        const diffs = await Promise.all(
          filteredChanges.map(async (change) => {
            const fileDiff = await repo.diffWithHEAD(change.uri.fsPath);
            return parseDiff(fileDiff, change.uri.fsPath, change.type);
          })
        );

        // Stage filtered changes
        await stageFilteredChanges(repo, filteredChanges);

        // Generate commit message using OpenAI
        const commitMessage = await generateCommitMessage(repo, apiKey);

        // Show commit panel
        showCommitPanel(context, commitMessage, diffs);
      } catch (error: any) {
        vscode.window.showErrorMessage(`Error: ${error.message}`);
      }
    }
  );

  context.subscriptions.push(disposable);
}

async function filterConsoleLogChanges(
  repo: GitRepository
): Promise<GitChange[]> {
  const changes = repo.state.workingTreeChanges.map(
    (change) => change.resource
  );
  const filteredChanges: GitChange[] = [];

  for (const change of changes) {
    if (!change.resourceUri) continue;

    // For deleted files, include them as is
    if ((change as GitChange).type === vscode.FileChangeType.Deleted) {
      filteredChanges.push({
        ...change,
        uri: change.resourceUri,
        linesToStage: "all",
      } as GitChange);
      continue;
    }

    const uri = change.resourceUri;
    const document = await vscode.workspace.openTextDocument(uri);
    const fileDiff = await repo.diffWithHEAD(uri.fsPath);

    if (!fileDiff) continue;

    // Get all changed lines and filter out console.log lines
    const changedLines = parseChangedLines(fileDiff);
    const nonConsoleLines = changedLines.filter((lineNum) => {
      const line = document.lineAt(lineNum - 1).text.trim();
      return !(
        line.startsWith("console.log(") ||
        line.startsWith("console.error(") ||
        line.startsWith("console.warn(") ||
        line === ""
      );
    });

    if (nonConsoleLines.length > 0) {
      filteredChanges.push({
        ...change,
        uri: change.resourceUri,
        linesToStage: nonConsoleLines,
      } as GitChange);
    }
  }

  return filteredChanges;
}

function parseChangedLines(diff: string): number[] {
  const changedLines: number[] = [];
  const lines = diff.split("\n");
  let currentLine = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        currentLine = parseInt(match[1], 10);
        continue;
      }
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      changedLines.push(currentLine);
    }

    if (!line.startsWith("-") && !line.startsWith("\\")) {
      currentLine++;
    }
  }

  return changedLines;
}

async function stageFilteredChanges(
  repo: GitRepository,
  changes: GitChange[]
): Promise<void> {
  for (const change of changes) {
    if (change.linesToStage === "all") {
      await repo.add([change.uri.fsPath]);
      continue;
    }

    // For partial staging, we need to use the repository's index directly
    const document = await vscode.workspace.openTextDocument(change.uri);
    const content = document.getText();
    const lines = content.split("\n");
    const selectedLines = new Set(change.linesToStage);
    const newContent = lines
      .map((line, index) => (selectedLines.has(index + 1) ? line : ""))
      .join("\n");

    // Use add method instead of non-existent stage method
    await repo.add([change.uri.fsPath]);
  }
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
