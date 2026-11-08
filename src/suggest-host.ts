import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type * as vscode from "vscode";
import { escape } from "./util.js";
import { contained, filePath, git } from "./git.js";
import { SyntaxHighlighter } from "./syntax.js";
import { FileWatchers, type WatchTargets } from "./watchers.js";
import {
  captureInspection,
  liveDiff,
  overlaps,
  rangeCores,
  repositoryOf,
  stageCores,
  uncoveredCores,
  type Core,
  type FileDiff,
  type Span,
} from "./spans.js";
import {
  parseBlocks,
  navigationTargets,
  renderMarkdown,
  resolveBlocks,
  setApproval,
  type Block,
  type BlockContext,
  type NavigationTarget,
} from "./suggest-render.js";
import { markdownFile, Session, type Documents } from "./suggest-session.js";
import {
  decodePageMessage,
  type NavigateMessage,
  type SuggestHostMessage,
} from "./suggest-protocol.js";

interface Entry {
  session: Session;
  panel?: vscode.WebviewPanel;
  watchers: FileWatchers;
  positions: Map<string, { start: number; size: number }>;
  rendering: boolean;
  again: boolean;
  /** Set when the session is deleted, so queued approvals stop. */
  closed: boolean;
}

interface SessionInput {
  session: string;
}

interface CaptureInput extends SessionInput {
  files: { file: string; ranges?: string[] }[];
  block?: string;
}

const VIEW = "layoutSuggest.session";

/** Registers suggest sessions: their panels, commands and agent tools. */
export function registerSuggestHost(
  vscode: typeof import("vscode"),
  context: vscode.ExtensionContext,
): void {
  const storage = path.join(
    (context.storageUri ?? context.globalStorageUri).fsPath,
    "layout-suggest",
  );
  const entries = new Map<string, Entry>();
  const loading = new Map<string, Promise<Entry>>();
  let stagingWrites: Promise<unknown> = Promise.resolve();
  let opening: Promise<unknown> = Promise.resolve();
  let waits = 0;
  const syntax = new SyntaxHighlighter(vscode);
  context.subscriptions.push(syntax);

  async function allowed(root: string): Promise<boolean> {
    if (!vscode.workspace.isTrusted) return false;
    const folders = await Promise.all(
      (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === "file")
        .map((folder) => fs.realpath(folder.uri.fsPath).catch(() => "")),
    );
    return folders.some((folder) => folder && contained(folder, root));
  }

  function unsaved(file: string): boolean {
    return vscode.workspace.textDocuments.some(
      (d) => d.isDirty && d.uri.scheme === "file" && d.uri.fsPath === file,
    );
  }

  function blockContext(
    documentPath: string,
    positions?: Entry["positions"],
  ): BlockContext {
    return {
      documentPath,
      allowed,
      highlight: (file, text, wanted) =>
        syntax.highlightLines(file, text, wanted),
      positions,
      location,
    };
  }

  function headUri(diff: FileDiff, emptyWorking = false): vscode.Uri {
    return vscode.Uri.from({
      scheme: "layout-suggest-git",
      path: `/${emptyWorking ? "working" : "HEAD"}/${diff.file}`,
      query: JSON.stringify({
        root: diff.root,
        file: diff.file,
        head: emptyWorking || diff.base === null ? null : diff.head,
      }),
    });
  }

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("layout-suggest-git", {
      async provideTextDocumentContent(uri) {
        const value: unknown = JSON.parse(uri.query);
        if (!value || typeof value !== "object")
          throw new Error("Invalid Git document.");
        const entry = value as Record<string, unknown>;
        filePath(entry.file);
        if (
          typeof entry.root !== "string" ||
          !(
            entry.head === null ||
            (typeof entry.head === "string" &&
              /^[0-9a-f]{40,64}$/.test(entry.head))
          )
        )
          throw new Error("Invalid Git document.");
        const root = await fs.realpath(entry.root);
        if (!(await allowed(root)) || (await repositoryOf(root)) !== root)
          throw new Error("The Git document is outside the open workspace.");
        return entry.head === null
          ? ""
          : git(root, ["show", `${entry.head}:${entry.file}`]);
      },
    }),
  );

  async function location(
    diff: FileDiff,
    target: NavigationTarget,
  ): Promise<string | undefined> {
    const uri = target.next
      ? vscode.Uri.file(path.join(diff.root, diff.file))
      : headUri(diff);
    const source = target.next ? diff.working : diff.base;
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      if (document.getText() !== source) return undefined;
      const symbols = await vscode.commands.executeCommand<
        (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined
      >("vscode.executeDocumentSymbolProvider", uri);
      const range = target.next ?? target.old!;
      let found: string | undefined;
      let size = Infinity;
      const visit = (
        items: (vscode.DocumentSymbol | vscode.SymbolInformation)[],
        parents: string[],
      ): void => {
        for (const symbol of items) {
          const extent =
            "location" in symbol ? symbol.location.range : symbol.range;
          const names = [...parents, symbol.name];
          if (
            ![
              vscode.SymbolKind.Variable,
              vscode.SymbolKind.Constant,
              vscode.SymbolKind.Field,
              vscode.SymbolKind.Property,
              vscode.SymbolKind.EnumMember,
            ].includes(symbol.kind) &&
            extent.start.line <= range[0] - 1 &&
            extent.end.line >= range[1] - 1 &&
            extent.end.line - extent.start.line < size
          ) {
            found = names.join(".");
            size = extent.end.line - extent.start.line;
          }
          if ("children" in symbol) visit(symbol.children, names);
        }
      };
      visit(symbols ?? [], []);
      return found;
    } catch (error) {
      console.warn(
        `Suggest diff location lookup failed for ${diff.file}:`,
        error,
      );
      return undefined;
    }
  }

  function selection(
    document: vscode.TextDocument,
    lines: [number, number] | undefined,
    point: number,
  ): vscode.Selection {
    const start = Math.min(
      document.lineCount - 1,
      Math.max(0, (lines?.[0] ?? point) - 1),
    );
    const end = Math.min(
      document.lineCount - 1,
      Math.max(start, (lines?.[1] ?? point) - 1),
    );
    return new vscode.Selection(
      start,
      0,
      end,
      lines ? document.lineAt(end).text.length : 0,
    );
  }

  async function navigate(
    entry: Entry,
    message: NavigateMessage,
  ): Promise<void> {
    const markdown = await entry.session.readDocument();
    const { blocks } = parseBlocks(markdown);
    await resolveBlocks(blocks, blockContext(entry.session.documentPath));
    const block = blocks.find((block) => block.ref?.id === message.block);
    const target =
      block &&
      navigationTargets(block).find((target) => target.id === message.target);
    if (!block?.diff || !target || entry.closed)
      throw new Error(
        "The original location is unavailable. Capture the block again.",
      );
    const diff = block.diff;
    const file = vscode.Uri.file(path.join(diff.root, diff.file));
    const column = entry.panel?.viewColumn ?? vscode.ViewColumn.Active;
    const working =
      diff.working === null
        ? undefined
        : await vscode.workspace.openTextDocument(file);
    if (working && working.getText() !== diff.working)
      throw new Error(
        "The working file has unsaved changes. Save it before navigating.",
      );
    if (message.type === "source") {
      if (!working)
        throw new Error(
          "This file was deleted. Use Open diff to inspect its original location.",
        );
      const range = selection(working, target.next, target.workingLine);
      const editor = await vscode.window.showTextDocument(working, {
        viewColumn: column,
        preview: true,
        selection: range,
      });
      editor.selection = range;
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      return;
    }
    const before = headUri(diff);
    const after = working?.uri ?? headUri(diff, true);
    await vscode.commands.executeCommand(
      "vscode.diff",
      before,
      after,
      `${diff.file} (HEAD ↔ working)`,
      {
        viewColumn: column,
        preview: true,
        ...(working && {
          selection: selection(working, target.next, target.workingLine),
        }),
      },
    );
    // Opening a native diff can finish before its text editors are exposed.
    await new Promise<void>((resolve, reject) => {
      const desired = target.next ? after : before;
      const apply = (): void => {
        let found = false;
        for (const editor of vscode.window.visibleTextEditors) {
          const uri = editor.document.uri.toString();
          const old = uri === before.toString();
          if (!old && uri !== after.toString()) continue;
          if (
            column !== vscode.ViewColumn.Active &&
            editor.viewColumn !== undefined &&
            editor.viewColumn !== column
          )
            continue;
          const range = selection(
            editor.document,
            old ? target.old : target.next,
            old ? (target.old?.[0] ?? 1) : target.workingLine,
          );
          editor.selection = range;
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
          found ||= uri === desired.toString();
        }
        if (found) {
          clearTimeout(timeout);
          subscription.dispose();
          resolve();
        }
      };
      const subscription = vscode.window.onDidChangeVisibleTextEditors(apply);
      const timeout = setTimeout(() => {
        subscription.dispose();
        reject(
          new Error(
            "The comparison opened, but its target editor is unavailable.",
          ),
        );
      }, 3000);
      apply();
    });
  }

  async function watchTargets(blocks: Block[]): Promise<WatchTargets> {
    const gitPaths = new Set<string>();
    const files = new Set<string>();
    for (const root of new Set(blocks.flatMap((b) => b.root ?? []))) {
      const branch = (
        await git(root, ["symbolic-ref", "-q", "HEAD"], [0, 1])
      ).trim();
      for (const ref of [
        "index",
        "HEAD",
        "packed-refs",
        ...(branch ? [branch] : []),
      ])
        gitPaths.add(
          path.resolve(
            root,
            (await git(root, ["rev-parse", "--git-path", ref])).trim(),
          ),
        );
    }
    for (const block of blocks)
      if (block.root && block.ref)
        files.add(path.join(block.root, block.ref.file));
    return { gitPaths: [...gitPaths], files: [...files] };
  }

  function documents(entry: () => Entry): Documents {
    return {
      async render(markdown, documentPath, approvable) {
        const { html, blocks } = await renderMarkdown(
          markdown,
          blockContext(
            documentPath,
            approvable ? entry().positions : undefined,
          ),
          approvable,
        );
        if (approvable)
          void entry()
            .watchers.update(watchTargets(blocks))
            .catch(() => {});
        return html;
      },
      async outdated(markdown, documentPath) {
        const { blocks } = parseBlocks(markdown);
        await resolveBlocks(blocks, blockContext(documentPath));
        return blocks
          .filter((b) => !b.approved && (b.invalid || b.problems.length))
          .map((b) => ({
            id: b.ref?.id ?? "",
            file: b.ref?.file ?? "",
            problems: b.invalid ? [b.invalid] : b.problems,
          }));
      },
      unsaved,
    };
  }

  function post(entry: Entry, message: SuggestHostMessage): void {
    void entry.panel?.webview.postMessage(message);
  }

  async function render(entry: Entry): Promise<void> {
    if (!entry.panel) return;
    if (entry.rendering) {
      entry.again = true;
      return;
    }
    entry.rendering = true;
    try {
      post(entry, await entry.session.view());
    } catch (error) {
      console.error(
        `Suggest view render failed for ${entry.session.name}:`,
        error,
      );
    } finally {
      entry.rendering = false;
      if (entry.again) {
        entry.again = false;
        void render(entry);
      }
    }
  }

  function validName(name: unknown): name is string {
    return typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
  }

  async function sessionNames(): Promise<string[]> {
    const names = await fs.readdir(storage).catch(() => []);
    return names.filter(validName).sort();
  }

  /** The document a stored session works on, without loading it. */
  async function storedDocument(name: string): Promise<string | undefined> {
    try {
      const store = JSON.parse(
        await fs.readFile(path.join(storage, name, "suggestions.json"), "utf8"),
      ) as { document?: unknown };
      return typeof store.document === "string" ? store.document : undefined;
    } catch {
      return undefined;
    }
  }

  function load(name: string): Promise<Entry> {
    const loaded = entries.get(name);
    if (loaded) return Promise.resolve(loaded);
    let task = loading.get(name);
    if (!task) {
      task = (async () => {
        const document = await storedDocument(name);
        if (
          document &&
          !(await allowed(await fs.realpath(document).catch(() => document)))
        )
          throw new Error(
            `The document of session ${name} is outside the open workspace.`,
          );
        const entry: Entry = {
          session: new Session(
            path.join(storage, name),
            documents(() => entry),
          ),
          watchers: new FileWatchers(vscode, () => entry.session.refresh()),
          positions: new Map(),
          rendering: false,
          again: false,
          closed: false,
        };
        await entry.session.start();
        entry.session.on("change", () => void render(entry));
        entry.session.on("status", () => post(entry, entry.session.status()));
        entries.set(name, entry);
        return entry;
      })().finally(() => loading.delete(name));
      loading.set(name, task);
    }
    return task;
  }

  /** A loaded session the agent names; it must exist already. */
  async function named(input: unknown): Promise<Entry> {
    const name = (input as Partial<SessionInput> | undefined)?.session;
    if (!validName(name) || !(await sessionNames()).includes(name))
      throw new Error(
        `Unknown session ${String(name)}. Start one with guidedReview_openSession.`,
      );
    return load(name);
  }

  async function uniqueName(base: string): Promise<string> {
    const taken = new Set(await sessionNames());
    const slug =
      base
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^[-_]+|-+$/g, "")
        .slice(0, 50) || "session";
    let name = slug;
    for (let n = 2; taken.has(name); n++) name = `${slug}-${n}`;
    return name;
  }

  /**
   * Joins the suggestion session of a Markdown file, or starts one with a blank document.
   * Opens run one at a time, so two cannot take the same name.
   */
  function open(file?: string): Promise<Entry> {
    const task = opening.catch(() => {}).then(() => openNow(file));
    opening = task;
    return task;
  }

  async function openNow(file?: string): Promise<Entry> {
    if (!vscode.workspace.isTrusted)
      throw new Error("The suggest view requires a trusted workspace.");
    if (file === undefined) return load(await uniqueName("scratch"));
    const problem = await markdownFile(file);
    if (problem) throw new Error(problem);
    const real = await fs.realpath(file);
    if (!(await allowed(real)))
      throw new Error("The document is outside the open workspace.");
    for (const name of await sessionNames())
      if ((await storedDocument(name)) === real) return load(name);
    const entry = await load(await uniqueName(path.parse(real).name));
    const error = await entry.session.setDocument(real);
    if (error) throw new Error(error);
    return entry;
  }

  function show(entry: Entry, restored?: vscode.WebviewPanel): void {
    if (entry.panel) {
      if (restored) restored.dispose();
      entry.panel.reveal();
      return;
    }
    const title = `Suggest: ${entry.session.name}`;
    const options = {
      enableScripts: true,
      localResourceRoots: [context.extensionUri],
    };
    // VS Code revives restored tabs only once they show; replace this session's unrevived tab.
    const stale = restored
      ? []
      : vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .filter(
            (tab) =>
              tab.input instanceof vscode.TabInputWebview &&
              tab.input.viewType.endsWith(VIEW) &&
              tab.label === title,
          );
    const panel =
      restored ??
      vscode.window.createWebviewPanel(
        VIEW,
        title,
        stale[0]?.group.viewColumn ?? vscode.ViewColumn.Active,
        { ...options, retainContextWhenHidden: true },
      );
    if (stale.length) void vscode.window.tabGroups.close(stale);
    panel.title = title;
    panel.webview.options = options;
    entry.panel = panel;
    panel.webview.html = webviewHtml(
      vscode,
      panel.webview,
      context.extensionUri,
    );
    const subscriptions = [
      panel.webview.onDidReceiveMessage((message: unknown) =>
        handle(entry, message),
      ),
    ];
    panel.onDidDispose(() => {
      subscriptions.forEach((s) => s.dispose());
      if (entry.panel === panel) entry.panel = undefined;
    });
  }

  async function approve(
    entry: Entry,
    id: string,
    fingerprint: string,
  ): Promise<void> {
    if (!vscode.workspace.isTrusted)
      throw new Error("Approval requires a trusted workspace.");
    const session = entry.session;
    const find = async (document: string): Promise<Block | undefined> => {
      const { blocks } = parseBlocks(document);
      await resolveBlocks(blocks, blockContext(session.documentPath));
      return blocks.find((b) => b.ref?.id === id);
    };
    const check = (diff: FileDiff): void => {
      if (entry.closed)
        throw new Error("The session was deleted. Nothing was staged.");
      if (unsaved(session.documentPath))
        throw new Error(
          "The document has unsaved changes in an editor. Save them first.",
        );
      if (unsaved(path.join(diff.root, diff.file)))
        throw new Error(`Save ${diff.file} before approving.`);
    };
    // Staging and the approval mark happen in one session edit, so no accept replaces the block in between.
    await session.edit(async (document) => {
      const block = await find(document);
      if (
        !block?.diff ||
        !block.cores ||
        !block.groups ||
        block.approved ||
        block.fingerprint !== fingerprint
      )
        throw new Error(
          "The block changed. Review the updated diff before staging.",
        );
      const diff: FileDiff = block.diff;
      const cores: Core[] = block.cores;
      const groups = block.groups;
      check(diff);
      const task = stagingWrites
        .catch(() => {})
        .then(() =>
          stageCores(
            diff,
            cores,
            async () => {
              check(diff);
              // The approval mark goes into this text; refuse if it changed, before anything is staged.
              const current = await session.readDocument();
              if (current !== document)
                throw new Error("The document changed. Nothing was staged.");
              const fresh = await find(current);
              if (fresh?.fingerprint !== fingerprint || fresh.approved)
                throw new Error(
                  "Content changed before the changes could be staged.",
                );
            },
            () => {
              if (entry.closed)
                throw new Error("The session was deleted. Nothing was staged.");
            },
          ),
        );
      stagingWrites = task;
      await task;
      if (entry.closed)
        throw new Error("The session was deleted after staging.");
      return setApproval(document, id, groups);
    });
  }

  async function handle(entry: Entry, raw: unknown): Promise<void> {
    const message = decodePageMessage(raw);
    if (!message) return;
    const session = entry.session;
    if (message.type === "ready") {
      post(entry, session.status());
      return render(entry);
    }
    let error: string | undefined;
    try {
      switch (message.type) {
        case "malformed":
          error = "Malformed message.";
          break;
        case "accept":
          error = await session.accept(message.id, message.fingerprint);
          break;
        case "request": {
          const { call: _call, ...request } = message;
          error = await session.request(request);
          break;
        }
        case "cancel":
          error = await session.withdraw(message.id);
          break;
        case "open":
          await vscode.window.showTextDocument(
            vscode.Uri.file(session.documentPath),
            { viewColumn: entry.panel?.viewColumn ?? vscode.ViewColumn.Active },
          );
          break;
        case "source":
        case "diff":
          await navigate(entry, message);
          break;
        case "approve":
          await approve(entry, message.block, message.fingerprint);
          break;
        case "unapprove":
          await session.edit(async (document) =>
            setApproval(document, message.block, undefined),
          );
          break;
      }
    } catch (failure) {
      error = (failure as Error).message;
    }
    post(entry, { type: "reply", call: message.call, ...(error && { error }) });
  }

  async function capture(entry: Entry, input: CaptureInput): Promise<object> {
    if (!Array.isArray(input.files) || !input.files.length)
      throw new Error("files must list at least one file.");
    const documentPath = entry.session.documentPath;
    const { blocks } = parseBlocks(await entry.session.readDocument());
    await resolveBlocks(blocks, blockContext(documentPath));
    const results: object[] = [];
    for (const { file, ranges } of input.files) {
      const problems: string[] = [];
      try {
        if (typeof file !== "string" || !path.isAbsolute(file))
          throw new Error(`Use an absolute file path: ${String(file)}`);
        const real = path.join(
          await fs.realpath(path.dirname(file)),
          path.basename(file),
        );
        const root = await repositoryOf(path.dirname(real));
        if (!(await allowed(root)))
          throw new Error("The file is outside the open workspace.");
        const relative = path.relative(root, real).split(path.sep).join("/");
        const diff = await liveDiff(root, relative);
        const taken = blocks.flatMap((b) =>
          b.root === root &&
          b.ref?.file === relative &&
          b.ref.id !== input.block &&
          b.cores
            ? b.cores.map((core) => ({ core, id: b.ref!.id }))
            : [],
        );
        let cores: Core[];
        if (ranges?.length) {
          const parsed = rangeCores(diff, ranges);
          problems.push(...parsed.problems);
          cores = [];
          for (const core of parsed.cores) {
            const other =
              taken.find((t) => overlaps(core, t.core, diff))?.id ??
              (cores.some((c) => overlaps(core, c, diff))
                ? "this call"
                : undefined);
            if (other)
              problems.push(
                `Lines ${describe(diff, core)} overlap ${other === "this call" ? "another range" : `block ${other}`}.`,
              );
            else cores.push(core);
          }
        } else
          cores = uncoveredCores(
            diff,
            taken.map((t) => t.core),
          );
        const spans: (Span & { shows: string })[] = [];
        const captured: Core[] = [];
        for (const core of cores) {
          const span = diff.span(core);
          if (span) {
            spans.push({ ...span, shows: describe(diff, core) });
            captured.push(core);
          } else
            problems.push(
              `Lines ${describe(diff, core)} repeat too often to anchor uniquely.`,
            );
        }
        const repo =
          path
            .relative(path.dirname(documentPath), root)
            .split(path.sep)
            .join("/") || ".";
        results.push({
          file,
          ...(spans.length && {
            block: {
              repo,
              file: relative,
              spans: spans.map(({ shows: _shows, ...span }) => span),
            },
            shows: spans.map((s) => s.shows),
            inspection: captureInspection(diff, spans, captured),
          }),
          ...(!ranges?.length && !spans.length && { covered: true }),
          ...(problems.length && { problems }),
        });
      } catch (error) {
        results.push({
          file,
          problems: [...problems, (error as Error).message],
        });
      }
    }
    return { files: results };
  }

  function describe(diff: FileDiff, [s, e]: Core): string {
    const lines = diff.lines.slice(s, e + 1).filter((l) => l.kind !== " ");
    const range = (numbers: number[]): string =>
      numbers.length
        ? numbers[0] === numbers.at(-1)
          ? `${numbers[0]}`
          : `${numbers[0]}-${numbers.at(-1)}`
        : "";
    const added = range(lines.flatMap((l) => (l.kind === "+" ? [l.new!] : [])));
    const removed = range(
      lines.flatMap((l) => (l.kind === "-" ? [l.old!] : [])),
    );
    return [added, removed && `old:${removed}`].filter(Boolean).join(", ");
  }

  async function deleteSessions(): Promise<void> {
    const names = await sessionNames();
    if (!names.length) {
      void vscode.window.showInformationMessage(
        "There are no suggest sessions.",
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      await Promise.all(
        names.map(async (name) => {
          const document = await storedDocument(name);
          return {
            label: name,
            description: document
              ? vscode.workspace.asRelativePath(document)
              : "Dictation",
          };
        }),
      ),
      { canPickMany: true, placeHolder: "Choose the sessions to delete" },
    );
    for (const { label } of picked ?? []) {
      const entry =
        entries.get(label) ??
        (await loading.get(label)?.catch(() => undefined));
      if (entry) {
        entry.closed = true;
        entry.panel?.dispose();
        entry.session.close();
        entry.watchers.dispose();
        entries.delete(label);
      }
      // Only session state goes: suggestions and the scratch file, never the opened document.
      await fs.rm(path.join(storage, label), { recursive: true, force: true });
    }
  }

  async function openCommand(uri?: unknown): Promise<void> {
    let file: string | undefined;
    if (uri instanceof vscode.Uri) file = uri.fsPath;
    else {
      const editor = vscode.window.activeTextEditor?.document;
      if (editor?.languageId === "markdown" && editor.uri.scheme === "file")
        file = editor.uri.fsPath;
      else {
        const names = await sessionNames();
        const picked = await vscode.window.showQuickPick(
          [
            { label: "New suggestion session", name: undefined },
            ...(await Promise.all(
              names.map(async (name) => {
                const document = await storedDocument(name);
                return {
                  label: name,
                  description: document
                    ? vscode.workspace.asRelativePath(document)
                    : "Blank document",
                  name,
                };
              }),
            )),
          ],
          { placeHolder: "Open a suggestion session" },
        );
        if (!picked) return;
        if (picked.name) return show(await load(picked.name));
      }
    }
    show(await open(file));
  }

  function run(task: () => Promise<void>): Promise<void> {
    return task().catch((error: unknown) => {
      void vscode.window.showErrorMessage(
        `Suggest view: ${(error as Error).message}`,
      );
    });
  }

  function result(value: unknown): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(value)),
    ]);
  }

  // Inputs are untrusted JSON; each handler checks the fields it uses.
  const tools: [
    string,
    string,
    (input: never, token: vscode.CancellationToken) => Promise<unknown>,
  ][] = [
    [
      "listSessions",
      "Listing suggestion sessions",
      async () =>
        Promise.all(
          (await sessionNames()).map(async (name) => ({
            session: name,
            document:
              (await storedDocument(name)) ??
              path.join(storage, name, "document.md"),
            open: !!entries.get(name)?.panel,
          })),
        ),
    ],
    [
      "openSession",
      "Opening a suggestion session",
      async (input: { path?: unknown } | undefined) => {
        if (input?.path !== undefined && typeof input.path !== "string")
          throw new Error("path must be a string.");
        const entry = await open(input?.path);
        show(entry);
        return {
          session: entry.session.name,
          document: entry.session.documentPath,
        };
      },
    ],
    [
      "waitForFeedback",
      "Waiting for the reader",
      async (input: SessionInput & { timeoutSeconds?: number }, token) => {
        const entry = await named(input);
        const seconds =
          typeof input.timeoutSeconds === "number"
            ? Math.min(600, Math.max(1, input.timeoutSeconds))
            : 60;
        const key = ++waits;
        const listener = token.onCancellationRequested(() =>
          entry.session.cancel(key),
        );
        try {
          const events = await entry.session.wait(key, seconds * 1000);
          return {
            session: entry.session.name,
            document: entry.session.documentPath,
            events,
            suggestions: await entry.session.list(),
          };
        } finally {
          listener.dispose();
        }
      },
    ],
    [
      "addSuggestions",
      "Adding suggestions",
      async (input: SessionInput & { suggestions?: unknown }) => {
        if (!Array.isArray(input.suggestions))
          throw new Error("suggestions must be an array.");
        return (await named(input)).session.add(input.suggestions);
      },
    ],
    [
      "removeSuggestions",
      "Removing suggestions",
      async (input: SessionInput & { ids?: unknown }) => {
        const ids = input.ids;
        if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
          throw new Error("ids must be an array of strings.");
        return (await named(input)).session.remove(ids);
      },
    ],
    [
      "listSuggestions",
      "Listing suggestions",
      async (input: SessionInput) => (await named(input)).session.list(),
    ],
    [
      "captureCodeChanges",
      "Capturing code changes",
      async (input: CaptureInput) => capture(await named(input), input),
    ],
  ];
  for (const [name, message, invoke] of tools)
    context.subscriptions.push(
      vscode.lm.registerTool(`guidedReview_${name}`, {
        prepareInvocation: () => ({ invocationMessage: message }),
        async invoke(options, token) {
          return result(await invoke(options.input as never, token));
        },
      }),
    );

  function rehighlight(): void {
    syntax.invalidate();
    for (const entry of entries.values()) entry.session.refresh();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "layoutSuggest.openSession",
      (uri?: unknown) => run(() => openCommand(uri)),
    ),
    vscode.commands.registerCommand("layoutSuggest.deleteSession", () =>
      run(deleteSessions),
    ),
    vscode.window.registerWebviewPanelSerializer(VIEW, {
      async deserializeWebviewPanel(panel, state: unknown) {
        const name = (state as { session?: unknown } | undefined)?.session;
        if (!validName(name) || !(await sessionNames()).includes(name)) {
          panel.dispose();
          return;
        }
        show(await load(name), panel);
      },
    }),
    vscode.window.onDidChangeActiveColorTheme(rehighlight),
    vscode.extensions.onDidChange(rehighlight),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        [
          "workbench.colorTheme",
          "workbench.colorCustomizations",
          "editor.tokenColorCustomizations",
          "files.associations",
          "guidedCodeReview.syntaxHighlighting",
        ].some((key) => event.affectsConfiguration(key))
      )
        rehighlight();
    }),
    {
      dispose() {
        for (const entry of entries.values()) {
          entry.session.close();
          entry.watchers.dispose();
        }
      },
    },
  );
}

function webviewHtml(
  vscode: typeof import("vscode"),
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  function asset(...parts: string[]): string {
    return escape(
      webview
        .asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts))
        .toString(),
    );
  }
  const nonce = crypto.randomBytes(20).toString("hex");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; connect-src 'none'; base-uri 'none'; form-action 'none';">
<link rel="stylesheet" href="${asset("media", "suggest.css")}"></head>
<body><header class="toolbar"><strong>Suggestions</strong><span id="document-name"></span><span id="status">Loading…</span>
<span id="agent" data-state="away">No agent</span>
<button id="open-document" class="secondary">Open document</button></header>
<main><article id="document" class="markdown"></article><aside id="suggestions"></aside></main>
<form id="prompt"><div id="selection" hidden><span id="selection-source"></span><span id="selection-text"></span>
<button type="button" id="selection-clear" aria-label="Clear selection">×</button></div>
<div class="prompt-row"><input id="prompt-text" type="text" autocomplete="off" placeholder="Optional guidance for the next suggestions (select text to refer to it)">
<span id="declined"></span><button id="prompt-send">Suggest</button></div></form>
<script id="client" nonce="${nonce}" type="module" src="${asset("out", "media", "suggest.mjs")}"
  data-mermaid="${asset("node_modules", "mermaid", "dist", "mermaid.esm.min.mjs")}"></script></body></html>`;
}
