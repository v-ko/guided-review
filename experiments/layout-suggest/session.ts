import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  PromptMessage,
  RenderMessage,
  SuggestionSummary,
} from "./protocol.js";
import { renderMarkdown } from "./render.js";
import {
  applySuggestion,
  checkSuggestion,
  resolve,
  type Suggestion,
} from "./suggestions.js";

export type Feedback = { type: "accepted"; id: string } | PromptMessage;

export interface AddResult {
  added: string[];
  /** Index into the submitted list. */
  rejected: { index: number; problems: string[] }[];
}

interface Store {
  nextId: number;
  suggestions: Suggestion[];
}

function summarize(document: string, s: Suggestion): SuggestionSummary {
  return {
    id: s.id,
    from: s.from,
    to: s.to,
    after: s.after,
    problems: resolve(document, s).problems,
  };
}

/** The document file, agent suggestions and reader feedback. Emits "change". */
export class Session extends EventEmitter {
  readonly documentPath: string;
  private readonly storePath: string;
  private store: Store = { nextId: 1, suggestions: [] };
  private feedback: Feedback[] = [];
  private waiters = new Map<string | number, (events: Feedback[]) => void>();
  private queue = Promise.resolve<unknown>(undefined);
  private watcher?: fs.FSWatcher;
  private debounce?: NodeJS.Timeout;

  constructor(readonly dir: string) {
    super();
    this.documentPath = path.join(dir, "document.md");
    this.storePath = path.join(dir, "suggestions.json");
  }

  async start(): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.appendFile(this.documentPath, "");
    try {
      const saved = JSON.parse(
        await fs.promises.readFile(this.storePath, "utf8"),
      ) as Store;
      if (typeof saved.nextId === "number" && Array.isArray(saved.suggestions))
        this.store = saved;
    } catch {
      // No saved suggestions yet.
    }
    // Watch the directory: editors may replace files instead of writing in place.
    this.watcher = fs.watch(this.dir, (_event, file) => {
      if (file && file !== path.basename(this.documentPath)) return;
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.emit("change"), 50);
    });
  }

  close(): void {
    this.watcher?.close();
    clearTimeout(this.debounce);
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private readDocument(): Promise<string> {
    return fs.promises.readFile(this.documentPath, "utf8");
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
    return {
      type: "render",
      fingerprint: this.fingerprint(document),
      document: renderMarkdown(document),
      suggestions: this.store.suggestions.map((s) => ({
        ...summarize(document, s),
        html: renderMarkdown(s.replacement),
      })),
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
      const suggestion = this.store.suggestions.find((s) => s.id === id);
      if (!suggestion) return `Unknown suggestion ${id}.`;
      const { span, problems } = resolve(document, suggestion);
      if (!span) return problems.join(" ");
      await fs.promises.writeFile(
        this.documentPath,
        applySuggestion(document, span, suggestion.replacement),
      );
      this.store.suggestions = this.store.suggestions.filter(
        (s) => s !== suggestion,
      );
      await this.save();
      this.push({ type: "accepted", id });
      return undefined;
    });
  }

  prompt(message: PromptMessage): void {
    this.push(message);
  }

  /** Empties the document and suggestions and drops feedback about them. */
  clear(): Promise<void> {
    return this.serial(async () => {
      await fs.promises.writeFile(this.documentPath, "");
      this.store.suggestions = [];
      this.feedback = [];
      await this.save();
    });
  }

  private push(event: Feedback): void {
    this.feedback.push(event);
    const [first] = this.waiters;
    if (!first) return;
    this.waiters.delete(first[0]);
    first[1](this.feedback.splice(0));
  }

  /** Resolves with pending feedback, or an empty list after the timeout. */
  wait(key: string | number, timeoutMs: number): Promise<Feedback[]> {
    if (this.feedback.length) return Promise.resolve(this.feedback.splice(0));
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        done([]);
      }, timeoutMs);
      this.waiters.set(key, (events) => {
        clearTimeout(timer);
        done(events);
      });
    });
  }

  /** Drops a cancelled wait so it cannot consume feedback. */
  cancel(key: string | number): void {
    this.waiters.get(key)?.([]);
    this.waiters.delete(key);
  }
}
