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
let outputChannel: vscode.OutputChannel;

async function getGitSmartConfig(): Promise<GitSmartConfig> {
  const config = vscode.workspace.getConfiguration("gitsmart");
  return {
    openaiApiKey: config.get<string>("openaiApiKey") || "",
    filterPatterns: config.get<string[]>("filterPatterns") || [
      "^\\s*console\\.(log|error|warn)\\(",
      "^\\s*debugger;",
    ],
    systemMessageEnhancement:
      config.get<string>("systemMessageEnhancement") || "",
  };
}

async function getGitRepository(): Promise<GitRepository | null> {
  const gitExtension = vscode.extensions.getExtension<GitAPI>("vscode.git");
  if (!gitExtension) {
    vscode.window.showErrorMessage("Git extension not found");
    return null;
  }

  const api = gitExtension.exports.getAPI(1);
  const repo = api.repositories[0];

  if (!repo) {
    vscode.window.showErrorMessage("No repository found");
    return null;
  }

  return repo;
}

async function handleSmartCommit(
  context: vscode.ExtensionContext,
  repo: GitRepository,
  settings: GitSmartConfig,
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<void> {
  progress.report({ message: "Analyzing and staging changes..." });
  await stageFilteredChanges(repo);

  const stagedDiff = await repo.diff(true);
  if (!stagedDiff) {
    vscode.window.showInformationMessage("No changes staged for commit");
    return;
  }

  progress.report({ message: "Processing diffs..." });
  const diffs = await parseStagedDiffs(repo);

  progress.report({ message: "Generating commit message..." });
  const commitMessage = await generateCommitMessage(
    repo,
    settings.openaiApiKey
  );

  progress.report({ message: "Opening commit panel..." });
  showCommitPanel(context, commitMessage, diffs);
}

export function activate(context: vscode.ExtensionContext) {

  // Create output channel
  outputChannel = vscode.window.createOutputChannel("GitSmart");
  context.subscriptions.push(outputChannel);

  let disposable = vscode.commands.registerCommand(
    "gitsmart.stageChanges",
    async () => {
      const settings = await getGitSmartConfig();
      const repo = await getGitRepository();

      if (!repo) return;

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "GitSmart",
            cancellable: false,
          },
          async (progress) => {
            await handleSmartCommit(context, repo, settings, progress);
          }
        );
      } catch (error: any) {
        console.error("Error:", error);
        vscode.window.showErrorMessage(`Error: ${error.message}`);
      }
    }
  );

  context.subscriptions.push(disposable);
}

async function isTextFile(uri: vscode.Uri): Promise<boolean> {
  try {
    // First check if VSCode recognizes it as a text document
    const languageId =
      vscode.window.activeTextEditor?.document.languageId ||
      vscode.workspace.textDocuments.find(
        (doc) => doc.uri.toString() === uri.toString()
      )?.languageId;

    if (languageId) {
      return true;
    }

    // If the file isn't open, try to detect based on file content
    const buffer = await vscode.workspace.fs.readFile(uri);

    // Try to decode the first chunk of the file as UTF-8
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      decoder.decode(buffer.slice(0, 8192)); // Check first 8KB
      return true;
    } catch {
      return false;
    }
  } catch (error) {
    console.error(`Error checking if ${uri.fsPath} is a text file:`, error);
    return false;
  }
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
    const isText = await isTextFile(uri);
    if ([6, 7].includes((change as GitChange).type) || !isText) {
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

        let stderr = "";
        apply.stderr.on("data", (data) => {
          stderr += data.toString();
        });

        apply.on("error", (err) => {
          const errorMsg = `Git apply spawn error: ${err.message}`;
          outputChannel.appendLine(errorMsg);
          outputChannel.show(true); // Show output panel
          vscode.window.showErrorMessage(`Git apply error: ${err.message}`);
          reject(err);
        });

        apply.on("exit", (code) => {
          if (code === 0) {
            resolve();
          } else {
            const errorMsg = `Git apply failed with code ${code}${
              stderr ? `: ${stderr}` : ""
            }`;
            outputChannel.appendLine("=== Git Apply Error ===");
            outputChannel.appendLine(errorMsg);
            outputChannel.appendLine("\n=== Patch Content ===");
            outputChannel.appendLine(filteredPatch);
            outputChannel.appendLine("\n=== End Patch Content ===");
            outputChannel.show(true); // Show output panel
            vscode.window.showErrorMessage(errorMsg);
            reject(
              new Error("Git apply failed, check output panel for more details")
            );
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
  // Use regex with lookahead to ensure we only match actual diff headers
  const diffSplitRegex = /(?=^diff --git a\/(.*?) b\/(.*?)$)/m;
  const fileDiffs = stagedDiff
    .split(diffSplitRegex)
    .filter((str) => str.trim());

  const diffs = [];
  for (const fileDiff of fileDiffs) {
    const match = diffSplitRegex.exec(fileDiff);
    if (match) {
      const filePath = match[2]; // Use the 'b' path as it represents the new file
      const fullFilePath = path.join(
        vscode.workspace.workspaceFolders?.[0].uri.fsPath || "",
        filePath
      );
      diffs.push(
        parseDiff(fileDiff, fullFilePath, getFileChangeType(fileDiff))
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
  const diff = await repo.diff(true);
  if (!diff) {
    return "feat: update codebase";
  }

  // Try VS Code's built-in language model first
  try {
    const [model] = await vscode.lm.selectChatModels({ family: "gpt-4o" });

    if (model) {
      const config = vscode.workspace.getConfiguration("gitsmart");
      const baseSystemMessage =
        "You are a helpful assistant that generates concise and descriptive git commit messages based on code changes. Follow conventional commits format. Return ONLY the commit message without any markdown formatting.";
      const enhancement = config.get<string>("systemMessageEnhancement") || "";
      const systemMessage = enhancement
        ? `${baseSystemMessage}\n\n${enhancement}`
        : baseSystemMessage;

      const messages = [
        vscode.LanguageModelChatMessage.User(systemMessage),
        vscode.LanguageModelChatMessage.User(
          `Generate a commit message for the following changes:\n\n${diff}`
        ),
      ];

      const response = await model.sendRequest(
        messages,
        {},
        new vscode.CancellationTokenSource().token
      );
      let commitMessage = "";

      // Collect the streaming response
      for await (const fragment of response.text) {
        commitMessage += fragment;
      }

      // Remove any markdown formatting (like backticks)
      commitMessage = commitMessage.replace(/`/g, "").trim();
      return commitMessage || "feat: update codebase";
    }
  } catch (err) {
    if (err instanceof vscode.LanguageModelError) {
      console.log("VS Code Language Model error:", err.message, err.code);
    } else {
      console.log("Error using VS Code Language Model:", err);
    }
  }

  // Check OpenAI API key only when falling back to OpenAI
  if (!apiKey) {
    const setKeyAction = "Set API Key";
    const result = await vscode.window.showErrorMessage(
      "VS Code language models are not available and OpenAI API key is not configured. Please set it in the extension settings.",
      setKeyAction
    );

    if (result === setKeyAction) {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "gitsmart.openaiApiKey"
      );
    }
    return "feat: update codebase";
  }

  // Fallback to OpenAI
  try {
    const openai = new OpenAI({ apiKey });
    const config = vscode.workspace.getConfiguration("gitsmart");
    const baseSystemMessage =
      "You are a helpful assistant that generates concise and descriptive git commit messages based on code changes. Follow conventional commits format.";
    const enhancement = config.get<string>("systemMessageEnhancement") || "";
    const systemMessage = enhancement
      ? `${baseSystemMessage}\n\n${enhancement}`
      : baseSystemMessage;

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

async function handleApproveCommand(
  repo: GitRepository,
  message: WebviewMessage
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "GitSmart",
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Committing changes..." });
      await repo.commit(message.commitMessage);
      commitPanel?.dispose();
      vscode.window.showInformationMessage("Changes committed successfully!");
    }
  );
}

async function handleDeclineCommand(): Promise<void> {
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
  vscode.window.showInformationMessage("Changes unstaged successfully!");
}

async function handleWebviewMessage(message: WebviewMessage): Promise<void> {
  const gitExtension = vscode.extensions.getExtension<GitAPI>("vscode.git");
  if (!gitExtension) return;

  const api = gitExtension.exports.getAPI(1);
  const repo = api.repositories[0];

  if (message.command === "approve") {
    await handleApproveCommand(repo, message);
  } else if (message.command === "decline") {
    await handleDeclineCommand();
  }
}

function createCommitPanel(
  context: vscode.ExtensionContext
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "gitsmart",
    "GitSmart",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  panel.webview.onDidReceiveMessage(
    handleWebviewMessage,
    undefined,
    context.subscriptions
  );

  panel.onDidDispose(
    () => {
      commitPanel = undefined;
    },
    null,
    context.subscriptions
  );

  return panel;
}

function showCommitPanel(
  context: vscode.ExtensionContext,
  commitMessage: string,
  diffs: any[]
): void {
  if (commitPanel) {
    commitPanel.reveal(vscode.ViewColumn.One);
  } else {
    commitPanel = createCommitPanel(context);
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
  // Check if it's a binary file
  if (diff.includes("Binary files") || diff.includes("GIT binary patch")) {
    return {
      filePath,
      type,
      hunks: [],
      isBinary: true,
    };
  }

  const hunks = [];
  const lines = diff.split("\n");
  let currentHunk: any = null;
  let currentLineNumber = 0;

  for (const line of lines) {
    // Skip file header lines but preserve the diff header
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file")
    ) {
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

    // Only process the line if it's a valid diff line
    if (line.startsWith("+")) {
      currentHunk.lines.push({
        type: "added",
        content: line,
        lineNumber: currentLineNumber++,
      });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({
        type: "removed",
        content: line,
        lineNumber: currentLineNumber, // Don't increment for removed lines
      });
    } else if (!line.startsWith("\\")) {
      // Skip "\ No newline at end of file" markers
      // Handle context lines (those starting with a space)
      currentHunk.lines.push({
        type: "context",
        content: line,
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
