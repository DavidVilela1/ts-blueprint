/**
 * TSBlueprint — Extension Host entrypoint.
 *
 * PHASE 1 STUB. Phase 2 will implement:
 *  - BlueprintPanel (singleton WebviewPanel) with strict CSP + nonce
 *  - 300 ms debounced `workspace.onDidChangeTextDocument` listener
 *  - `window.onDidChangeActiveTextEditor` tracking
 *  - Disposal of every listener when the panel closes (vscode.Disposable)
 */
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('tsblueprint.openPreview', () => {
      void vscode.window.showInformationMessage('TSBlueprint: preview panel arrives in phase 2.');
    }),
  );
}

export function deactivate(): void {
  // All disposables are registered on context.subscriptions.
}
