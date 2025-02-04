class CommitPanel {
  constructor() {
    this.vscode = acquireVsCodeApi();
    this.initializeEventListeners();
  }

  initializeEventListeners() {
    // Handle collapse/expand
    document.querySelectorAll(".collapse-button").forEach((button) => {
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
  }

  handleToggleDiff(event) {
    event.stopPropagation();
    const fileDiv = event.target.closest(".file-diff");
    const content = fileDiv.querySelector(".diff-content");
    const button = event.target;

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
