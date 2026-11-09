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
