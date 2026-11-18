import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

const NANODOLLARS_PER_USD = 1_000_000_000n;

export function defaultSpendStateFile(): string {
  return join(homedir(), '.lens-mcp', 'spend-state.json');
}

/**
 * Parses a USD money string such as '$1.00', '1.00' or '$0.05' into integer
 * nanodollars. Throws on anything that is not a non-negative USD amount: a
 * malformed ceiling must stop the server at boot rather than leave it running
 * with an unintended budget.
 */
export function parseUsdToNanodollars(money: string): bigint {
  const cleaned = String(money).trim().replace(/^\$/, '');
  const match = /^(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) {
    throw new Error(`Invalid USD amount: ${JSON.stringify(money)}. Expected a non-negative amount such as "$1.00".`);
  }
  const fraction = match[2] ?? '';
  if (fraction.length > 9) {
    throw new Error(`USD amount ${JSON.stringify(money)} has more than 9 decimal places; nanodollar precision is the finest the budget can track.`);
  }
  return BigInt(match[1]) * NANODOLLARS_PER_USD + BigInt(fraction.padEnd(9, '0') || '0');
}

function formatUsd(nanodollars: bigint): string {
  const whole = nanodollars / NANODOLLARS_PER_USD;
  const fraction = (nanodollars % NANODOLLARS_PER_USD).toString().padStart(9, '0').replace(/0+$/, '');
  // Show cents at minimum; keep finer precision only when the amount actually has it.
  return `$${whole}.${fraction.padEnd(2, '0')}`;
}

function utcDayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function nextUtcMidnightIso(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString();
}

export interface BudgetSnapshot {
  currency: 'USD';
  window: 'utc_day';
  /** Current UTC day this window covers, e.g. '2026-10-17'. */
  day: string;
  perCallMax: string;
  dailyCeiling: string;
  spentToday: string;
  /** Worst-case value of paid calls that are in flight right now. */
  reservedToday: string;
  remainingToday: string;
  resetsAt: string;
  /** 'unavailable' once state could not be read or written; paid calls are then refused. */
  state: 'ok' | 'unavailable';
}

export interface SpendBudgetOptions {
  /** Ceiling for a single payment, e.g. '$1.00'. */
  perCallMax: string;
  /** Cumulative ceiling for the current UTC day, e.g. '$10.00'. */
  dailyCeiling: string;
  /** Where the running total is persisted. Omit to keep it in memory only. */
  stateFilePath?: string;
  now?: () => Date;
}

export type BudgetDecision =
  | { allowed: true; reservationId: number; snapshot: BudgetSnapshot }
  | { allowed: false; snapshot: BudgetSnapshot; reason: string };

interface PersistedSpendState {
  version: 1;
  day: string;
  spentNanodollars: string;
}

/**
 * Cumulative spend ceiling for paid calls, per UTC day.
 *
 * A per-call maximum only bounds what one mistake can cost; this bounds what a
 * day of mistakes can cost. The window is a UTC calendar day rather than a
 * sliding 24 hours because it answers the operator's question directly ("how
 * much can today cost"), needs a single stored number instead of one entry per
 * payment, and rolls over from the wall clock, so a restarted server resumes
 * the same day's total and resets it after 00:00 UTC.
 *
 * Accounting is conservative. A payment's real price is only known inside the
 * x402 transport, which hands back a plain Response, so a paid call that could
 * have settled debits the per-call maximum. Recorded spend is therefore an
 * upper bound: the ceiling is never reached late, only early.
 */
export class SpendBudget {
  readonly perCallMaxNanodollars: bigint;
  readonly dailyCeilingNanodollars: bigint;

  private readonly stateFilePath?: string;
  private readonly now: () => Date;
  private day: string;
  private spentNanodollars = 0n;
  private reservedNanodollars = 0n;
  private readonly holds = new Map<number, bigint>();
  private nextHoldId = 1;
  private state: 'ok' | 'unavailable' = 'ok';
  private stateUnavailableReason = '';

  constructor(options: SpendBudgetOptions) {
    this.now = options.now ?? (() => new Date());
    this.perCallMaxNanodollars = parseUsdToNanodollars(options.perCallMax);
    this.dailyCeilingNanodollars = parseUsdToNanodollars(options.dailyCeiling);
    if (this.perCallMaxNanodollars <= 0n) {
      throw new Error(`perCallMax must be greater than zero, got ${JSON.stringify(options.perCallMax)}.`);
    }
    if (this.perCallMaxNanodollars > this.dailyCeilingNanodollars) {
      throw new Error(
        `perCallMax ${JSON.stringify(options.perCallMax)} exceeds dailyCeiling ${JSON.stringify(options.dailyCeiling)}; ` +
        'no paid call would ever be allowed. Raise the ceiling or lower the per-call maximum.'
      );
    }
    this.day = utcDayOf(this.now());
    this.stateFilePath = options.stateFilePath;
    if (this.stateFilePath) {
      this.loadState();
    }
  }

  /**
   * Decides whether a paid call may start, and holds its worst case against the
   * ceiling while it is in flight. Refuses when the remaining budget cannot
   * cover a call priced at the per-call maximum.
   */
  authorize(): BudgetDecision {
    this.rollWindowIfNeeded();
    if (this.state === 'unavailable') {
      return {
        allowed: false,
        snapshot: this.snapshot(),
        reason:
          `Refusing a paid call because the spend budget cannot be trusted (${this.stateUnavailableReason}). ` +
          'Fix the state file, then restart the server to resume paid calls.',
      };
    }
    if (this.spentNanodollars + this.reservedNanodollars + this.perCallMaxNanodollars > this.dailyCeilingNanodollars) {
      return {
        allowed: false,
        snapshot: this.snapshot(),
        reason:
          `Daily spend ceiling reached: ${formatUsd(this.spentNanodollars)} of ${formatUsd(this.dailyCeilingNanodollars)} spent today, ` +
          `leaving ${formatUsd(this.remainingNanodollars())} of a ceiling that must cover a call of up to ${formatUsd(this.perCallMaxNanodollars)}. ` +
          `The window resets at ${nextUtcMidnightIso(this.day)}.`,
      };
    }
    const reservationId = this.nextHoldId++;
    this.holds.set(reservationId, this.perCallMaxNanodollars);
    this.reservedNanodollars += this.perCallMaxNanodollars;
    return { allowed: true, reservationId, snapshot: this.snapshot() };
  }

  /** Books the held worst case as spent. Call when a payment may have settled. */
  commit(reservationId: number): void {
    const hold = this.holds.get(reservationId);
    if (!hold) {
      return;
    }
    this.holds.delete(reservationId);
    this.reservedNanodollars -= hold;
    const today = utcDayOf(this.now());
    if (today !== this.day) {
      // The window closed while the call was in flight, so the payment belongs to the
      // window that has just ended and must not be booked against the new day.
      this.day = today;
      this.spentNanodollars = 0n;
      this.holds.clear();
      this.reservedNanodollars = 0n;
      this.writeState();
      return;
    }
    this.spentNanodollars += hold;
    this.writeState();
  }

  /** Drops a hold when no payment settled, so the budget is not consumed. */
  release(reservationId: number): void {
    const hold = this.holds.get(reservationId);
    if (!hold) {
      return;
    }
    this.holds.delete(reservationId);
    this.reservedNanodollars -= hold;
  }

  snapshot(): BudgetSnapshot {
    return {
      currency: 'USD',
      window: 'utc_day',
      day: this.day,
      perCallMax: formatUsd(this.perCallMaxNanodollars),
      dailyCeiling: formatUsd(this.dailyCeilingNanodollars),
      spentToday: formatUsd(this.spentNanodollars),
      reservedToday: formatUsd(this.reservedNanodollars),
      remainingToday: formatUsd(this.remainingNanodollars()),
      resetsAt: nextUtcMidnightIso(this.day),
      state: this.state,
    };
  }

  /** Text for a tool description so an agent can reason about cost before calling. */
  describeLimits(): string {
    const snapshot = this.snapshot();
    return (
      `Payments are capped per call at ${snapshot.perCallMax} and cumulatively at ` +
      `${snapshot.dailyCeiling} per UTC day (${snapshot.day}, resetting at ${snapshot.resetsAt}). ` +
      `Recorded spend so far today: ${snapshot.spentToday}; remaining: ${snapshot.remainingToday}. ` +
      `A call that cannot fit its per-call maximum inside the remaining budget is refused with ` +
      `ERR_BUDGET_EXCEEDED before any payment is attempted.`
    );
  }

  private remainingNanodollars(): bigint {
    const remaining = this.dailyCeilingNanodollars - this.spentNanodollars;
    return remaining > 0n ? remaining : 0n;
  }

  private rollWindowIfNeeded(): void {
    const today = utcDayOf(this.now());
    if (today === this.day) {
      return;
    }
    this.day = today;
    this.spentNanodollars = 0n;
    this.holds.clear();
    this.reservedNanodollars = 0n;
    this.writeState();
  }

  private loadState(): void {
    const path = this.stateFilePath!;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.writeState();
        return;
      }
      this.degrade(`the spend state file at ${path} could not be read: ${(e as Error).message}`);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.degrade(`the spend state file at ${path} is not valid JSON`);
      return;
    }

    const state = parsed as Partial<PersistedSpendState>;
    const isValidDay = typeof state.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(state.day);
    const isValidSpend = typeof state.spentNanodollars === 'string' && /^\d+$/.test(state.spentNanodollars);
    if (state.version !== 1 || !isValidDay || !isValidSpend) {
      this.degrade(`the spend state file at ${path} does not contain a recognised budget state`);
      return;
    }

    const spentNanodollars = BigInt(state.spentNanodollars as string);
    if (state.day === utcDayOf(this.now())) {
      this.day = state.day as string;
      this.spentNanodollars = spentNanodollars;
    } else {
      this.day = utcDayOf(this.now());
      this.spentNanodollars = 0n;
      this.writeState();
    }
  }

  private writeState(): void {
    if (!this.stateFilePath) {
      return;
    }
    const payload: PersistedSpendState = {
      version: 1,
      day: this.day,
      spentNanodollars: this.spentNanodollars.toString(),
    };
    const tempPath = `${this.stateFilePath}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(this.stateFilePath), { recursive: true });
      writeFileSync(tempPath, JSON.stringify(payload), 'utf8');
      renameSync(tempPath, this.stateFilePath);
    } catch (e) {
      this.degrade(`the spend state file at ${this.stateFilePath} could not be written: ${(e as Error).message}`);
    }
  }

  /**
   * Fails closed. With unreadable or unwritable state the running total is
   * unknown, and an unknown total against a money ceiling is assumed spent.
   */
  private degrade(reason: string): void {
    this.state = 'unavailable';
    this.stateUnavailableReason = reason;
    this.spentNanodollars = this.dailyCeilingNanodollars;
    console.error(`[mcp-budget] ${reason}. Refusing paid calls until the state is recoverable.`);
  }
}
