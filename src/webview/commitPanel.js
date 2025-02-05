class CommitPanel {
  constructor() {
    this.vscode = acquireVsCodeApi();
    this.initializeEventListeners();
  }

  initializeEventListeners() {
    // Handle collapse/expand
    document.querySelectorAll(".file-header").forEach((button) => {
      button.addEventListener("click", (e) => this.handleToggleDiff(e));
    });

    // Handle approve button
    document
      .getElementById("approveButton")
      .addEventListener("click", () => this.handleApprove());

    // Handle decline button
    document
      .getElementById("declineButton")
      .addEventListener("click", () => this.handleDecline());

    // Handle keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.metaKey) {
        // cmd key on Mac
        if (e.key === "Enter") {
          e.preventDefault();
          this.handleApprove();
        } else if (e.key === "Backspace") {
          e.preventDefault();
          this.handleDecline();
        }
      }
    });
  }

  handleToggleDiff(event) {
    event.stopPropagation();
    const fileDiv = event.target.closest(".file-diff");
    const content = fileDiv.querySelector(".diff-content");
    const button = fileDiv.querySelector(".collapse-button");

    const isExpanded = content.style.display !== "none";
    content.style.display = isExpanded ? "none" : "block";
    button.textContent = isExpanded ? "+" : "−";
  }

  handleApprove() {
    const commitMessage = document.getElementById("commitMessage").value;
    this.vscode.postMessage({
      command: "approve",
      commitMessage: commitMessage,
    });
  }

  handleDecline() {
    this.vscode.postMessage({ command: "decline" });
  }
}

// Initialize the panel when the document is ready
document.addEventListener("DOMContentLoaded", () => {
  new CommitPanel();
});
