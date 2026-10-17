import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BazaarMcpServer, classifyPaidCallError } from '../src/mcp/server.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * Realistic error shapes from the Stellar SDK / x402 libraries / fetch layer.
 * These are constructed to mirror the structured properties those libraries
 * actually attach to thrown errors, rather than hand-written strings.
 */

function captureHandler(server: BazaarMcpServer): any {
  let handler: any = null;
  // Capture the handler through the server's own router.
  (server as any).server.setRequestHandler = (schema: any, fn: any) => {
    if (schema === CallToolRequestSchema) {
      handler = fn;
    }
  };
  (server as any).setupHandlers();
  return handler;
}

describe('BazaarMcpServer', () => {
  it('maps a signature expiration ledger error to ERR_EXPIRED_AUTHORISATION', async () => {
    // Stellar SDK throws an Error whose message includes the ledge number.
    const sdkError = new Error(
      'Transaction signature expired. Signature expiration ledger 123 is less than current ledger 125'
    );
    const mockFetch = vi.fn().mockRejected(sdkError);
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
    const handler = captureHandler(server);

    const response = await handler({
      params: { name: 'paid_call', arguments: { url: 'https://example.org/paid' } },
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_EXPIRED_AUTHORISATION');
  });

  it('maps a Horizon transaction_failed result_codes body to ERR_MISSING_TRUSTLINE', async () => {
    // Horizon returns this shape on a transaction_failed response.
    const horizonError: any = new Error('Transaction failed');
    horizonError.result_codes = {
      transaction: 'tx_failed',
      operations: ['op_no_trust'],
    };
    const mockFetch = vi.fn().mockRejected(horizonError);
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
    const handler = captureHandler(server);

    const response = await handler({
      params: { name: 'paid_call', arguments: { url: 'https://example.org/paid' } },
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_MISSING_TRUSTLINE');
  });

  it('maps a 402 rejected error to ERR_PAYMENT_REJECTED', async () => {
    const mockFetch = vi.fn().mockResolved({
      ok: false,
      status: 402,
      text: async () => 'Payment Required',
    });
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
    const handler = captureHandler(server);

    const response = await handler({
      params: { name: 'paid_call', arguments: { url: 'https://example.org/paid' } },
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_PAYMENT_REJECTED');
  });

  it('returns successfully on a successful call', async () => {
    const mockFetch = vi.fn().mockResolved({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, data: 'hello' }),
    });
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });
    const handler = captureHandler(server);

    const response = await handler({
      params: { name: 'paid_call', arguments: { url: 'https://example.org/paid' } },
    });

    expect(response.isError).toBeFalsy();
    const parsedText = JSON.parse(response.content[0].text);
    expect(parsedText.success).toBe(true);
  });
});

describe('classifyPaidCallError', () => {
  it('prefers a structured Horizon result_codes body over text', () => {
    // Message wording is deliberately misleading: the structured code must win.
    const err: any = new Error('network error while fetching');
    err.result_codes = { transaction: 'tx_failed', operations: ['op_underfunded'] };
    const result = classifyPaidCallError(err);
    expect(result.code).toBe('ERR_INSUFFICIENT_BALANCE');
    expect(result.isFallback).toBe(false);
  });

  it('does not report a payment failure mentioning "fetch" as unreachable', () => {
    // This is the regression the issue calls out: the word "fetch" in a
    // payment failure must not be treated as a network error.
    const err = new Error('Payment failed: fetch of the signed transaction was rejected');
    const result = classifyPaidCallError(err);
    expect(result.code).not.toBe('ERR_SERVICE_UNREACHABLE');
  });

  it('marks the text path as a fallback', () => {
    const err = new Error('op_underfunded');
    const result = classifyPaidCallError(err);
    expect(result.code).toBe('ERR_INSUFFICIENT_BALANCE');
    expect(result.isFallback).toBe(true);
  });

  it('preserves the original message for the unclassified case', () => {
    const original = 'Something unexpected happened in the payment flow';
    const result = classifyPaidCallError(new Error(original));
    expect(result.code).toBe('ERR_INTERNAL_FAILURE');
    expect(result.reason).toContain(original);
  });
});
