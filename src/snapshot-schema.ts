/** Persisted snapshot data shared by capture, validation and review consumers. */
export type FileMode = "100644" | "100755" | null;

export interface Hunk {
  id: string;
  patch: string;
  oldStart: number;
  newStart: number;
}

export interface FileEntry {
  before: string | null;
  after: string | null;
  beforeMode: FileMode;
  afterMode: FileMode;
  afterHash: string;
  patch: string;
  hunks: Hunk[];
}

export interface CapturedRepository {
  root: string;
  baseSha: string | null;
  unbornBranch?: string;
  files: Record<string, FileEntry>;
}

export interface Snapshot {
  version: 1;
  createdAt: string;
  configHash: string;
  repos: Record<string, CapturedRepository>;
}
