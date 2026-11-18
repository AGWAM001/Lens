import { describe, it, expect, vi } from "vitest";
import { checkCrossVenueDivergence, calculateCrossVenueArbitrage } from "../src/alerts/arbitrage";

describe("Arbitrage cross-venue sanity test", () => {
  it("triggers alert when SDEX and AMM differ by >5%", () => {
    const alert = vi.fn();
    const sdexPrice = 1.0;
    const ammPrice = 1.06; // 6% difference

    const fired = checkCrossVenueDivergence(sdexPrice, ammPrice, 0.05, alert);

    expect(fired).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
    const payload = alert.mock.calls[0][0];
    expect(payload).toHaveProperty("sdexPrice", sdexPrice);
    expect(payload).toHaveProperty("ammPrice", ammPrice);
    expect(payload.diffPct).toBeGreaterThan(0.05);
  });

  it("does not trigger alert when divergence is <=5%", () => {
    const alert = vi.fn();
    const sdexPrice = 1.0;
    const ammPrice = 1.049; // 4.9% difference

    const fired = checkCrossVenueDivergence(sdexPrice, ammPrice, 0.05, alert);

    expect(fired).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it("ignores invalid or zero prices", () => {
    const alert = vi.fn();
    expect(checkCrossVenueDivergence(0, 1.2, 0.05, alert)).toBe(false);
    expect(checkCrossVenueDivergence(NaN, 1.2, 0.05, alert)).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it("does not trigger alert when gross spread is positive but net spread is negative (gross-positive, net-negative case)", () => {
    const alert = vi.fn();
    const sdexPrice = 1.0;
    const ammPrice = 1.06; // Gross spread is ~5.66% (> 5% threshold)

    // Combined fees (e.g., 4%) and slippage (3%) total 7%, exceeding the 5.66% gross spread
    const fired = checkCrossVenueDivergence(sdexPrice, ammPrice, 0.05, alert, {
      fees: 0.04,
      slippage: 0.03,
    });

    expect(fired).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it("reports both gross and net spreads, break-even size, and full arithmetic in payload", () => {
    const alert = vi.fn();
    const sdexPrice = 1.0;
    const ammPrice = 1.10; // Gross spread ~9.09%

    const fired = checkCrossVenueDivergence(sdexPrice, ammPrice, 0.02, alert, {
      size: 50,
      sdexFeeRate: 0.001,
      ammFeeRate: 0.003,
      slippageRate: 0.0002,
    });

    expect(fired).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
    const payload = alert.mock.calls[0][0];

    // Gross and net spreads both reported
    expect(payload.grossSpread).toBeCloseTo(0.10 / 1.10, 6);
    expect(payload.sdexFee).toBe(0.001);
    expect(payload.ammFee).toBe(0.003);
    expect(payload.fees).toBe(0.004);
    expect(payload.slippage).toBe(50 * 0.0002);
    expect(payload.size).toBe(50);
    expect(payload.netSpread).toBeCloseTo(payload.grossSpread - payload.fees - payload.slippage, 6);
    expect(payload.netSpread).toBeGreaterThan(0.02);

    // The break-even size is computed and reported
    const expectedBreakEven = (payload.grossSpread - payload.fees) / 0.0002;
    expect(payload.breakEvenSize).toBeCloseTo(expectedBreakEven, 4);
  });

  it("computes break-even size where the opportunity disappears", () => {
    const sdexPrice = 1.0;
    const ammPrice = 1.05;
    const res = calculateCrossVenueArbitrage(sdexPrice, ammPrice, {
      fees: 0.005,
      slippageRate: 0.0001,
    });

    expect(res).not.toBeNull();
    const { grossSpread, fees, breakEvenSize } = res!;
    expect(grossSpread).toBeCloseTo(0.05 / 1.05, 6);
    expect(breakEvenSize).toBeCloseTo((grossSpread - fees) / 0.0001, 4);

    // Evaluating at breakEvenSize results in netSpread of 0
    const atBreakEven = calculateCrossVenueArbitrage(sdexPrice, ammPrice, {
      fees: 0.005,
      slippageRate: 0.0001,
      size: breakEvenSize,
    });
    expect(atBreakEven!.netSpread).toBeCloseTo(0, 6);

    // Evaluating at size > breakEvenSize results in netSpread < 0
    const beyondBreakEven = calculateCrossVenueArbitrage(sdexPrice, ammPrice, {
      fees: 0.005,
      slippageRate: 0.0001,
      size: breakEvenSize + 10,
    });
    expect(beyondBreakEven!.netSpread).toBeLessThan(0);
    expect(beyondBreakEven!.isNetPositive).toBe(false);
  });

  it("computes break-even size as 0 when gross spread cannot cover fees", () => {
    const sdexPrice = 1.0;
    const ammPrice = 1.01; // ~0.99% gross spread
    const res = calculateCrossVenueArbitrage(sdexPrice, ammPrice, {
      fees: 0.02, // 2% fees
      slippageRate: 0.0001,
    });

    expect(res).not.toBeNull();
    expect(res!.grossSpread).toBeLessThan(res!.fees);
    expect(res!.breakEvenSize).toBe(0);
    expect(res!.isNetPositive).toBe(false);
  });
});
