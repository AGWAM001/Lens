"""Exceptions raised by the Lens Python client."""

from typing import Any, Dict, Mapping, Optional


class LensAPIError(Exception):
    """The API answered with a non-success HTTP status.

    Raised for every HTTP error response (401, 402, 429, 500, ...) so a caller
    can tell them apart instead of receiving a silent ``None``.

    Attributes:
        status_code: The HTTP status code.
        body: The decoded response body: a ``dict`` when the API sent JSON,
            otherwise the raw text (possibly empty).
        code: The machine-readable ``code`` field of the body, when present.
        message: The human-readable message (``error`` or ``message`` field),
            when present.
        url: The URL that was requested.
        headers: Response headers, lower-cased.
    """

    def __init__(
        self,
        status_code: int,
        body: Any = None,
        url: str = "",
        headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        self.status_code = status_code
        self.body = body
        self.url = url
        self.headers: Dict[str, str] = {
            key.lower(): value for key, value in (headers or {}).items()
        }
        self.code = body.get("code") if isinstance(body, dict) else None
        message = None
        if isinstance(body, dict):
            message = body.get("error") or body.get("message")
        self.message = message

        detail = f": {message}" if message else ""
        super().__init__(f"Lens API returned HTTP {status_code} for {url}{detail}")
