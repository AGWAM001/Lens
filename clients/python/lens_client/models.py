"""Response models for the Lens API.

Field names and shapes follow ``openapi.yaml``. Every decimal quantity is
returned as :class:`decimal.Decimal` — never ``float`` — because the client
asks the API for exact decimal strings (``X-Decimal-Format: string``).
"""

from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Optional


def to_decimal(value: Any) -> Optional[Decimal]:
    """Convert an API numeric value to ``Decimal`` without a float round-trip.

    ``None`` and empty strings become ``None``. Integers and strings are
    converted exactly; a JSON number that Python already parsed as ``float``
    is converted through its shortest text form.
    """
    if value is None or value == "":
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


@dataclass
class PriceResponse:
    """``AggregatedPrice`` for ``GET /v1/price/{assetA}/{assetB}``."""

    asset_a: str
    asset_b: str
    pair_key: str
    price: Optional[Decimal]
    sdex_price: Optional[Decimal] = None
    amm_price: Optional[Decimal] = None
    best_route: Optional[str] = None
    volume_24h: Optional[Decimal] = None
    sdex_volume_24h: Optional[Decimal] = None
    amm_volume_24h: Optional[Decimal] = None
    vwap_24h: Optional[Decimal] = None
    price_change_24h: Optional[Decimal] = None
    last_updated: Optional[str] = None
    sources: Optional[int] = None
    confidence: Optional[str] = None
    stale: Optional[bool] = None
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PriceResponse":
        return cls(
            asset_a=data.get("assetA", ""),
            asset_b=data.get("assetB", ""),
            pair_key=data.get("pairKey", ""),
            price=to_decimal(data.get("price")),
            sdex_price=to_decimal(data.get("sdexPrice")),
            amm_price=to_decimal(data.get("ammPrice")),
            best_route=data.get("bestRoute"),
            volume_24h=to_decimal(data.get("volume24h")),
            sdex_volume_24h=to_decimal(data.get("sdexVolume24h")),
            amm_volume_24h=to_decimal(data.get("ammVolume24h")),
            vwap_24h=to_decimal(data.get("vwap24h")),
            price_change_24h=to_decimal(data.get("priceChange24h")),
            last_updated=data.get("lastUpdated"),
            sources=data.get("sources"),
            confidence=data.get("confidence"),
            stale=data.get("stale"),
            raw=dict(data),
        )


@dataclass
class RouteResponse:
    """``RouteInfo`` for ``GET /v1/price/{assetA}/{assetB}/route``."""

    route: str
    recommendation: str
    sdex_price: Optional[Decimal] = None
    amm_price: Optional[Decimal] = None
    estimated_output: Optional[Decimal] = None
    slippage_pct: Optional[Decimal] = None
    network: Optional[str] = None
    hops: List[Dict[str, Any]] = field(default_factory=list)
    comparison: Optional[Dict[str, Any]] = None
    provenance: Optional[Dict[str, Any]] = None
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "RouteResponse":
        return cls(
            route=data.get("route", "UNKNOWN"),
            recommendation=data.get("recommendation", ""),
            sdex_price=to_decimal(data.get("sdexPrice")),
            amm_price=to_decimal(data.get("ammPrice")),
            estimated_output=to_decimal(data.get("estimatedOutput")),
            slippage_pct=to_decimal(data.get("slippagePct")),
            network=data.get("network"),
            hops=list(data.get("hops") or []),
            comparison=data.get("comparison"),
            provenance=data.get("provenance"),
            raw=dict(data),
        )


@dataclass
class CandleResponse:
    """One candle from ``GET /v1/candles/{assetA}/{assetB}``."""

    time: Optional[str] = None
    open: Optional[Decimal] = None
    high: Optional[Decimal] = None
    low: Optional[Decimal] = None
    close: Optional[Decimal] = None
    volume: Optional[Decimal] = None
    pair_key: str = ""
    interval: str = ""
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(
        cls,
        data: Dict[str, Any],
        pair_key: str = "",
        interval: str = "",
    ) -> "CandleResponse":
        return cls(
            time=data.get("time"),
            open=to_decimal(data.get("open")),
            high=to_decimal(data.get("high")),
            low=to_decimal(data.get("low")),
            close=to_decimal(data.get("close")),
            volume=to_decimal(data.get("volume")),
            pair_key=pair_key,
            interval=interval,
            raw=dict(data),
        )


@dataclass
class OracleQuote:
    """One entry of ``CompareResponse.oracles``."""

    name: str
    price: Optional[Decimal] = None
    timestamp: Optional[str] = None
    deviation_pct: Optional[Decimal] = None
    status: Optional[str] = None
    age_seconds: Optional[int] = None
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "OracleQuote":
        return cls(
            name=data.get("name", ""),
            price=to_decimal(data.get("price")),
            timestamp=data.get("timestamp"),
            deviation_pct=to_decimal(data.get("deviationPct")),
            status=data.get("status"),
            age_seconds=data.get("ageSeconds"),
            raw=dict(data),
        )


@dataclass
class OracleComparison:
    """``CompareResponse`` for ``GET /v1/compare/{asset}``."""

    asset: str
    network: Optional[str] = None
    lens: Optional[Decimal] = None
    reflector: Optional[Decimal] = None
    deviation_pct: Optional[Decimal] = None
    status: str = "no_data"
    fetched_at: Optional[str] = None
    oracles: List[OracleQuote] = field(default_factory=list)
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "OracleComparison":
        return cls(
            asset=data.get("asset", ""),
            network=data.get("network"),
            lens=to_decimal(data.get("lens")),
            reflector=to_decimal(data.get("reflector")),
            deviation_pct=to_decimal(data.get("deviationPct")),
            status=data.get("status", "no_data"),
            fetched_at=data.get("fetchedAt"),
            oracles=[
                OracleQuote.from_dict(entry) for entry in (data.get("oracles") or [])
            ],
            raw=dict(data),
        )
