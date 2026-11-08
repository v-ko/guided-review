import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentState,
  RenderMessage,
  RequestMessage,
  SelectedText,
  StatusMessage,
  SuggestionSummary,
} from "./suggest-protocol.js";
import {
  applySuggestion,
  checkSuggestion,
  resolve,
  type Suggestion,
} from "./suggestions.js";

/** A code block in the document whose spans no longer match the code. */
export interface OutdatedBlock {
  id: string;
  file: string;
  problems: string[];
}

/** Renders session Markdown; the host supplies code blocks, so the session stays editor-free. */
export interface Documents {
  /** approvable: the document itself, not a suggestion card. */
  render(
    markdown: string,
    documentPath: string,
    approvable: boolean,
  ): Promise<string>;
  outdated(markdown: string, documentPath: string): Promise<OutdatedBlock[]>;
  /** Whether an editor holds unsaved changes to the document. */
  unsaved(documentPath: string): boolean;
}

/** The reader asks for new suggestions, reporting what it did since the previous request. */
export interface Feedback {
  type: "request";
  text?: string;
  selection?: SelectedText;
  /** Id of the suggestion the reader selected; text refers to it. */
  selected?: string;
  /** Ids already applied to the document. */
  accepted?: string[];
  declined?: Suggestion[];
  outdated?: OutdatedBlock[];
}

export interface AddResult {
  added: string[];
  /** Index into the submitted list. */
  rejected: { index: number; problems: string[] }[];
}

interface Store {
  nextId: number;
  suggestions: Suggestion[];
  /** Absolute path of the file worked on; the scratch document when absent. */
  document?: string;
}

/** Why a path cannot be the worked-on document, if it cannot. */
export async function markdownFile(file: string): Promise<string | undefined> {
  if (!path.isAbsolute(file)) return `Use an absolute path: ${file}`;
  if (!/\.(md|markdown)$/i.test(file)) return `Not a Markdown file: ${file}`;
  const stat = await fs.promises.stat(file).catch(() => undefined);
  return stat?.isFile() ? undefined : `No such file: ${file}`;
}

function summarize(document: string, s: Suggestion): SuggestionSummary {
  return {
    id: s.id,
    from: s.from,
    to: s.to,
    after: s.after,
    kind: s.kind ?? "layout",
    problems: resolve(document, s).problems,
  };
}

/** The document file, agent suggestions and reader feedback. Emits "change" and "status". */
export class Session extends EventEmitter {
  /** For dictated text, used unless the session opened an existing file. */
  readonly scratchPath: string;
  private readonly storePath: string;
  private store: Store = { nextId: 1, suggestions: [] };
  private pending?: RequestMessage;
  private delivered?: string;
  private agent: AgentState = "away";
  private agentSince = Date.now();
  private accepted: string[] = [];
  private waiters = new Map<string | number, (events: Feedback[]) => void>();
  private queue = Promise.resolve<unknown>(undefined);
  private watcher?: fs.FSWatcher;
  private debounce?: NodeJS.Timeout;

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

  close(): void {
    this.watcher?.close();
    clearTimeout(this.debounce);
    for (const key of [...this.waiters.keys()]) this.cancel(key);
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  readDocument(): Promise<string> {
    return fs.promises.readFile(this.documentPath, "utf8");
  }

  /** Why the session cannot write the document now, if it cannot. */
  private blocked(): string | undefined {
    return this.documents.unsaved(this.documentPath)
      ? "The document has unsaved changes in an editor. Save them first."
      : undefined;
  }

  /** Writes the document, unless an editor holds unsaved changes or it changed on disk since it was read. */
  private async write(read: string, next: string): Promise<string | undefined> {
    const blocked = this.blocked();
    if (blocked) return blocked;
    if ((await this.readDocument()) !== read)
      return "The document changed while it was being edited. Nothing was written.";
    await fs.promises.writeFile(this.documentPath, next);
    return undefined;
  }

  private async save(): Promise<void> {
    await fs.promises.writeFile(
      this.storePath,
      JSON.stringify(this.store, null, 2),
    );
    this.emit("change");
  }

  private fingerprint(document: string): string {
    return createHash("sha256")
      .update(document)
      .update("\0")
      .update(JSON.stringify(this.store.suggestions))
      .digest("hex");
  }

  async view(): Promise<RenderMessage> {
    const document = await this.readDocument();
    const suggestions = this.store.suggestions;
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
    };
  }

  async list(): Promise<SuggestionSummary[]> {
    const document = await this.readDocument();
    return this.store.suggestions.map((s) => summarize(document, s));
  }

  /** Stores the valid suggestions on top, keeping their order; rejects the rest. */
  add(values: unknown[]): Promise<AddResult> {
    return this.serial(async () => {
      const document = await this.readDocument();
      const result: AddResult = { added: [], rejected: [] };
      const fresh: Suggestion[] = [];
      values.forEach((value, index) => {
        const { input, problems } = checkSuggestion(value);
        const all = input ? resolve(document, input).problems : problems;
        if (!input || all.length) {
          result.rejected.push({ index, problems: all });
          return;
        }
        const suggestion = { id: `s${this.store.nextId++}`, ...input };
        fresh.push(suggestion);
        result.added.push(suggestion.id);
      });
      if (fresh.length) {
        this.store.suggestions = [...fresh, ...this.store.suggestions];
        await this.save();
      }
      return result;
    });
  }

  remove(ids: string[]): Promise<{ removed: string[]; unknown: string[] }> {
    return this.serial(async () => {
      const removed = ids.filter((id) =>
        this.store.suggestions.some((s) => s.id === id),
      );
      this.store.suggestions = this.store.suggestions.filter(
        (s) => !ids.includes(s.id),
      );
      if (removed.length) await this.save();
      return { removed, unknown: ids.filter((id) => !removed.includes(id)) };
    });
  }

  /** Applies a suggestion the reader saw; returns an error message on refusal. */
  accept(id: string, fingerprint: string): Promise<string | undefined> {
    return this.serial(async () => {
      const document = await this.readDocument();
      if (this.fingerprint(document) !== fingerprint)
        return "The document or suggestions changed since this view was rendered.";
      const blocked = this.blocked();
      if (blocked) return blocked;
      const suggestion = this.store.suggestions.find((s) => s.id === id);
      if (!suggestion) return `Unknown suggestion ${id}.`;
      const { span, problems } = resolve(document, suggestion);
      if (!span) return problems.join(" ");
      const error = await this.write(
        document,
        applySuggestion(document, span, suggestion.replacement),
      );
      if (error) return error;
      this.store.suggestions = this.store.suggestions.filter(
        (s) => s !== suggestion,
      );
      await this.save();
      this.accepted.push(id);
      return undefined;
    });
  }

  /** Rewrites the document in turn with other session changes; edit returns the new text. */
  edit(edit: (document: string) => Promise<string>): Promise<void> {
    return this.serial(async () => {
      const blocked = this.blocked();
      if (blocked) throw new Error(blocked);
      const document = await this.readDocument();
      const next = await edit(document);
      if (next === document) return;
      const error = await this.write(document, next);
      if (error) throw new Error(error);
      this.emit("change");
    });
  }

  /** Queues the reader's request until an agent waits for it; returns an error message on refusal. */
  request(message: RequestMessage): Promise<string | undefined> {
    return this.serial(async () => {
      if (this.pending) return "Another request is waiting for the agent.";
      this.pending = message;
      this.emit("status");
      const [first] = this.waiters;
      if (first) {
        this.waiters.delete(first[0]);
        first[1](await this.deliver());
      }
      return undefined;
    });
  }

  /** Withdraws the request unless the agent already has it. */
  withdraw(id: string): Promise<string | undefined> {
    return this.serial(async () => {
      if (this.pending?.id !== id)
        return this.delivered === id
          ? "The agent already picked up this request."
          : "No such request.";
      this.pending = undefined;
      this.emit("status");
      return undefined;
    });
  }

  /** Hands the pending request to the agent, applying its declines then. */
  private async deliver(): Promise<Feedback[]> {
    const message = this.pending;
    if (!message) {
      this.setAgent(this.waiters.size ? "listening" : "away");
      return [];
    }
    this.pending = undefined;
    this.delivered = message.id;
    const declined = this.take(message.declined);
    if (declined.length) await this.save();
    const accepted = this.accepted.splice(0);
    const outdated = await this.documents
      .outdated(await this.readDocument(), this.documentPath)
      .catch(() => []);
    this.setAgent(this.waiters.size ? "listening" : "working");
    this.emit("status");
    const { text, selection, selected } = message;
    return [
      {
        type: "request",
        ...(text && { text }),
        ...(selection && { selection }),
        ...(selected && { selected }),
        ...(accepted.length ? { accepted } : {}),
        ...(declined.length ? { declined } : {}),
        ...(outdated.length ? { outdated } : {}),
      },
    ];
  }

  status(): StatusMessage {
    return {
      type: "status",
      agent: this.agent,
      since: this.agentSince,
      ...(this.pending && { pending: this.pending }),
      ...(this.delivered && { delivered: this.delivered }),
    };
  }

  private setAgent(state: AgentState): void {
    if (state === this.agent) return;
    this.agent = state;
    this.agentSince = Date.now();
    this.emit("status");
  }

  /** Removes declined suggestions; ids the agent already removed are skipped. */
  private take(ids: string[] = []): Suggestion[] {
    const taken = this.store.suggestions.filter((s) => ids.includes(s.id));
    this.store.suggestions = this.store.suggestions.filter(
      (s) => !taken.includes(s),
    );
    return taken;
  }

  /** Works on an existing Markdown file instead of the scratch document; returns an error message on refusal. */
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

  /** Resolves with the reader's request, or an empty list after the timeout. */
  wait(key: string | number, timeoutMs: number): Promise<Feedback[]> {
    if (this.pending) return this.serial(() => this.deliver());
    return new Promise((done) => {
      const timer = setTimeout(() => this.cancel(key), timeoutMs);
      this.waiters.set(key, (events) => {
        clearTimeout(timer);
        done(events);
      });
      this.setAgent("listening");
    });
  }

  /** Ends a wait without a request, so a cancelled one cannot consume it. */
  cancel(key: string | number): void {
    const waiter = this.waiters.get(key);
    if (!waiter) return;
    this.waiters.delete(key);
    if (!this.waiters.size) this.setAgent("away");
    waiter([]);
  }
}
