import http.server
import json
import threading
import unittest
from decimal import Decimal
from urllib.parse import parse_qs, urlsplit

from lens_client import (
    CandleResponse,
    LensAPIError,
    LensClient,
    OracleComparison,
    PriceResponse,
    RouteResponse,
)

# A real USDC issuer from the repository's snippets — never truncated.
USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"

PRICE_BODY = {
    "assetA": "XLM",
    "assetB": "USDC",
    "pairKey": "XLM/USDC",
    "price": "0.123456789012345678",
    "sdexPrice": "0.12",
    "ammPrice": 0.13,
    "bestRoute": "AMM",
    "volume24h": "12345.678901234567890123",
    "lastUpdated": "2026-11-19T00:00:00.000Z",
    "sources": 3,
    "confidence": "high",
    "stale": False,
}

ROUTE_BODY = {
    "route": "SDEX",
    "sdexPrice": "0.12",
    "ammPrice": "0.13",
    "estimatedOutput": "8333.333333333333333333",
    "slippagePct": "0.15",
    "recommendation": "Execute on SDEX",
    "network": "testnet",
    "hops": [{"from": "XLM", "to": "USDC", "venue": "sdex"}],
}

CANDLES_BODY = {
    "pairKey": "XLM/USDC",
    "interval": "1h",
    "from": "2026-11-18T00:00:00.000Z",
    "to": "2026-11-19T00:00:00.000Z",
    "candles": [
        {
            "time": "2026-11-18T00:00:00.000Z",
            "open": "0.11",
            "high": 0.13,
            "low": "0.10",
            "close": "0.123",
            "volume": "1000.5",
        }
    ],
    "nextCursor": None,
    "hasMore": False,
}

COMPARE_BODY = {
    "asset": "XLM",
    "network": "testnet",
    "lens": 0.123,
    "reflector": "0.12",
    "deviationPct": "2.5",
    "status": "minor_deviation",
    "fetchedAt": "2026-11-19T00:00:00.000Z",
    "oracles": [
        {
            "name": "reflector",
            "price": "0.12",
            "timestamp": "2026-11-19T00:00:00.000Z",
            "deviationPct": 2.5,
            "status": "available",
            "ageSeconds": 30,
        }
    ],
}

PAYMENT_BODY = {
    "x402Version": 2,
    "accepts": [
        {
            "scheme": "exact",
            "price": "0.01",
            "network": "stellar:testnet",
            "payTo": "GDYSPDQHTHJZQH4Q2GZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZ",
        }
    ],
    "error": "Payment required",
}

ERROR_BODIES = {
    401: {"error": "Missing or invalid API key", "code": "UNAUTHORIZED"},
    402: PAYMENT_BODY,
    429: {"error": "Too many requests", "code": "RATE_LIMITED"},
    500: {
        "message": "An internal server error occurred.",
        "code": "internal_error",
        "correlationId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    },
}


class StubAPITestCase(unittest.TestCase):
    """Runs the client against a local ``http.server`` stub; no network."""

    def setUp(self):
        self.requests = []
        self.response = (200, {})
        test = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                test.requests.append(
                    {
                        "path": self.path,
                        "headers": {
                            key.lower(): value for key, value in self.headers.items()
                        },
                    }
                )
                status, body = test.response
                payload = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    @property
    def last_request(self):
        return self.requests[-1]

    def path_of(self, index=-1):
        return urlsplit(self.requests[index]["path"]).path

    def query_of(self, index=-1):
        return parse_qs(urlsplit(self.requests[index]["path"]).query)

    def client(self, **kwargs):
        return LensClient(self.base_url, **kwargs)


class PriceTests(StubAPITestCase):
    def test_uses_v1_path_and_parses_decimal_fields(self):
        self.response = (200, PRICE_BODY)
        price = self.client(
            network="testnet", api_key="test-key", payment="test-payment"
        ).get_price("XLM", "USDC")

        self.assertEqual(self.path_of(), "/v1/price/XLM/USDC")
        self.assertEqual(self.query_of(), {"network": ["testnet"]})

        headers = self.last_request["headers"]
        self.assertEqual(headers["authorization"], "Bearer test-key")
        self.assertEqual(headers["x-payment"], "test-payment")
        self.assertEqual(headers["x-decimal-format"], "string")
        self.assertEqual(headers["accept"], "application/json")

        self.assertIsInstance(price, PriceResponse)
        self.assertEqual(price.asset_a, "XLM")
        self.assertEqual(price.asset_b, "USDC")
        self.assertEqual(price.pair_key, "XLM/USDC")
        self.assertEqual(price.price, Decimal("0.123456789012345678"))
        self.assertIsInstance(price.price, Decimal)
        self.assertNotIsInstance(price.price, float)
        self.assertEqual(price.sdex_price, Decimal("0.12"))
        self.assertEqual(price.amm_price, Decimal("0.13"))
        self.assertEqual(price.volume_24h, Decimal("12345.678901234567890123"))
        self.assertEqual(price.best_route, "AMM")
        self.assertFalse(price.stale)

    def test_optional_settings_are_omitted_when_not_configured(self):
        self.response = (200, PRICE_BODY)
        self.client().get_price("XLM", "USDC")

        headers = self.last_request["headers"]
        self.assertNotIn("authorization", headers)
        self.assertNotIn("x-payment", headers)
        self.assertEqual(self.query_of(), {})

    def test_path_segments_are_url_escaped(self):
        self.response = (200, PRICE_BODY)
        self.client().get_price(f"USDC:{USDC_ISSUER}", "XLM")

        self.assertEqual(
            self.path_of(), f"/v1/price/USDC%3A{USDC_ISSUER}/XLM"
        )

    def test_unknown_pair_returns_none_on_404(self):
        self.response = (404, {"error": "Pair not watched", "code": "PAIR_NOT_FOUND"})
        self.assertIsNone(self.client().get_price("XLM", "NOPE"))


class RouteTests(StubAPITestCase):
    def test_uses_v1_route_path_and_parses_route_info(self):
        self.response = (200, ROUTE_BODY)
        route = self.client(network="mainnet").get_route(
            "XLM", "USDC", amount=Decimal("1000")
        )

        self.assertEqual(self.path_of(), "/v1/price/XLM/USDC/route")
        self.assertEqual(
            self.query_of(), {"amount": ["1000"], "network": ["mainnet"]}
        )

        self.assertIsInstance(route, RouteResponse)
        self.assertEqual(route.route, "SDEX")
        self.assertEqual(route.recommendation, "Execute on SDEX")
        self.assertEqual(route.sdex_price, Decimal("0.12"))
        self.assertEqual(route.amm_price, Decimal("0.13"))
        self.assertEqual(route.estimated_output, Decimal("8333.333333333333333333"))
        self.assertEqual(route.slippage_pct, Decimal("0.15"))
        self.assertEqual(route.network, "testnet")
        self.assertEqual(route.hops, ROUTE_BODY["hops"])

    def test_amount_defaults_to_the_spec_default(self):
        self.response = (200, ROUTE_BODY)
        self.client().get_route("XLM", "USDC")
        self.assertEqual(self.query_of(), {"amount": ["1000"]})

    def test_unknown_pair_returns_none_on_404(self):
        self.response = (404, {"error": "Pair not watched", "code": "PAIR_NOT_FOUND"})
        self.assertIsNone(self.client().get_route("XLM", "NOPE"))


class CandleTests(StubAPITestCase):
    def test_parses_the_envelope_and_decimal_candles(self):
        self.response = (200, CANDLES_BODY)
        candles = self.client(network="testnet").get_candles(
            "XLM", "USDC", interval="1h", limit=24
        )

        self.assertEqual(self.path_of(), "/v1/candles/XLM/USDC")
        self.assertEqual(
            self.query_of(),
            {"interval": ["1h"], "limit": ["24"], "network": ["testnet"]},
        )

        self.assertEqual(len(candles), 1)
        candle = candles[0]
        self.assertIsInstance(candle, CandleResponse)
        self.assertEqual(candle.pair_key, "XLM/USDC")
        self.assertEqual(candle.interval, "1h")
        self.assertEqual(candle.time, "2026-11-18T00:00:00.000Z")
        self.assertEqual(candle.open, Decimal("0.11"))
        self.assertEqual(candle.high, Decimal("0.13"))
        self.assertEqual(candle.low, Decimal("0.10"))
        self.assertEqual(candle.close, Decimal("0.123"))
        self.assertEqual(candle.volume, Decimal("1000.5"))

    def test_forwards_window_limits_and_cursor(self):
        self.response = (200, CANDLES_BODY)
        self.client().get_candles(
            "XLM",
            "USDC",
            start="2026-11-18T00:00:00Z",
            end="2026-11-19T00:00:00Z",
            cursor="next-page",
        )

        self.assertEqual(
            self.query_of(),
            {
                "interval": ["1h"],
                "from": ["2026-11-18T00:00:00Z"],
                "to": ["2026-11-19T00:00:00Z"],
                "cursor": ["next-page"],
                "limit": ["500"],
            },
        )

    def test_empty_candles_are_an_empty_list(self):
        self.response = (200, dict(CANDLES_BODY, candles=[]))
        self.assertEqual(self.client().get_candles("XLM", "USDC"), [])


class CompareTests(StubAPITestCase):
    def test_uses_v1_compare_path_and_parses_the_comparison(self):
        self.response = (200, COMPARE_BODY)
        comparison = self.client(network="testnet").compare_oracle("XLM")

        self.assertEqual(self.path_of(), "/v1/compare/XLM")
        self.assertEqual(self.query_of(), {"network": ["testnet"]})

        self.assertIsInstance(comparison, OracleComparison)
        self.assertEqual(comparison.asset, "XLM")
        self.assertEqual(comparison.network, "testnet")
        self.assertEqual(comparison.lens, Decimal("0.123"))
        self.assertEqual(comparison.reflector, Decimal("0.12"))
        self.assertEqual(comparison.deviation_pct, Decimal("2.5"))
        self.assertEqual(comparison.status, "minor_deviation")
        self.assertEqual(len(comparison.oracles), 1)
        self.assertEqual(comparison.oracles[0].name, "reflector")
        self.assertEqual(comparison.oracles[0].price, Decimal("0.12"))
        self.assertEqual(comparison.oracles[0].age_seconds, 30)

    def test_no_data_is_a_normal_response(self):
        no_data = dict(
            COMPARE_BODY,
            lens=None,
            reflector=None,
            deviationPct=None,
            status="no_data",
            oracles=[],
        )
        self.response = (200, no_data)
        comparison = self.client().compare_oracle("XLM")

        self.assertEqual(comparison.status, "no_data")
        self.assertIsNone(comparison.lens)
        self.assertEqual(comparison.oracles, [])


class ErrorTests(StubAPITestCase):
    def test_http_errors_raise_a_typed_exception(self):
        for status, body in ERROR_BODIES.items():
            with self.subTest(status=status):
                self.response = (status, body)
                with self.assertRaises(LensAPIError) as raised:
                    self.client().get_price("XLM", "USDC")

                error = raised.exception
                self.assertEqual(error.status_code, status)
                self.assertEqual(error.body, body)
                self.assertEqual(error.code, body.get("code"))
                self.assertIn(str(status), str(error))
                self.assertIn("/v1/price/XLM/USDC", error.url)

    def test_a_402_keeps_the_payment_request_body(self):
        self.response = (402, PAYMENT_BODY)
        with self.assertRaises(LensAPIError) as raised:
            self.client().get_candles("XLM", "USDC")

        error = raised.exception
        self.assertEqual(error.status_code, 402)
        self.assertEqual(error.body["x402Version"], 2)
        self.assertEqual(error.body["accepts"][0]["scheme"], "exact")
        self.assertEqual(error.message, "Payment required")

    def test_non_json_error_bodies_are_kept_as_text(self):
        self.response = (500, b"upstream exploded")
        with self.assertRaises(LensAPIError) as raised:
            self.client().compare_oracle("XLM")

        self.assertEqual(raised.exception.status_code, 500)
        self.assertEqual(raised.exception.body, "upstream exploded")
        self.assertIsNone(raised.exception.code)

    def test_404_raises_where_the_spec_documents_no_404(self):
        for call in (
            lambda client: client.get_candles("XLM", "USDC"),
            lambda client: client.compare_oracle("XLM"),
        ):
            with self.subTest(call=call):
                self.response = (404, {"error": "Not found", "code": "NOT_FOUND"})
                with self.assertRaises(LensAPIError) as raised:
                    call(self.client())
                self.assertEqual(raised.exception.status_code, 404)


class ModelParsingTests(unittest.TestCase):
    def test_absent_decimal_fields_stay_none(self):
        price = PriceResponse.from_dict({"assetA": "XLM", "assetB": "USDC"})
        self.assertIsNone(price.price)
        self.assertEqual(price.pair_key, "")

    def test_integers_become_decimal(self):
        price = PriceResponse.from_dict(dict(PRICE_BODY, price=1))
        self.assertEqual(price.price, Decimal("1"))
        self.assertIsInstance(price.price, Decimal)


if __name__ == "__main__":
    unittest.main()
