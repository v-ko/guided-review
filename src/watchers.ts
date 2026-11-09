import * as path from "node:path";
import type * as vscode from "vscode";
import { hash } from "./util.js";

/** Absolute paths whose changes can alter an open document: Git state files and shown sources. */
export interface WatchTargets {
  gitPaths: string[];
  files: string[];
}

/** File watchers of one open document. The owner serializes updates; changed targets replace the previous set. */
export class FileWatchers {
  /** URI strings of shown source files, for matching editor document events. */
  watchedFiles: ReadonlySet<string> = new Set();
  private readonly vscode: typeof import("vscode");
  private readonly changed: () => void;
  private watchers: vscode.Disposable[] = [];
  private signature?: string;
  private disposed = false;

  constructor(vscode: typeof import("vscode"), changed: () => void) {
    this.vscode = vscode;
    this.changed = changed;
  }

  async update(targets: Promise<WatchTargets>): Promise<void> {
    const { gitPaths, files } = await targets;
    const paths = new Set([...gitPaths, ...files]);
    const signature = hash(JSON.stringify([...paths].sort()));
    // Targets resolve asynchronously: a document closed meanwhile must not get late watchers.
    if (this.disposed || signature === this.signature) return;
    const watchers: vscode.Disposable[] = [];
    try {
      for (const target of paths) {
        const watcher = this.vscode.workspace.createFileSystemWatcher(
          new this.vscode.RelativePattern(
            this.vscode.Uri.file(path.dirname(target)),
            path.basename(target).replace(/[\[\]{}*?]/g, (c) => `[${c}]`),
          ),
        );
        watchers.push(
          watcher,
          watcher.onDidChange(this.changed),
          watcher.onDidCreate(this.changed),
          watcher.onDidDelete(this.changed),
        );
      }
    } catch (error) {
      watchers.forEach((watcher) => watcher.dispose());
      throw error;
    }
    this.watchers.forEach((watcher) => watcher.dispose());
    this.watchers = watchers;
    this.watchedFiles = new Set(
      files.map((file) => this.vscode.Uri.file(file).toString()),
    );
    this.signature = signature;
  }

  dispose(): void {
    this.disposed = true;
    this.watchers.forEach((watcher) => watcher.dispose());
    this.watchers = [];
  }
}
