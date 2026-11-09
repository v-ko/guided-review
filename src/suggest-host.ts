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
      async render(markdown, documentPath, approvable, preview) {
        const { html, blocks } = await renderMarkdown(
          markdown,
          blockContext(
            documentPath,
            approvable ? entry().positions : undefined,
          ),
          approvable,
          preview,
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
