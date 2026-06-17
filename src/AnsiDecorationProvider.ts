import {
  TextDocument,
  ProviderResult,
  TextEditorDecorationType,
  TextEditor,
  window,
  Range,
  workspace,
  ThemeColor,
} from "vscode";

import * as ansi from "./ansi";
import { AnsiContentPreviewProvider } from "./AnsiContentPreviewProvider";
import { TextEditorDecorationProvider } from "./TextEditorDecorationProvider";

function upsert<K, V>(map: Map<K, V>, key: K, value: V): V {
  return map.get(key) ?? (map.set(key, value), value);
}

const ansiThemeColors: Record<ansi.NamedColor, ThemeColor | undefined> = {
  [ansi.NamedColor.DefaultBackground]: undefined,
  [ansi.NamedColor.DefaultForeground]: undefined,

  [ansi.NamedColor.Black]: new ThemeColor("terminal.ansiBlack"),
  [ansi.NamedColor.BrightBlack]: new ThemeColor("terminal.ansiBrightBlack"),

  [ansi.NamedColor.White]: new ThemeColor("terminal.ansiWhite"),
  [ansi.NamedColor.BrightWhite]: new ThemeColor("terminal.ansiBrightWhite"),

  [ansi.NamedColor.Red]: new ThemeColor("terminal.ansiRed"),
  [ansi.NamedColor.BrightRed]: new ThemeColor("terminal.ansiBrightRed"),

  [ansi.NamedColor.Green]: new ThemeColor("terminal.ansiGreen"),
  [ansi.NamedColor.BrightGreen]: new ThemeColor("terminal.ansiBrightGreen"),

  [ansi.NamedColor.Yellow]: new ThemeColor("terminal.ansiYellow"),
  [ansi.NamedColor.BrightYellow]: new ThemeColor("terminal.ansiBrightYellow"),

  [ansi.NamedColor.Blue]: new ThemeColor("terminal.ansiBlue"),
  [ansi.NamedColor.BrightBlue]: new ThemeColor("terminal.ansiBrightBlue"),

  [ansi.NamedColor.Magenta]: new ThemeColor("terminal.ansiMagenta"),
  [ansi.NamedColor.BrightMagenta]: new ThemeColor("terminal.ansiBrightMagenta"),

  [ansi.NamedColor.Cyan]: new ThemeColor("terminal.ansiCyan"),
  [ansi.NamedColor.BrightCyan]: new ThemeColor("terminal.ansiBrightCyan"),
};

const ansiExplicitThemeColors: Record<ansi.NamedColor, ThemeColor | undefined> = {
  ...ansiThemeColors,
  [ansi.NamedColor.DefaultBackground]: new ThemeColor("editor.background"),
  [ansi.NamedColor.DefaultForeground]: new ThemeColor("editor.foreground"),
};

function convertColor(color: ansi.Color, explicitDefaults: boolean): ThemeColor | string | undefined {
  if (color & ansi.ColorFlags.Named) {
    const record = explicitDefaults ? ansiExplicitThemeColors : ansiThemeColors;
    return record[color as ansi.NamedColor];
  }
  return "#" + color.toString(16).padStart(6, "0");
}

export class AnsiDecorationProvider implements TextEditorDecorationProvider {
  provideDecorationRanges(document: TextDocument): ProviderResult<[string, Range[]][]> {
    if (document.uri.scheme === AnsiContentPreviewProvider.scheme) {
      return this._provideDecorationsForPrettifiedAnsi(document);
    }

    if (document.languageId === "ansi") {
      return this._provideDecorationsForAnsiLanguageType(document);
    }

    return undefined;
  }

  private _provideDecorationsForAnsiLanguageType(document: TextDocument): ProviderResult<[string, Range[]][]> {
    const result = new Map<string, Range[]>();

    const config = workspace.getConfiguration("ansiViewer");
    const escapeSequenceDisplay: string = config.get("escapeSequenceDisplay", "dimmed");

    for (const key of this._decorationTypes.keys()) {
      result.set(key, []);
    }

    const escapeDecorations: Range[] = [];
    const escapeKey = `escape_${escapeSequenceDisplay}`;
    result.set(escapeKey, escapeDecorations);

    const parser = new ansi.Parser();

    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
      const line = document.lineAt(lineNumber);
      const spans = parser.appendLine(line.text);

      for (const span of spans) {
        const { offset, length, ...style } = span;
        const range = new Range(lineNumber, offset, lineNumber, offset + length);

        if (style.attributeFlags & ansi.AttributeFlags.EscapeSequence) {
          escapeDecorations.push(range);
          continue;
        }

        const key = JSON.stringify(style);
        upsert(result, key, []).push(range);
      }
    }

    return [...result];
  }

  private async _provideDecorationsForPrettifiedAnsi(providerDocument: TextDocument): Promise<[string, Range[]][]> {
    const actualUri = AnsiContentPreviewProvider.toActualUri(providerDocument.uri);
    const actualDocument = await workspace.openTextDocument(actualUri);

    const result = new Map<string, Range[]>();
    for (const key of this._decorationTypes.keys()) {
      result.set(key, []);
    }

    const parser = new ansi.Parser();

    for (let lineNumber = 0; lineNumber < actualDocument.lineCount; lineNumber += 1) {
      let totalEscapeLength = 0;

      const line = actualDocument.lineAt(lineNumber);
      const spans = parser.appendLine(line.text);

      for (const span of spans) {
        const { offset, length, ...style } = span;

        if (style.attributeFlags & ansi.AttributeFlags.EscapeSequence) {
          totalEscapeLength += length;
          continue;
        }

        const range = new Range(
          lineNumber,
          offset - totalEscapeLength,
          lineNumber,
          offset + length - totalEscapeLength,
        );

        const key = JSON.stringify(style);

        upsert(result, key, []).push(range);
      }
    }

    return [...result];
  }

  private _decorationTypes = new Map<string, TextEditorDecorationType>();

  /**
   * Clears the cached escape sequence decoration types. Used on configuration change.
   */
  public clearEscapeSequenceDecorations(): void {
    for (const [key, decorationType] of this._decorationTypes.entries()) {
      if (key.startsWith("escape_")) {
        decorationType.dispose();
        this._decorationTypes.delete(key);
      }
    }
  }

  /**
   * Clears all decorations previously applied on the given editor (sets them to
   * empty ranges). The decoration types themselves are kept in the cache for
   * reuse; they are only removed from this editor.
   */
  public clearEditorDecorations(editor: TextEditor): void {
    for (const decorationType of this._decorationTypes.values()) {
      editor.setDecorations(decorationType, []);
    }
  }

  private getEscapeSequenceDecorationType(): TextEditorDecorationType {
    const config = workspace.getConfiguration("ansiViewer");
    const escapeSequenceDisplay: string = config.get("escapeSequenceDisplay", "dimmed");

    const cacheKey = `escape_${escapeSequenceDisplay}`;
    let decorationType = this._decorationTypes.get(cacheKey);

    if (!decorationType) {
      // Clear previous escape sequence decoration types
      for (const [key, oldDecorationType] of this._decorationTypes.entries()) {
        if (key.startsWith("escape_")) {
          oldDecorationType.dispose();
          this._decorationTypes.delete(key);
        }
      }

      switch (escapeSequenceDisplay) {
        case "normal":
          decorationType = window.createTextEditorDecorationType({});
          break;
        case "hidden":
          decorationType = window.createTextEditorDecorationType({
            opacity: "0%",
            // Alternatively, use textDecoration to fully hide it
            textDecoration: "none; font-size: 0px;",
          });
          break;
        case "dimmed":
        default:
          decorationType = window.createTextEditorDecorationType({ opacity: "50%" });
          break;
      }
      this._decorationTypes.set(cacheKey, decorationType);
    }

    return decorationType;
  }

  resolveDecoration(key: string): ProviderResult<TextEditorDecorationType> {
    // Handle the dynamic key for escape sequence decorations
    if (key.startsWith("escape_")) {
      return this.getEscapeSequenceDecorationType();
    }

    let decorationType = this._decorationTypes.get(key);

    if (decorationType) {
      return decorationType;
    }

    const style: ansi.Style = JSON.parse(key);

    const inverse = (style.attributeFlags & ansi.AttributeFlags.Inverse) !== 0;
    const background = inverse ? style.foregroundColor : style.backgroundColor;
    const foreground = inverse ? style.backgroundColor : style.foregroundColor;

    decorationType = window.createTextEditorDecorationType({
      backgroundColor: convertColor(background, inverse),
      color: convertColor(foreground, inverse),

      fontWeight: style.attributeFlags & ansi.AttributeFlags.Bold ? "bold" : undefined,
      fontStyle: style.attributeFlags & ansi.AttributeFlags.Italic ? "italic" : undefined,
      textDecoration: style.attributeFlags & ansi.AttributeFlags.Underline ? "underline" : undefined,
      opacity: style.attributeFlags & ansi.AttributeFlags.Faint ? "50%" : undefined,
    });

    this._decorationTypes.set(key, decorationType);

    return decorationType;
  }

  private _isDisposed = false;

  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    this._isDisposed = true;

    for (const decorationType of this._decorationTypes.values()) {
      decorationType.dispose();
    }

    this._decorationTypes.clear();
  }
}
