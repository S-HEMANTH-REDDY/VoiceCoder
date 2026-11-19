// Transaction log for reversible editing. Every VoiceCoder change (single edit, rename,
// multi-file agent step) is one transaction holding the exact before/after text of each
// touched document plus the version it produced. Undo restores `before` only if the
// document still matches `after` — so undo can never clobber edits the developer made
// by hand afterwards. When it no longer matches, undo refuses and explains why.

export interface DocumentSnapshot {
  uri: string;
  before: string;
  after: string;
  /** True when the transaction created the file. Undo deletes it. */
  created?: boolean;
}

export interface Transaction {
  id: string;
  label: string;
  at: number;
  docs: DocumentSnapshot[];
  state: 'applied' | 'undone';
}

export type UndoCheck = { ok: true } | { ok: false; reason: string; uri: string };

export interface TextStore {
  read(uri: string): Promise<string | undefined>;
}

export class TransactionLog {
  private readonly items: Transaction[] = [];
  /** Undone transactions, most recent last. Cleared when a new change is recorded. */
  private redoStack: Transaction[] = [];
  private seq = 0;

  constructor(private readonly limit = 50) {}

  record(label: string, docs: DocumentSnapshot[]): Transaction {
    const tx: Transaction = { id: `tx-${++this.seq}`, label, at: Date.now(), docs, state: 'applied' };
    this.items.push(tx);
    this.redoStack = [];
    if (this.items.length > this.limit) this.items.shift();
    return tx;
  }

  /** Most recent applied transaction. */
  peek(): Transaction | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i]!.state === 'applied') return this.items[i];
    return undefined;
  }

  /** Most recently undone transaction, if no new change was recorded since. */
  peekRedo(): Transaction | undefined {
    return this.redoStack.at(-1);
  }

  get(id: string): Transaction | undefined {
    return this.items.find((t) => t.id === id);
  }

  all(): readonly Transaction[] {
    return this.items;
  }

  /** Verifies every touched document is unchanged since the transaction was applied. */
  async canUndo(tx: Transaction, store: TextStore): Promise<UndoCheck> {
    for (const d of tx.docs) {
      const current = await store.read(d.uri);
      if (current === undefined && !d.created) return { ok: false, uri: d.uri, reason: 'The file no longer exists.' };
      if (current !== undefined && current !== d.after) {
        return { ok: false, uri: d.uri, reason: 'The file was edited after this change, so undoing it could overwrite your work.' };
      }
    }
    return { ok: true };
  }

  async canRedo(tx: Transaction, store: TextStore): Promise<UndoCheck> {
    for (const d of tx.docs) {
      const current = await store.read(d.uri);
      if (d.created ? current !== undefined && current !== '' : current !== d.before) {
        return { ok: false, uri: d.uri, reason: 'The file changed since the undo.' };
      }
    }
    return { ok: true };
  }

  markUndone(tx: Transaction): void {
    tx.state = 'undone';
    this.redoStack = this.redoStack.filter((t) => t !== tx);
    this.redoStack.push(tx);
  }

  markApplied(tx: Transaction): void {
    tx.state = 'applied';
    this.redoStack = this.redoStack.filter((t) => t !== tx);
  }
}
