"""Type stubs for the compiled ``ratel_ai_rankers_plugin._native`` extension."""

class RankerError(RuntimeError):
    """A decision-model ranking failed; the plugins re-raise it as `RetrieverError`.

    Attributes:
        code: ``"Config"`` | ``"Unauthorized"`` | ``"InvalidRequest"`` |
            ``"RateLimited"`` | ``"Overloaded"`` | ``"Timeout"`` | ``"Unreachable"`` |
            ``"Http"`` | ``"Malformed"`` | ``"Refused"``.
        status: the HTTP status, when the service sent one.
        retry_after_secs: the service's ``Retry-After`` for ``"RateLimited"``, else ``None``.
        transient: whether a retry may succeed.
    """

    code: str
    status: int | None
    retry_after_secs: int | None
    transient: bool

DEFAULT_JEV_MODEL: str
"""The Jev model asked by default."""

DEFAULT_OPENAI_DECISION_MODEL: str
"""The Decisions model the OpenAI Decisions plugin asks by default (the only one in the beta)."""

def vendors() -> list[str]:
    """The vendor ids this build ships."""

class ChoiceRanker:
    """A decision-model ranker for one vendor (``"jev"``, ``"openai-decision"``)."""

    def __init__(
        self,
        vendor: str,
        url: str | None = ...,
        api_key_env: str | None = ...,
        model: str | None = ...,
    ) -> None: ...
    @property
    def service(self) -> str:
        """The service as errors name it: ``"jev"``, ``"openai decisions"``."""
    def rank(
        self, query: str, candidates: list[tuple[str, str]], top_k: int, kind: str
    ) -> list[tuple[str, float]]:
        """Rank ``(id, text)`` candidates with the GIL released; raises `RankerError`."""
