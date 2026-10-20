/**
 * Simulation Ledger
 *
 * Virtual credit balance used in simulation mode. Every cost (inference,
 * domains, transfers) and every simulated sale is recorded here instead of
 * touching real USDC or Conway credits.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";

type Database = BetterSqlite3.Database;

export type LedgerEntryKind = "seed" | "inference" | "revenue" | "expense" | "blocked";

export interface LedgerEntry {
  id: string;
  kind: LedgerEntryKind;
  /** Signed amount in cents: positive = income, negative = cost. */
  amountCents: number;
  note: string;
  createdAt: string;
}

export interface LedgerSummary {
  balanceCents: number;
  revenueCents: number;
  inferenceCents: number;
  expenseCents: number;
  seedCents: number;
  /** Revenue minus all costs (seed excluded). */
  profitCents: number;
  sales: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS simulation_ledger (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    amount_cents REAL NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_simulation_ledger_kind ON simulation_ledger(kind);
`;

export class SimulationLedger {
  constructor(private readonly db: Database) {
    db.exec(SCHEMA);
  }

  /** Seed the starting balance once. Later calls are no-ops. */
  seed(startingCents: number): void {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM simulation_ledger WHERE kind = 'seed'")
      .get() as { n: number };
    if (row.n > 0) return;
    this.record("seed", startingCents, "Starting virtual balance");
  }

  record(kind: LedgerEntryKind, amountCents: number, note = ""): LedgerEntry {
    const entry: LedgerEntry = {
      id: ulid(),
      kind,
      amountCents,
      note,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO simulation_ledger (id, kind, amount_cents, note, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(entry.id, entry.kind, entry.amountCents, entry.note, entry.createdAt);
    return entry;
  }

  getBalanceCents(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM simulation_ledger")
      .get() as { total: number };
    return Math.max(0, row.total);
  }

  /**
   * Debit a cost. Fails without recording when the balance is too low,
   * so a simulated automaton cannot go into debt.
   */
  debit(kind: Exclude<LedgerEntryKind, "seed" | "revenue">, amountCents: number, note: string): boolean {
    if (amountCents <= 0) return true;
    if (this.getBalanceCents() < amountCents) return false;
    this.record(kind, -amountCents, note);
    return true;
  }

  /** Like debit, but always records the cost, clamping at the remaining balance. */
  charge(kind: "inference" | "expense", amountCents: number, note: string): void {
    if (amountCents <= 0) return;
    const charged = Math.min(amountCents, this.getBalanceCents());
    if (charged > 0) this.record(kind, -charged, note);
  }

  credit(amountCents: number, note: string): void {
    if (amountCents <= 0) return;
    this.record("revenue", amountCents, note);
  }

  summary(): LedgerSummary {
    const rows = this.db
      .prepare(
        "SELECT kind, COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS n FROM simulation_ledger GROUP BY kind",
      )
      .all() as { kind: LedgerEntryKind; total: number; n: number }[];
    const by = (k: LedgerEntryKind) => rows.find((r) => r.kind === k);
    const revenueCents = by("revenue")?.total ?? 0;
    const inferenceCents = -(by("inference")?.total ?? 0);
    const expenseCents = -(by("expense")?.total ?? 0);
    return {
      balanceCents: this.getBalanceCents(),
      revenueCents,
      inferenceCents,
      expenseCents,
      seedCents: by("seed")?.total ?? 0,
      profitCents: revenueCents - inferenceCents - expenseCents,
      sales: by("revenue")?.n ?? 0,
    };
  }

  recent(limit = 20): LedgerEntry[] {
    return (
      this.db
        .prepare(
          "SELECT id, kind, amount_cents, note, created_at FROM simulation_ledger ORDER BY id DESC LIMIT ?",
        )
        .all(limit) as { id: string; kind: LedgerEntryKind; amount_cents: number; note: string; created_at: string }[]
    ).map((r) => ({
      id: r.id,
      kind: r.kind,
      amountCents: r.amount_cents,
      note: r.note,
      createdAt: r.created_at,
    }));
  }
}
