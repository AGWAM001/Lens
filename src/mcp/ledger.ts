import { appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { Counter } from 'prom-client';
import { register } from '../metrics.js';
import type { McpErrorCode } from './codes.js';
import { parsePaidCallAllowlist } from './paidCallAllowlist.js';

export type PaymentOutcome = 'success' | 'failure';

/**
 * What the ledger can vouch for about the money itself, as distinct from the
 * outcome of the HTTP call. A call can fail after the payment settled, and a
 * call can succeed on a seller that never echoes its settlement.
 *
 * - `settled`: the settlement response confirmed the transaction.
 * - `possible`: a payment was offered and nothing proves it failed.
 * - `none`: nothing moved, or nothing was ever offered.
 */
export type PaymentSpend = 'settled' | 'possible' | 'none';

/** One line of the audit trail. Field names are stable; new fields are additive. */
export interface PaymentRecord {
  readonly timestamp: string;
  /** Full URL as called. Never shortened, never masked. */
  readonly url: string;
  readonly host: string;
  readonly method: string;
  /** Amount exactly as the seller offered it, e.g. `$0.10` or an atomic-unit string. */
  readonly amount: string | null;
  readonly asset: string | null;
  readonly network: string | null;
  readonly transactionHash: string | null;
  readonly outcome: PaymentOutcome;
  readonly spend: PaymentSpend;
  readonly errorCode: McpErrorCode | null;
}

export interface SpendSummary {
  readonly attempts: number;
  /** Confirmed spend, in integer nanodollars, as a decimal string for JSON safety. */
  readonly settledNanodollars: string;
  /**
   * Spend that cannot be ruled out, in integer nanodollars. A ceiling must add
   * this to {@link SpendSummary.settledNanodollars} to stay an upper bound: the
   * ledger records what is known, it does not prove what is absent.
   */
  readonly possibleNanodollars: string;
  /**
   * Recorded payments whose offer was not a USD money string, so they contribute
   * nothing to the totals above. A non-zero count means the totals understate
   * what was spent.
   */
  readonly unquantifiedPayments: number;
}

export interface PaymentLedgerConfig {
  /**
   * Append-only audit file. Omit to keep records in memory only, which is what
   * tests and embedders that do not want a file on disk get by default.
   */
  filePath?: string;
  /**
   * Hosts allowed to appear as the `host` label of a Prometheus series.
   *
   * Prometheus series are permanent, so a `host` label taken from whatever URL
   * an agent asks for lets one caller mint unbounded time series. Pass the
   * origins from {@link metricHostsFromPaidCallAllowlist} to use the operator's
   * paid_call allow-list as the label domain; anything else records as `unknown`.
   * The durable record always keeps the real host regardless of this list.
   */
  metricHosts?: readonly string[];
  /**
   * Networks allowed to appear as the `network` label. Anything else is
   * `unknown`. Defaults to {@link DEFAULT_PAYMENT_METRIC_NETWORKS}.
   */
  metricNetworks?: readonly string[];
  now?: () => Date;
}

/**
 * The network ids this server's signer can pay on, so they are the whole
 * `network` label domain. A label taken from whatever a seller echoes in a
 * header would mint a permanent time series per distinct string.
 */
export const DEFAULT_PAYMENT_METRIC_NETWORKS: readonly string[] = ['stellar:testnet', 'stellar:pubnet'];

const UNKNOWN_LABEL = 'unknown';
const NANODOLLARS_PER_USD = 1_000_000_000n;

/**
 * Caps on values that originate outside this process. The audit trail is written
 * with appendFileSync and read back by humans and tools, so an over-long or
 * newline-bearing field from a seller must not be able to forge extra records.
 */
const MAX_URL_CHARS = 2048;
const MAX_FIELD_CHARS = 256;

const paymentAttemptsTotal = new Counter({
  name: 'mcp_payment_attempts_total',
  help: 'Paid calls attempted through the MCP server, by host, network and outcome',
  labelNames: ['host', 'network', 'outcome'],
  registers: [register],
});

const paymentAmountUsdTotal = new Counter({
  name: 'mcp_payment_amount_usd_total',
  help: 'USD value of payments the MCP server made, by host and network. Only payments priced in USD are counted; see mcp_payment_unquantified_total.',
  labelNames: ['host', 'network'],
  registers: [register],
});

const paymentUnquantifiedTotal = new Counter({
  name: 'mcp_payment_unquantified_total',
  help: 'Payments recorded that could not be priced in USD, by host and network, so the USD total is known to understate spend',
  labelNames: ['host', 'network'],
  registers: [register],
});

export function defaultPaymentLedgerFile(): string {
  return join(homedir(), '.lens-mcp', 'payments.jsonl');
}

/**
 * The `host` label domain, taken from the same operator configuration that
 * decides which hosts `paid_call` may pay for. A call to anything else is
 * refused before a request is sent, so this set already bounds every host that
 * can appear in a record — no second allow-list to keep in sync.
 *
 * Entries that do not parse are dropped here as they are by the gate itself,
 * which matches nothing rather than matching everything.
 */
export function metricHostsFromPaidCallAllowlist(entries: readonly string[]): string[] {
  return [...new Set(parsePaidCallAllowlist(entries).rules.map((rule) => rule.origin))];
}

/**
 * Parses a USD money string such as '$1.00', '1.00' or '$0.05' into integer
 * nanodollars. Throws on anything that is not a non-negative USD amount, which
 * is how a payment priced in asset units is told apart from one priced in dollars.
 */
function usdOfferToNanodollars(money: string): bigint {
  const cleaned = String(money).trim().replace(/^\$/, '');
  const match = /^(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) {
    throw new Error(`Not a USD amount: ${JSON.stringify(money)}`);
  }
  const fraction = match[2] ?? '';
  if (fraction.length > 9) {
    throw new Error(`USD amount ${JSON.stringify(money)} has more than 9 decimal places`);
  }
  return BigInt(match[1]) * NANODOLLARS_PER_USD + BigInt(fraction.padEnd(9, '0') || '0');
}

function isUsdAmount(amount: string | null): boolean {
  if (amount === null) {
    return false;
  }
  try {
    usdOfferToNanodollars(amount);
    return true;
  } catch {
    return false;
  }
}

function boundedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...[truncated]` : trimmed;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // A paid call can still be attempted with a URL this process cannot parse;
    // the record must show what was asked for rather than drop the attempt.
    return UNKNOWN_LABEL;
  }
}

function decodeJsonHeader(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const json = Buffer.from(value.trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readJsonHeader(response: Response | undefined, names: readonly string[]): Record<string, unknown> | null {
  const headers = response?.headers;
  // A real Response always carries Headers. A stand-in that does not must not be
  // able to throw inside record() and turn a paid call that worked into an error:
  // the audit trail is written around the money, not in its path.
  if (!headers || typeof headers.get !== 'function') {
    return null;
  }
  for (const name of names) {
    const decoded = decodeJsonHeader(headers.get(name));
    if (decoded) {
      return decoded;
    }
  }
  return null;
}

/** Headers a resource server uses to echo the settlement of a payment it accepted. */
function settleHeader(response: Response | undefined): Record<string, unknown> | null {
  return readJsonHeader(response, ['payment-response', 'x-payment-response']);
}

/**
 * The accepted offer, read out of the payment header this client sent.
 *
 * `accepted` is the seller's own requirements echoed back, so it carries the
 * price, asset and network. Everything else in this header — above all
 * `payload`, the signed transaction envelope — is deliberately not read here
 * and must never reach a record, a metric or the audit file.
 */
function acceptedHeader(headers: Headers): Record<string, unknown> | null {
  const encoded = headers.get('payment-signature') ?? headers.get('x-payment');
  const payload = decodeJsonHeader(encoded);
  if (!payload) return null;
  const accepted = payload.accepted;
  if (accepted !== null && typeof accepted === 'object' && !Array.isArray(accepted)) {
    return accepted as Record<string, unknown>;
  }
  // x402 v1 payloads carry the offer at the top level and do not include an amount.
  return payload;
}

interface PaymentObservation {
  readonly amount: string | null;
  readonly asset: string | null;
  readonly network: string | null;
}

function observePayment(headers: Headers): PaymentObservation | null {
  const accepted = acceptedHeader(headers);
  if (!accepted) return null;
  return {
    amount: boundedText(accepted.amount, MAX_FIELD_CHARS),
    asset: boundedText(accepted.asset, MAX_FIELD_CHARS),
    network: boundedText(accepted.network, MAX_FIELD_CHARS),
  };
}

/**
 * Durable, ordered record of every paid call, plus the Prometheus series that
 * make that spend visible from outside the process.
 *
 * The record is written where the payment can actually be seen. A wrapped
 * x402 fetch hands back a plain Response, and the price the agent agreed to is
 * only present on the request the transport makes, so
 * {@link PaymentLedger.instrumentFetch} observes the transport and the record
 * is assembled from both sides: the offer from the request, the settlement from
 * the response.
 */
export class PaymentLedger {
  /**
   * False when a durable audit trail was asked for and cannot be had — the file
   * could not be created, or a record failed to reach it. An in-memory ledger
   * (no filePath) never claims to be durable and stays true, because there was
   * nothing to break.
   */
  durable: boolean;

  private readonly filePath?: string;
  private readonly metricHosts: readonly string[];
  private readonly metricNetworks: readonly string[];
  private readonly now: () => Date;
  private readonly observations = new WeakMap<Response, PaymentObservation>();
  private readonly log: PaymentRecord[] = [];
  private settledNanodollars = 0n;
  private possibleNanodollars = 0n;
  private unquantifiedPayments = 0;
  private warnedAboutFile = false;

  constructor(config: PaymentLedgerConfig = {}) {
    this.filePath = config.filePath;
    this.metricHosts = config.metricHosts ?? [];
    this.metricNetworks = config.metricNetworks ?? DEFAULT_PAYMENT_METRIC_NETWORKS;
    this.now = config.now ?? (() => new Date());
    this.durable = true;
    if (this.filePath) {
      try {
        mkdirSync(dirname(this.filePath), { recursive: true });
      } catch (e) {
        this.durable = false;
        this.warnFile(
          `the payment ledger file at ${this.filePath} could not be created: ${(e as Error).message}. ` +
            'Paid calls are refused until the audit trail can be written.'
        );
      }
    }
  }

  /**
   * Wraps the transport fetch so that the offer on each payment leg is recorded
   * against the Response that leg produces. Pass the result as the fetch given
   * to `wrapFetchWithPayment`; the x402 loop and the response the tool returns
   * are untouched.
   */
  instrumentFetch(baseFetch: typeof fetch): typeof fetch {
    return async (input, init) => {
      // Only the headers are read, so the request is passed to the transport
      // untouched: cloning it would risk consuming a body on the way.
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
      const observation = observePayment(headers);
      const response = await baseFetch(input, init);
      if (observation) {
        this.observations.set(response, observation);
      }
      return response;
    };
  }

  /**
   * Writes the record for one paid call. Called for the outcome of every attempt
   * that reached the payment transport, whether or not it settled, and whether or
   * not the seller said anything about settlement.
   *
   * @param paymentMayHaveSettled the caller's verdict for an attempt that produced
   * no Response — a transport that threw part-way through the payment loop. The
   * ledger cannot see the offer in that case, so it takes this rather than
   * concluding nothing was spent.
   */
  record(input: {
    url: string;
    method: string;
    outcome: PaymentOutcome;
    errorCode?: McpErrorCode | null;
    response?: Response;
    paymentMayHaveSettled?: boolean;
  }): PaymentRecord {
    const response = input.response;
    const observed = response ? this.observations.get(response) : undefined;
    const settle = response ? settleHeader(response) : null;
    const settled = settle ? settle.success === true : null;
    const amount = observed?.amount ?? boundedText(settle?.amount, MAX_FIELD_CHARS) ?? null;
    const network = observed?.network ?? boundedText(settle?.network, MAX_FIELD_CHARS) ?? null;
    const offerWasSent = observed !== undefined || settle !== null || input.paymentMayHaveSettled === true;

    // Nothing that proves the money moved is enough to call it unspent: an
    // explicit settlement failure and a rejected 402 are the only outs.
    let spend: PaymentSpend;
    if (settled === true) {
      spend = 'settled';
    } else if (settled === false || response?.status === 402) {
      spend = 'none';
    } else {
      spend = offerWasSent ? 'possible' : 'none';
    }

    const record: PaymentRecord = {
      timestamp: this.now().toISOString(),
      url: boundedText(input.url, MAX_URL_CHARS) ?? String(input.url ?? ''),
      host: boundedText(hostOf(input.url), MAX_FIELD_CHARS) ?? UNKNOWN_LABEL,
      method: boundedText(input.method, MAX_FIELD_CHARS) ?? 'GET',
      amount,
      asset: observed?.asset ?? null,
      network,
      transactionHash: boundedText(settle?.transaction, MAX_FIELD_CHARS),
      outcome: input.outcome,
      spend,
      errorCode: input.errorCode ?? null,
    };

    this.log.push(record);
    this.bookTotals(record);
    this.appendToFile(record);
    this.exportMetrics(record);
    return record;
  }

  /** Every record taken so far, oldest first. */
  records(): readonly PaymentRecord[] {
    return this.log;
  }

  /**
   * The running total of recorded spend: what the ledger saw settle, what it
   * cannot rule out, and how much of the trail it could not price in USD. This
   * is the measurement a cumulative ceiling should read, as distinct from the
   * worst case it reserves before a price is known.
   */
  totalSpend(): SpendSummary {
    return {
      attempts: this.log.length,
      settledNanodollars: this.settledNanodollars.toString(),
      possibleNanodollars: this.possibleNanodollars.toString(),
      unquantifiedPayments: this.unquantifiedPayments,
    };
  }

  private bookTotals(record: PaymentRecord): void {
    if (record.spend === 'none') {
      return;
    }
    let nanodollars: bigint | null = null;
    if (record.amount !== null) {
      try {
        nanodollars = usdOfferToNanodollars(record.amount);
      } catch {
        // Not a USD money string: an atomic-unit offer, or something a seller
        // invented. It is recorded verbatim but cannot join a USD total.
        nanodollars = null;
      }
    }
    if (nanodollars === null) {
      this.unquantifiedPayments++;
      return;
    }
    if (record.spend === 'settled') {
      this.settledNanodollars += nanodollars;
    } else {
      this.possibleNanodollars += nanodollars;
    }
  }

  private appendToFile(record: PaymentRecord): void {
    if (!this.filePath) {
      return;
    }
    try {
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (e) {
      this.durable = false;
      this.warnFile(
        `a payment record could not be written to ${this.filePath}: ${(e as Error).message}. ` +
          'Paid calls are refused from here on: the audit trail on disk has a gap and a durable one is required.'
      );
    }
  }

  private warnFile(reason: string): void {
    if (this.warnedAboutFile) {
      return;
    }
    this.warnedAboutFile = true;
    console.error(`[mcp-ledger] ${reason}`);
  }

  private exportMetrics(record: PaymentRecord): void {
    const host = this.metricHosts.includes(record.host) ? record.host : UNKNOWN_LABEL;
    const network =
      record.network !== null && this.metricNetworks.includes(record.network) ? record.network : UNKNOWN_LABEL;

    paymentAttemptsTotal.inc({ host, network, outcome: record.outcome });
    if (record.spend === 'settled' && record.amount !== null) {
      let nanodollars: bigint | null = null;
      try {
        nanodollars = usdOfferToNanodollars(record.amount);
      } catch {
        nanodollars = null;
      }
      if (nanodollars !== null) {
        paymentAmountUsdTotal.inc({ host, network }, Number(nanodollars) / Number(NANODOLLARS_PER_USD));
      }
    }
    if (record.spend !== 'none' && !isUsdAmount(record.amount)) {
      paymentUnquantifiedTotal.inc({ host, network });
    }
  }
}
