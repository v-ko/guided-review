  constructor(
    readonly dir: string,
    private readonly documents: Documents,
  ) {
    super();
    this.scratchPath = path.join(dir, "document.md");
    this.storePath = path.join(dir, "suggestions.json");
  }

  get name(): string {
    return path.basename(this.dir);
  }

  get documentPath(): string {
    return this.store.document ?? this.scratchPath;
  }

  async start(): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.appendFile(this.scratchPath, "");
    try {
      const saved = JSON.parse(
        await fs.promises.readFile(this.storePath, "utf8"),
      ) as Store;
      if (typeof saved.nextId === "number" && Array.isArray(saved.suggestions))
        this.store = saved;
    } catch {
      // No saved suggestions yet.
    }
    if (this.store.document && (await markdownFile(this.store.document)))
      this.store = { nextId: this.store.nextId, suggestions: [] };
    this.watch();
  }

  private watch(): void {
    this.watcher?.close();
    const file = this.documentPath;
    // Watch the directory: editors may replace files instead of writing in place.
    this.watcher = fs.watch(path.dirname(file), (_event, name) => {
      if (name && name !== path.basename(file)) return;
      this.refresh();
    });
  }

  /** Asks for a new render, for example after code the document shows changed. */
  refresh(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.emit("change"), 50);
  }
  async view(): Promise<RenderMessage> {
    const document = await this.readDocument();
    const suggestions = this.store.suggestions;
    const comment = this.store.comment;
    return {
      type: "render",
      session: this.name,
      path: this.documentPath,
      fingerprint: this.fingerprint(document),
      document: await this.documents.render(document, this.documentPath, true),
      suggestions: await Promise.all(
        suggestions.map(async (s) => ({
          ...summarize(document, s),
          html: await this.documents.render(
            s.replacement,
            this.documentPath,
            false,
          ),
        })),
      ),
      ...(comment?.reply !== undefined && {
        comment: {
          revision: comment.revision ?? comment.reply,
          html: await this.documents.render(
            comment.reply,
            this.documentPath,
            false,
          ),
        },
      }),
    };
  }
  setDocument(file: string): Promise<string | undefined> {
    return this.serial(async () => {
      const problem = await markdownFile(file);
      if (problem) return problem;
      this.store = {
        nextId: this.store.nextId,
        suggestions: [],
        document: await fs.promises.realpath(file),
      };
      this.pending = undefined;
      this.accepted = [];
      this.watch();
      await this.save();
      this.emit("status");
      return undefined;
    });
  }
