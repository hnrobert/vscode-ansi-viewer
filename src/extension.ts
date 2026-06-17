import {
  ExtensionContext,
  CancellationTokenSource,
  workspace,
  commands,
  window,
  ViewColumn,
  TextDocumentShowOptions,
  TextDocument,
  languages,
  StatusBarItem,
  StatusBarAlignment,
} from "vscode";
import * as micromatch from "micromatch";

import { AnsiDecorationProvider } from "./AnsiDecorationProvider";
import { EditorRedrawWatcher } from "./EditorRedrawWatcher";
import { AnsiContentPreviewProvider } from "./AnsiContentPreviewProvider";
import {
  executeRegisteredTextEditorDecorationProviders,
  registerTextEditorDecorationProvider,
  clearRegisteredTextEditorDecorationProviders,
} from "./TextEditorDecorationProvider";

export const extensionId = "HNRobert.ansi-viewer" as const;

// Global status bar item
let statusBarItem: StatusBarItem;

/**
 * Checks whether the ANSI Viewer extension is enabled.
 */
function isAnsiViewerEnabled(): boolean {
  const config = workspace.getConfiguration("ansiViewer");
  return config.get("enable", true);
}

/**
 * Updates the status bar display.
 */
function updateStatusBar(enabled: boolean): void {
  statusBarItem.text = enabled ? "$(check) ANSI" : "$(x) ANSI";
  statusBarItem.tooltip = `ANSI Viewer: ${enabled ? "Enabled" : "Disabled"}`;
  statusBarItem.show();
}

/**
 * Checks whether a file should be automatically set to the ANSI language mode.
 */
function shouldSetAnsiLanguageMode(document: TextDocument): boolean {
  // First, check whether the extension is enabled
  if (!isAnsiViewerEnabled()) {
    return false;
  }

  const config = workspace.getConfiguration("ansiViewer");
  const autoLanguageModeFiles: string[] = config.get("autoLanguageModeFiles", ["**/*.ans", "**/*.ansi"]);

  // console.log(`[ANSI Extension] Checking file: ${document.fileName}`);
  // console.log(`[ANSI Extension] Config patterns:`, autoLanguageModeFiles);
  // console.log(`[ANSI Extension] Current language ID: ${document.languageId}`);

  if (autoLanguageModeFiles.length === 0) {
    // console.log(`[ANSI Extension] No patterns configured, skipping`);
    return false;
  }

  // Get the file's relative path and filename
  const filePath = document.fileName;
  const workspaceFolder = workspace.getWorkspaceFolder(document.uri);

  let relativePath = filePath;
  const fileName = filePath.split(/[/\\]/).pop() || "";

  if (workspaceFolder) {
    relativePath = filePath.replace(workspaceFolder.uri.fsPath, "").replace(/^[/\\]/, "");
    // Convert Windows path separators to Unix style
    relativePath = relativePath.replace(/\\/g, "/");
  }

  // console.log(`[ANSI Extension] File name: ${fileName}`);
  // console.log(`[ANSI Extension] Relative path: ${relativePath}`);

  const shouldSet = autoLanguageModeFiles.some((pattern: string) => {
    // Normalize pattern: convert Windows path separators to Unix style
    const normalizedPattern = pattern.replace(/\\/g, "/");

    // console.log(`[ANSI Extension] Testing pattern: ${normalizedPattern}`);

    // If the pattern has no path separator, match both the filename and the full path
    if (!normalizedPattern.includes("/")) {
      // For patterns without a path (e.g. "*.log"), match the filename and the relative path
      const fileNameMatch = micromatch.isMatch(fileName, normalizedPattern);
      const relativePathMatch = micromatch.isMatch(relativePath, normalizedPattern);
      const expandedMatch = micromatch.isMatch(relativePath, `**/${normalizedPattern}`);

      // console.log(
      //   `[ANSI Extension] Pattern ${normalizedPattern} - fileName match: ${fileNameMatch}, relativePath match: ${relativePathMatch}, expanded match: ${expandedMatch}`,
      // );

      return fileNameMatch || relativePathMatch || expandedMatch;
    } else {
      // For patterns that include a path, match the relative path directly
      const match = micromatch.isMatch(relativePath, normalizedPattern);
      // console.log(`[ANSI Extension] Pattern ${normalizedPattern} - path match: ${match}`);
      return match;
    }
  });

  // console.log(`[ANSI Extension] Should set ANSI language mode: ${shouldSet}`);
  return shouldSet;
}

/**
 * Sets the ANSI language mode for a document.
 */
async function setAnsiLanguageMode(document: TextDocument, context: string): Promise<void> {
  if (document.languageId === "ansi") {
    // console.log(`[ANSI Extension] Document ${document.fileName} is already in ANSI mode`);
    return;
  }

  // console.log(`[ANSI Extension] Setting language mode to ANSI for ${context}: ${document.fileName}`);
  try {
    await languages.setTextDocumentLanguage(document, "ansi");
    // console.log(`[ANSI Extension] Successfully set language mode to ANSI for ${context}`);
  } catch (error) {
    // console.error(`[ANSI Extension] Error setting language mode for ${context}:`, error);
  }
}

export async function activate(context: ExtensionContext): Promise<void> {
  // console.log(`[ANSI Extension] Extension activated`);

  // Create status bar item
  statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 100.1);
  statusBarItem.command = `${extensionId}.toggleEnable`;
  context.subscriptions.push(statusBarItem);

  // Initialize status bar
  updateStatusBar(isAnsiViewerEnabled());

  const editorRedrawWatcher = new EditorRedrawWatcher();
  context.subscriptions.push(editorRedrawWatcher);

  const ansiContentPreviewProvider = new AnsiContentPreviewProvider(editorRedrawWatcher);
  context.subscriptions.push(ansiContentPreviewProvider);

  context.subscriptions.push(
    workspace.registerTextDocumentContentProvider(AnsiContentPreviewProvider.scheme, ansiContentPreviewProvider),
  );

  const showPreview = async (options?: TextDocumentShowOptions) => {
    const actualUri = window.activeTextEditor?.document.uri;

    if (!actualUri) {
      return;
    }

    const providerUri = AnsiContentPreviewProvider.toProviderUri(actualUri);

    await window.showTextDocument(providerUri, options);
  };

  context.subscriptions.push(
    commands.registerCommand(`${extensionId}.showPreview`, () => showPreview({ viewColumn: ViewColumn.Active })),
  );
  context.subscriptions.push(
    commands.registerCommand(`${extensionId}.showPreviewToSide`, () => showPreview({ viewColumn: ViewColumn.Beside })),
  );

  // Listen for document open events to automatically set the ANSI language mode
  context.subscriptions.push(
    workspace.onDidOpenTextDocument(async (document: TextDocument) => {
      // console.log(`[ANSI Extension] Document opened: ${document.fileName}, language: ${document.languageId}`);
      if (shouldSetAnsiLanguageMode(document)) {
        await setAnsiLanguageMode(document, "document opened");
      }
    }),
  );

  // Listen for active editor changes to catch files opened via the file explorer
  context.subscriptions.push(
    window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor) {
        // console.log(
        //   `[ANSI Extension] Active editor changed: ${editor.document.fileName}, language: ${editor.document.languageId}`,
        // );
        if (shouldSetAnsiLanguageMode(editor.document)) {
          await setAnsiLanguageMode(editor.document, "active editor changed");
        }
      }
    }),
  );

  const ansiDecorationProvider = new AnsiDecorationProvider();
  context.subscriptions.push(ansiDecorationProvider);

  context.subscriptions.push(registerTextEditorDecorationProvider(ansiDecorationProvider));

  /**
   * Refreshes the decorations of all currently visible ANSI documents.
   * Re-applies decorations when the extension is enabled, and clears them when disabled.
   * Covers changes to: enable, escapeSequenceDisplay, autoLanguageModeFiles.
   */
  const refreshActiveAnsiEditors = () => {
    for (const editor of window.visibleTextEditors) {
      const document = editor.document;

      // Only handle ANSI language editors (skip the preview panel, refreshed separately)
      if (document.languageId !== "ansi") {
        continue;
      }

      if (isAnsiViewerEnabled()) {
        // Re-trigger decoration rendering
        editorRedrawWatcher.forceEmitForUri(document.uri);
      } else {
        // Remove already-applied decorations
        clearRegisteredTextEditorDecorationProviders(editor);
      }
    }
  };

  // Listen for configuration changes: enable / escapeSequenceDisplay / autoLanguageModeFiles
  context.subscriptions.push(
    workspace.onDidChangeConfiguration(async (event) => {
      const enableChanged = event.affectsConfiguration("ansiViewer.enable");
      const escapeDisplayChanged = event.affectsConfiguration("ansiViewer.escapeSequenceDisplay");
      const globChanged = event.affectsConfiguration("ansiViewer.autoLanguageModeFiles");

      // Glob rules changed: re-evaluate the language mode of open documents
      if (globChanged) {
        for (const editor of window.visibleTextEditors) {
          if (shouldSetAnsiLanguageMode(editor.document)) {
            await setAnsiLanguageMode(editor.document, "config changed - visible document");
          }
        }

        if (window.activeTextEditor && shouldSetAnsiLanguageMode(window.activeTextEditor.document)) {
          await setAnsiLanguageMode(window.activeTextEditor.document, "config changed - active document");
        }
      }

      // Enable state changed: update the status bar
      if (enableChanged) {
        updateStatusBar(isAnsiViewerEnabled());
      }

      // Escape sequence display mode changed: clear the decoration cache (when enabled)
      if (escapeDisplayChanged && isAnsiViewerEnabled()) {
        ansiDecorationProvider.clearEscapeSequenceDecorations();
      }

      // For any of the above changes, refresh the currently open ANSI documents
      if (enableChanged || escapeDisplayChanged || globChanged) {
        refreshActiveAnsiEditors();
      }
    }),
  );

  context.subscriptions.push(
    editorRedrawWatcher.onEditorRedraw(async (editor) => {
      // Check whether the extension is enabled
      if (!isAnsiViewerEnabled()) {
        return;
      }

      const tokenSource = new CancellationTokenSource();
      await executeRegisteredTextEditorDecorationProviders(editor, tokenSource.token);
      tokenSource.dispose();
    }),
  );

  context.subscriptions.push(
    commands.registerTextEditorCommand(`${extensionId}.insertEscapeCharacter`, (editor, edit) => {
      edit.delete(editor.selection);
      edit.insert(editor.selection.end, "\x1b");
    }),
  );

  // Register the enable/disable toggle command
  context.subscriptions.push(
    commands.registerCommand(`${extensionId}.toggleEnable`, async () => {
      const config = workspace.getConfiguration("ansiViewer");
      const currentValue = config.get("enable", true);
      const newValue = !currentValue;

      await config.update("enable", newValue, true);
      updateStatusBar(newValue);

      window.showInformationMessage(`ANSI Viewer ${newValue ? "enabled" : "disabled"}`);
    }),
  );

  // Check documents that are already open
  // console.log(`[ANSI Extension] Checking already opened documents`);
  if (window.activeTextEditor) {
    // console.log(`[ANSI Extension] Found active editor: ${window.activeTextEditor.document.fileName}`);
    const document = window.activeTextEditor.document;
    if (shouldSetAnsiLanguageMode(document)) {
      await setAnsiLanguageMode(document, "already opened document");
    }
  }

  // Check documents across all visible editors
  for (const editor of window.visibleTextEditors) {
    const document = editor.document;
    if (shouldSetAnsiLanguageMode(document)) {
      await setAnsiLanguageMode(document, "visible document");
    }
  }
}

export function deactivate(): void {
  // sic
}
