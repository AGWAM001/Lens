"""HTTP client for the Lens price indexer API.

Standard library only, as promised by :class:`LensClient`.
"""

import json
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal
from typing import Any, Dict, List, Mapping, Optional, Union

from .errors import LensAPIError
from .models import (
    CandleResponse,
    OracleComparison,
    PriceResponse,
    RouteResponse,
)

Amount = Union[str, int, float, Decimal]


class LensClient:
    """Minimal HTTP client for the Lens price indexer API.

    No third-party dependencies — uses only the Python standard library.

    Args:
        base_url: API origin, for example ``https://api.lens.example``.
        timeout: Per-request timeout in seconds.
        api_key: Client API key, sent as ``Authorization: Bearer <key>``.
        payment: Base64 x402 payment proof, sent as the ``X-PAYMENT`` header on
            the routes the spec marks as paid.
        network: ``testnet`` or ``mainnet``. Sent as the ``network`` query
            parameter when set; otherwise the server uses its configured
            default.

    Every request asks for exact decimal quantities
    (``X-Decimal-Format: string``) and parses them as
    :class:`decimal.Decimal`, never ``float``.

    Every non-success HTTP answer raises :class:`lens_client.LensAPIError`,
    which carries the status code and the decoded error body. The single
    documented exception is a 404 "pair not watched" from :meth:`get_price` and
    :meth:`get_route`, which return ``None``.
    """

    def __init__(
        self,
        base_url: str,
        timeout: int = 10,
        api_key: Optional[str] = None,
        payment: Optional[str] = None,
        network: Optional[str] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.api_key = api_key
        self.payment = payment
        self.network = network

    def get_price(self, asset_a: str, asset_b: str) -> Optional[PriceResponse]:
        """Return the latest aggregated price for a trading pair.

        ``GET /v1/price/{assetA}/{assetB}``. Returns ``None`` when the pair is
        not watched (the API answers 404); every other HTTP error raises
        :class:`LensAPIError`.
        """
        try:
            data = self._get(self._pair_path("/v1/price", asset_a, asset_b))
        except LensAPIError as exc:
            if exc.status_code == 404:
                return None
            raise
        return PriceResponse.from_dict(data)

    def get_route(
        self,
        asset_a: str,
        asset_b: str,
        amount: Amount = 1000,
    ) -> Optional[RouteResponse]:
        """Return the best swap route between two assets.

        ``GET /v1/price/{assetA}/{assetB}/route``. ``amount`` is the input
        amount the route is priced for (the API defaults to ``1000``). Returns
        ``None`` when the pair is not watched (404); every other HTTP error
        raises :class:`LensAPIError`.
        """
        path = self._pair_path("/v1/price", asset_a, asset_b) + "/route"
        try:
            data = self._get(path, {"amount": amount})
        except LensAPIError as exc:
            if exc.status_code == 404:
                return None
            raise
        return RouteResponse.from_dict(data)

    def get_candles(
        self,
        asset_a: str,
        asset_b: str,
        interval: str = "1h",
        limit: int = 500,
        start: Optional[str] = None,
        end: Optional[str] = None,
        cursor: Optional[str] = None,
    ) -> List[CandleResponse]:
        """Return OHLCV candles for a pair.

        ``GET /v1/candles/{assetA}/{assetB}``. ``start`` and ``end`` are sent as
        the ``from`` and ``to`` query parameters (half-open ``[from, to)`` ISO
        8601 timestamps). An empty list means the API found no trades in the
        window; HTTP errors raise :class:`LensAPIError`.
        """
        data = self._get(
            self._pair_path("/v1/candles", asset_a, asset_b),
            {
                "interval": interval,
                "from": start,
                "to": end,
                "cursor": cursor,
                "limit": limit,
            },
        )
        candles = data.get("candles") if isinstance(data, dict) else data
        pair_key = data.get("pairKey", "") if isinstance(data, dict) else ""
        return [
            CandleResponse.from_dict(candle, pair_key=pair_key, interval=interval)
            for candle in (candles or [])
        ]

    def compare_oracle(self, asset: str) -> OracleComparison:
        """Compare the Lens price for an asset with every configured oracle.

        ``GET /v1/compare/{asset}``. The API answers 200 with
        ``status="no_data"`` when neither side has a price, so this method
        always returns a model unless the request itself fails.
        """
        data = self._get(f"/v1/compare/{_escape(asset)}")
        return OracleComparison.from_dict(data)

    def _headers(self) -> Dict[str, str]:
        headers = {
            "Accept": "application/json",
            "X-Decimal-Format": "string",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if self.payment:
            headers["X-PAYMENT"] = self.payment
        return headers

    def _get(self, path: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        query: Dict[str, Any] = {
            key: value for key, value in (params or {}).items() if value is not None
        }
        if self.network and "network" not in query:
            query["network"] = self.network

        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{urllib.parse.urlencode(query)}"

        request = urllib.request.Request(url, headers=self._headers(), method="GET")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            raise LensAPIError(
                exc.code,
                _decode_body(exc),
                url=url,
                headers=dict(exc.headers or {}),
            ) from None

        return json.loads(payload) if payload.strip() else {}

    @staticmethod
    def _pair_path(prefix: str, asset_a: str, asset_b: str) -> str:
        return f"{prefix}/{_escape(asset_a)}/{_escape(asset_b)}"


def _escape(segment: str) -> str:
    """Percent-encode one path segment; an asset code may contain ``:``."""
    return urllib.parse.quote(str(segment), safe="")


def _decode_body(exc: urllib.error.HTTPError) -> Any:
    """Decode an error body as JSON, falling back to raw text."""
    try:
        raw = exc.read().decode("utf-8", "replace")
    except Exception:  # pragma: no cover - the body is best-effort
        return ""
    if not raw.strip():
        return ""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw
