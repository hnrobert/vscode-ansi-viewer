import { TextDocument, CancellationToken, ProviderResult, TextEditorDecorationType, TextEditor, Range } from "vscode";

export interface TextEditorDecorationProvider {
  provideDecorationRanges(document: TextDocument, token: CancellationToken): ProviderResult<[string, Range[]][]>;
  resolveDecoration(key: string, token: CancellationToken): ProviderResult<TextEditorDecorationType>;

  /**
   * Clears all decorations previously applied by this provider on the given editor
   * (by setting them to empty ranges). Used when the extension is disabled or
   * configuration changes to remove already-rendered ANSI decorations.
   */
  clearEditorDecorations?(editor: TextEditor): void;
}

const registeredProviders = new Set<TextEditorDecorationProvider>();

export function registerTextEditorDecorationProvider(provider: TextEditorDecorationProvider): { dispose(): void } {
  registeredProviders.add(provider);
  return { dispose: () => registeredProviders.delete(provider) };
}

/**
 * Clears decorations applied by all registered providers on the given editor.
 */
export function clearRegisteredTextEditorDecorationProviders(editor: TextEditor): void {
  for (const provider of registeredProviders) {
    provider.clearEditorDecorations?.(editor);
  }
}

export async function executeRegisteredTextEditorDecorationProviders(
  editor: TextEditor,
  token: CancellationToken,
): Promise<void> {
  for (const provider of registeredProviders) {
    let decorations: [string, Range[]][] | null | undefined;

    try {
      decorations = await provider.provideDecorationRanges(editor.document, token);
    } catch (error) {
      // console.error(`error providing decorations`, error);
      return;
    }

    if (token.isCancellationRequested) {
      return;
    }

    if (!decorations) {
      return;
    }

    const decorationTypes = new Map<string, TextEditorDecorationType>();

    for (const [key, ranges] of decorations) {
      let decorationType: ProviderResult<TextEditorDecorationType> = decorationTypes.get(key);

      if (!decorationType) {
        try {
          decorationType = await provider.resolveDecoration(key, token);
        } catch (error) {
          // console.error(`error providing decorations for key ${key}`, error);
          continue;
        }

        if (token.isCancellationRequested) {
          return;
        }

        if (!decorationType) {
          // console.error(`no decoration resolved for key ${key}`);
          continue;
        }

        decorationTypes.set(key, decorationType);
      }

      editor.setDecorations(decorationType, ranges);
    }
  }
}
