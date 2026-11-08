import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { parse, type ParseError } from "jsonc-parser";
import {
  Registry,
  INITIAL,
  parseRawGrammar,
  type IOnigLib,
  type IRawGrammar,
  type IRawTheme,
  type StateStack,
} from "vscode-textmate";
import * as oniguruma from "vscode-oniguruma";
import type * as vscode from "vscode";
import { escape, hash } from "./util.js";

type ThemeRule = IRawTheme["settings"][number];
type TokenStyle = ThemeRule["settings"];
type ThemeColors = Record<string, unknown>;
type TokenCustomizationName =
  | "comments"
  | "strings"
  | "keywords"
  | "numbers"
  | "types"
  | "functions"
  | "variables";
type ThemeCustomizations = Record<string, unknown> &
  Partial<Record<TokenCustomizationName, string | TokenStyle>> & {
    textMateRules?: ThemeRule[];
  };
interface ThemeDocument extends Record<string, unknown> {
  include?: string;
  colors?: ThemeColors;
  tokenColors?: ThemeRule[] | string;
}
interface LoadedTheme {
  colors: ThemeColors;
  settings: ThemeRule[];
}
interface LanguageContribution extends Record<string, unknown> {
  id: string;
  filenames?: string[];
  extensions?: string[];
}
interface GrammarContribution extends Record<string, unknown> {
  scopeName?: string;
  path?: string;
  language?: string;
  injectTo?: string[];
}
interface ThemeContribution extends Record<string, unknown> {
  id?: string;
  label?: string;
  path: string;
}
interface ExtensionContributions extends Record<string, unknown> {
  languages?: LanguageContribution[];
  grammars?: GrammarContribution[];
  themes?: ThemeContribution[];
}
interface ExtensionManifest extends Record<string, unknown> {
  contributes?: ExtensionContributions;
}
interface SelectedTheme extends ThemeContribution {
  name: string | undefined;
  filename: string;
}
interface CachedLines {
  lines: Map<number, string>;
  bytes: number;
}

const resolveModule = createRequire(__filename);
let onigLib: Promise<IOnigLib> | undefined;
function loadOniguruma(): Promise<IOnigLib> {
  return (onigLib ??= fs
    .readFile(resolveModule.resolve("vscode-oniguruma/release/onig.wasm"))
    .then(async (bytes) => {
      await oniguruma.loadWASM(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      );
      return {
        createOnigScanner: (patterns: string[]) =>
          new oniguruma.OnigScanner(patterns),
        createOnigString: (text: string) => new oniguruma.OnigString(text),
      };
    }));
}

async function readJson(filename: string): Promise<Record<string, unknown>> {
  const errors: ParseError[] = [];
  const value: unknown = parse(await fs.readFile(filename, "utf8"), errors, {
    allowTrailingComma: true,
  });
  if (errors.length || !value || typeof value !== "object")
    throw new Error("Invalid theme JSON.");
  return value as Record<string, unknown>;
}

export async function readTheme(
  filename: string,
  ancestors: Set<string> = new Set(),
): Promise<LoadedTheme> {
  filename = path.resolve(filename);
  if (ancestors.has(filename) || ancestors.size >= 16)
    throw new Error("Cyclic or deeply nested theme include.");
  const chain = new Set([...ancestors, filename]);
  const own = (await readJson(filename)) as ThemeDocument;
  const parent: LoadedTheme =
    typeof own.include === "string"
      ? await readTheme(
          path.resolve(path.dirname(filename), own.include),
          chain,
        )
      : { colors: {}, settings: [] };
  let settings = Array.isArray(own.tokenColors) ? own.tokenColors : [];
  if (typeof own.tokenColors === "string") {
    const tokenFile = path.resolve(path.dirname(filename), own.tokenColors);
    // TextMate's public parser also reads the PLIST used by .tmTheme files.
    const parsed = parseRawGrammar(
      await fs.readFile(tokenFile, "utf8"),
      tokenFile,
    ) as IRawGrammar & { settings?: ThemeRule[] };
    settings = parsed.settings ?? [];
  }
  return {
    colors: { ...parent.colors, ...own.colors },
    settings: [...parent.settings, ...settings],
  };
}

function wildcard(pattern: string, value: string): boolean {
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(value);
}

export function themedOverrides(
  value: ThemeCustomizations = {},
  names: string[],
): ThemeCustomizations & { textMateRules: ThemeRule[] } {
  const result = { ...value, textMateRules: [...(value.textMateRules ?? [])] };
  for (const [key, rawItem] of Object.entries(value)) {
    const patterns = [...key.matchAll(/\[([^\]]+)\]/g)].map(
      (match) => match[1],
    );
    if (
      !patterns.length ||
      !names.some((name) => patterns.some((pattern) => wildcard(pattern, name)))
    )
      continue;
    const item = rawItem as ThemeCustomizations;
    const previousRules = result.textMateRules;
    Object.assign(result, item);
    result.textMateRules = [...previousRules, ...(item.textMateRules ?? [])];
  }
  return result;
}

const customizationScopes: ReadonlyArray<
  readonly [TokenCustomizationName, string[]]
> = [
  ["comments", ["comment", "punctuation.definition.comment"]],
  ["strings", ["string", "meta.embedded.assembly"]],
  ["keywords", ["keyword", "storage"]],
  ["numbers", ["constant.numeric"]],
  [
    "types",
    ["entity.name.type", "entity.name.class", "support.type", "support.class"],
  ],
  ["functions", ["entity.name.function", "support.function"]],
  ["variables", ["variable", "entity.name.variable"]],
];

export function themeSettings(
  theme: LoadedTheme,
  tokens: ThemeCustomizations,
  colors: ThemeColors,
): ThemeRule[] {
  const settings = [...theme.settings];
  const defaults: { foreground?: string; background?: string } = {};
  for (const key of ["foreground", "background"] satisfies Array<
    keyof typeof defaults
  >) {
    const color = colors[`editor.${key}`] ?? theme.colors[`editor.${key}`];
    if (typeof color === "string") defaults[key] = color;
  }
  // The default foreground follows workbench color overrides; diff backgrounds remain CSS-controlled.
  settings.push({ settings: defaults });
  for (const [key, scope] of customizationScopes) {
    const value = tokens[key];
    if (value)
      settings.push({
        scope,
        settings: typeof value === "string" ? { foreground: value } : value,
      });
  }
  settings.push(...(tokens.textMateRules ?? []));
  return settings;
}

export function tokenHtml(
  line: string,
  tokens: Uint32Array | readonly number[],
  palette: readonly string[],
): string {
  let html = "";
  for (let index = 0; index < tokens.length; index += 2) {
    const text = line.slice(tokens[index], tokens[index + 2] ?? line.length);
    if (!text) continue;
    // tokenizeLine2's encoded token format: foreground bits 15–23, font style bits 11–14.
    const metadata = tokens[index + 1];
    const foreground = (metadata >>> 15) & 0x1ff;
    const color = palette[foreground];
    const font = (metadata >>> 11) & 0xf;
    const styles: string[] = [];
    if (foreground > 1 && /^#[\da-f]{6}([\da-f]{2})?$/i.test(color))
      styles.push(`color:${color}`);
    if (font & 1) styles.push("font-style:italic");
    if (font & 2) styles.push("font-weight:bold");
    const decoration = [
      font & 4 ? "underline" : "",
      font & 8 ? "line-through" : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (decoration) styles.push(`text-decoration:${decoration}`);
    html += styles.length
      ? `<span class="syntax-token" style="${styles.join(";")}">${escape(text)}</span>`
      : escape(text);
  }
  return html;
}

function extensionContributions(
  extension: vscode.Extension<unknown>,
): ExtensionContributions {
  const manifest: unknown = extension.packageJSON;
  return (manifest as ExtensionManifest).contributes ?? {};
}

export class SyntaxHighlighter {
  declare vscode: typeof import("vscode");
  declare queue: Promise<unknown>;
  declare generation: number;
  declare readyGeneration: number | undefined;
  declare cache: Map<string, CachedLines>;
  declare cacheBytes: number;
  declare registry: Registry | undefined;
  declare languages: LanguageContribution[];
  declare languageScopes: Map<string, string>;
  private disposed = false;

  constructor(vscode: typeof import("vscode")) {
    this.vscode = vscode;
    this.queue = Promise.resolve();
    this.generation = 0;
    this.cache = new Map();
    this.cacheBytes = 0;
  }

  invalidate(): void {
    this.generation++;
  }
  dispose(): void {
    this.disposed = true;
    this.invalidate();
    void this.queue.then(
      () => this.registry?.dispose(),
      () => this.registry?.dispose(),
    );
  }

  async initialize(): Promise<void> {
    if (this.readyGeneration === this.generation) return;
    this.registry?.dispose();
    this.registry = undefined;
    this.cache.clear();
    this.cacheBytes = 0;
    this.readyGeneration = this.generation;
    const extensions = this.vscode.extensions.all;
    this.languages = extensions.flatMap(
      (extension) => extensionContributions(extension).languages ?? [],
    );
    const grammars = new Map<string, string>();
    const languageScopes = new Map<string, string>();
    const injections = new Map<string, string[]>();
    let selected: SelectedTheme | undefined;
    const requested = this.vscode.workspace
      .getConfiguration("workbench")
      .get<string>("colorTheme");
    for (const extension of extensions) {
      const contributions = extensionContributions(extension);
      for (const grammar of contributions.grammars ?? []) {
        if (!grammar.scopeName || !grammar.path) continue;
        grammars.set(
          grammar.scopeName,
          path.resolve(extension.extensionPath, grammar.path),
        );
        if (grammar.language)
          languageScopes.set(grammar.language, grammar.scopeName);
        for (const scope of grammar.injectTo ?? [])
          injections.set(scope, [
            ...(injections.get(scope) ?? []),
            grammar.scopeName,
          ]);
      }
      if (!contributions.themes?.length) continue;
      const nls = (await readJson(
        path.join(extension.extensionPath, "package.nls.json"),
      ).catch(() => ({}))) as Record<string, string | undefined>;
      for (const theme of contributions.themes) {
        const label = /^%(.+)%$/.exec(theme.label ?? "");
        const name = label ? nls[label[1]] : theme.label;
        if (theme.id === requested || name === requested)
          selected = {
            ...theme,
            name,
            filename: path.resolve(extension.extensionPath, theme.path),
          };
      }
    }
    this.languageScopes = languageScopes;
    if (!selected) return;
    try {
      const names = [requested, selected.id, selected.name].filter(
        (name): name is string => Boolean(name),
      );
      const editor = this.vscode.workspace.getConfiguration("editor");
      const tokens = themedOverrides(
        editor.get<ThemeCustomizations>("tokenColorCustomizations", {}),
        names,
      );
      const colors = themedOverrides(
        this.vscode.workspace
          .getConfiguration("workbench")
          .get<ThemeCustomizations>("colorCustomizations", {}),
        names,
      );
      const theme = await readTheme(selected.filename);
      this.registry = new Registry({
        onigLib: loadOniguruma(),
        theme: { settings: themeSettings(theme, tokens, colors) },
        loadGrammar: async (scope): Promise<IRawGrammar | null> => {
          const filename = grammars.get(scope);
          if (!filename) return null;
          try {
            return parseRawGrammar(
              await fs.readFile(filename, "utf8"),
              filename,
            );
          } catch {
            return null;
          }
        },
        getInjections: (scope) => injections.get(scope),
      });
    } catch {
      /* Unavailable or malformed themes leave escaped, uncolored source readable. */
    }
  }

  language(file: string): string | undefined {
    const associations = this.vscode.workspace
      .getConfiguration("files")
      .get<Record<string, string>>("associations", {});
    const associated = Object.entries(associations)
      .filter(([pattern]) =>
        wildcard(pattern, pattern.includes("/") ? file : path.basename(file)),
      )
      .at(-1);
    if (associated) return associated[1];
    const basename = path.basename(file);
    return (
      this.languages.find((language) => language.filenames?.includes(basename))
        ?.id ??
      this.languages
        .flatMap((language) =>
          (language.extensions ?? [])
            .filter((extension) => basename.endsWith(extension))
            .map((extension) => ({
              id: language.id,
              length: extension.length,
            })),
        )
        .sort((a, b) => b.length - a.length)[0]?.id
    );
  }

  async lines(
    file: string,
    text: string | null,
    wanted: Set<number>,
    deadline: number,
  ): Promise<Map<number, string>> {
    const result = new Map<number, string>();
    if (
      text === null ||
      !wanted.size ||
      !this.registry ||
      performance.now() > deadline
    )
      return result;
    const language = this.language(file);
    const scope =
      language === undefined ? undefined : this.languageScopes.get(language);
    if (!scope) return result;
    const key = hash(JSON.stringify([scope, text, [...wanted]]));
    const cached = this.cache.get(key);
    if (cached) return cached.lines;
    try {
      const grammar = await this.registry.loadGrammar(scope);
      if (!grammar) return result;
      const source = text.split("\n");
      let state: StateStack = INITIAL;
      const until = Math.min(
        [...wanted].reduce((maximum, line) => Math.max(maximum, line), 0),
        source.length,
      );
      const fileDeadline = deadline;
      for (let index = 0; index < until; index++) {
        // Do not continue with an unreliable multiline state after a timeout or an oversized line.
        if (
          this.disposed ||
          source[index].length > 10000 ||
          performance.now() > fileDeadline
        ) {
          if (!this.disposed)
            console.warn(
              `Syntax highlighting stopped before line ${index + 1} of ${file}: source or time limit exceeded.`,
            );
          return result;
        }
        let tokenized = grammar.tokenizeLine2(
          source[index],
          state,
          index === 0 ? 50 : 10,
        );
        if (tokenized.stoppedEarly && performance.now() < fileDeadline) {
          await new Promise<unknown>(setImmediate);
          const remaining = fileDeadline - performance.now();
          if (remaining > 0)
            tokenized = grammar.tokenizeLine2(
              source[index],
              state,
              Math.max(1, Math.min(100, remaining)),
            );
        }
        if (tokenized.stoppedEarly) {
          console.warn(
            `Syntax highlighting stopped at line ${index + 1} of ${file}: tokenization timed out.`,
          );
          return result;
        }
        state = tokenized.ruleStack;
        if (wanted.has(index + 1))
          result.set(
            index + 1,
            tokenHtml(
              source[index],
              tokenized.tokens,
              this.registry.getColorMap(),
            ),
          );
        if (index % 100 === 99) await new Promise<unknown>(setImmediate);
      }
      const bytes = [...result.values()].reduce(
        (sum, html) => sum + Buffer.byteLength(html),
        0,
      );
      if (bytes <= 8 * 1024 * 1024) {
        while (
          this.cache.size &&
          (this.cache.size >= 32 || this.cacheBytes + bytes > 8 * 1024 * 1024)
        ) {
          const first = this.cache.entries().next().value;
          if (!first) break;
          this.cacheBytes -= first[1].bytes;
          this.cache.delete(first[0]);
        }
        this.cache.set(key, { lines: result, bytes });
        this.cacheBytes += bytes;
      }
    } catch (error) {
      console.warn(`Syntax highlighting failed for ${file}:`, error);
      return result;
    }
    return result;
  }

  /** Highlights chosen lines of one text. Requests run one at a time. */
  highlightLines(
    file: string,
    text: string | null,
    wanted: Set<number>,
  ): Promise<Map<number, string>> {
    const run = async (): Promise<Map<number, string>> => {
      if (
        this.disposed ||
        !this.vscode.workspace
          .getConfiguration("guidedCodeReview")
          .get("syntaxHighlighting", true)
      )
        return new Map();
      try {
        await this.initialize();
      } catch {
        return new Map();
      }
      if (this.disposed) return new Map();
      return this.lines(file, text, wanted, performance.now() + 1500);
    };
    const task = this.queue.catch(() => {}).then(run);
    this.queue = task;
    return task;
  }
}
