"""Host-owned persistence for an `IntentGraph` (ADR-0025).

Core stays bytes-in/bytes-out (ADR-0014) — these are thin adapters over
`IntentGraph.to_json()`/`from_json()`/`rev` that live entirely in the SDK.

Both implementations use `rev` for two things: **save-when-changed** (skip the
write if `rev` hasn't moved since the last save) and **stale-base detection**
(raise `StaleIntentGraphError` instead of clobbering a concurrent writer —
single-writer model, detect don't merge).

`ExperimentalS3IntentGraphStorage` has no dependency on `boto3` — it signs
requests with a built-in minimal SigV4 implementation (`ratel_ai._sigv4`) and
sends them with `urllib`.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from ._native import IntentGraph
from ._sigv4 import resolve_s3_endpoint, sign_s3_request

__all__ = [
    "ExperimentalIntentGraphStorage",
    "ExperimentalLocalFileIntentGraphStorage",
    "ExperimentalS3IntentGraphStorage",
    "ExperimentalS3IntentGraphStorageCredentials",
    "S3Request",
    "S3Response",
    "S3Transport",
    "StaleIntentGraphError",
]


class StaleIntentGraphError(RuntimeError):
    """Another writer saved a newer graph since this storage object's last load()/save()."""


_AWS_ERROR_CODE_RE = re.compile(r"<Code>([^<]*)</Code>")
_AWS_ERROR_MESSAGE_RE = re.compile(r"<Message>([^<]*)</Message>")


def _rev_of(serialized: str) -> int:
    """The ``rev`` carried inside a serialized graph.

    ``save()`` records this rather than re-reading ``graph.rev``, because the
    graph keeps mutating while a save is in flight: ``observe()`` on every
    confirmed invoke, and a centroid rebuild that runs with the GIL released,
    so ``rev`` can move between two native calls. ``to_json()`` serializes
    under one read lock, so the ``rev`` in those bytes is by construction the
    ``rev`` of the content being persisted.
    """
    return int(json.loads(serialized).get("rev", 0))


def _describe_s3_error(body: str) -> str | None:
    """Extract the AWS error code/message from an S3 error response body.

    Standard AWS XML error shape, for a more useful failure message than a bare
    status code — e.g. distinguishing ``SignatureDoesNotMatch`` from
    ``AccessDenied`` on a 403. Returns `None` for a body with no ``<Code>``
    (not an AWS-shaped error).
    """
    code_match = _AWS_ERROR_CODE_RE.search(body)
    if not code_match:
        return None
    code = code_match.group(1)
    message_match = _AWS_ERROR_MESSAGE_RE.search(body)
    return f"{code}: {message_match.group(1)}" if message_match else code


@runtime_checkable
class ExperimentalIntentGraphStorage(Protocol):
    """Host-owned persistence for an `IntentGraph`."""

    async def load(self) -> IntentGraph | None:
        """Load the stored graph, or `None` if nothing has been saved yet."""
        ...

    async def save(self, graph: IntentGraph) -> None:
        """Save `graph`, or skip if unchanged since the last save/load `rev`."""
        ...


class ExperimentalLocalFileIntentGraphStorage:
    """Local JSON file storage for an `IntentGraph` — the default backend.

    Writes atomically (temp file + `os.replace`) so a crash mid-write cannot
    leave a truncated file.
    """

    def __init__(self, path: str | os.PathLike[str]) -> None:
        """Store the graph at `path`. The parent directory must already exist."""
        self._path = Path(path)
        self._last_known_rev: int | None = None

    async def load(self) -> IntentGraph | None:
        """Load the stored graph, or `None` if nothing has been saved yet."""
        try:
            text = await asyncio.to_thread(self._path.read_text)
        except FileNotFoundError:
            self._last_known_rev = None
            return None
        graph = IntentGraph.from_json(text)
        self._last_known_rev = graph.rev
        return graph

    async def save(self, graph: IntentGraph) -> None:
        """Save `graph`, or skip if unchanged since the last save/load `rev`."""
        if self._last_known_rev == graph.rev:
            return

        body = graph.to_json()
        rev = _rev_of(body)

        disk_rev = await asyncio.to_thread(self._read_disk_rev)
        if disk_rev != self._last_known_rev:
            expected = self._last_known_rev if self._last_known_rev is not None else "none"
            found = disk_rev if disk_rev is not None else "none"
            raise StaleIntentGraphError(
                f"intent graph at {self._path} changed since load() (on-disk rev {found}, "
                f"expected {expected}); load() again and reapply your changes before saving"
            )

        await asyncio.to_thread(self._write_atomic, body)
        self._last_known_rev = rev

    def _read_disk_rev(self) -> int | None:
        try:
            text = self._path.read_text()
        except FileNotFoundError:
            return None
        rev = json.loads(text).get("rev", 0)
        return int(rev)

    def _write_atomic(self, contents: str) -> None:
        fd, tmp_path = tempfile.mkstemp(dir=self._path.parent, prefix=".tmp-")
        try:
            with os.fdopen(fd, "w") as f:
                f.write(contents)
            os.replace(tmp_path, self._path)
        except BaseException:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            raise


@dataclass(frozen=True)
class S3Request:
    """One S3 REST request, as `S3Transport` sends it."""

    method: str  # "GET" | "PUT"
    bucket: str
    key: str
    headers: dict[str, str]
    body: str | None = None


@dataclass(frozen=True)
class S3Response:
    """Response from an `S3Transport` call."""

    status: int
    headers: dict[str, str]
    body: str


@runtime_checkable
class S3Transport(Protocol):
    """Sends one signed S3 request.

    The default transport talks to real S3 over `urllib`; tests inject a fake
    to stay credential-free and offline.
    """

    async def send(self, request: S3Request) -> S3Response:
        """Send one S3 request and return its response."""
        ...


@dataclass(frozen=True)
class ExperimentalS3IntentGraphStorageCredentials:
    """Explicit AWS credentials.

    Falls back to ``AWS_ACCESS_KEY_ID``/``AWS_SECRET_ACCESS_KEY``/``AWS_SESSION_TOKEN``
    if omitted.
    """

    access_key_id: str
    secret_access_key: str
    session_token: str | None = None


def _credentials_from_env() -> ExperimentalS3IntentGraphStorageCredentials:
    access_key_id = os.environ.get("AWS_ACCESS_KEY_ID")
    secret_access_key = os.environ.get("AWS_SECRET_ACCESS_KEY")
    if not access_key_id or not secret_access_key:
        raise RuntimeError(
            "AWS credentials not found: pass `credentials` to "
            "ExperimentalS3IntentGraphStorage, or set AWS_ACCESS_KEY_ID / "
            "AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN for temporary credentials)."
        )
    return ExperimentalS3IntentGraphStorageCredentials(
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        session_token=os.environ.get("AWS_SESSION_TOKEN"),
    )


class _UrllibS3Transport:
    def __init__(
        self,
        region: str,
        credentials: ExperimentalS3IntentGraphStorageCredentials | None,
        endpoint: str | None = None,
        force_path_style: bool | None = None,
    ) -> None:
        self._region = region
        self._credentials = credentials
        self._endpoint = endpoint
        self._force_path_style = force_path_style

    async def send(self, request: S3Request) -> S3Response:
        return await asyncio.to_thread(self._send_sync, request)

    def _send_sync(self, request: S3Request) -> S3Response:
        creds = self._credentials or _credentials_from_env()
        target = resolve_s3_endpoint(
            bucket=request.bucket,
            key=request.key,
            region=self._region,
            endpoint=self._endpoint,
            force_path_style=self._force_path_style,
        )
        body = request.body or ""
        signed = sign_s3_request(
            method=request.method,
            host=target.host,
            path=target.path,
            headers=dict(request.headers),
            body=body,
            region=self._region,
            access_key_id=creds.access_key_id,
            secret_access_key=creds.secret_access_key,
            session_token=creds.session_token,
        )
        url = f"{target.scheme}://{target.host}{target.path}"
        data = body.encode("utf-8") if request.method == "PUT" else None
        http_request = Request(url, data=data, headers=signed.headers, method=request.method)
        try:
            with urlopen(http_request) as response:  # noqa: S310 - S3 REST API, https only
                response_body = response.read().decode("utf-8")
                headers = {k.lower(): v for k, v in response.headers.items()}
                return S3Response(status=response.status, headers=headers, body=response_body)
        except HTTPError as error:
            response_body = error.read().decode("utf-8")
            headers = {k.lower(): v for k, v in error.headers.items()} if error.headers else {}
            return S3Response(status=error.code, headers=headers, body=response_body)


class ExperimentalS3IntentGraphStorage:
    """S3-backed storage for an `IntentGraph`.

    No SDK dependency — signs requests with a built-in minimal SigV4
    implementation (`ratel_ai._sigv4.sign_s3_request`) and sends them with
    `urllib` (ADR-0025). Uses S3 conditional writes (``If-Match``/
    ``If-None-Match`` on the object's ETag) for stale-base detection; no
    bucket versioning required.
    """

    def __init__(
        self,
        *,
        bucket: str,
        key: str,
        region: str = "us-east-1",
        credentials: ExperimentalS3IntentGraphStorageCredentials | None = None,
        endpoint: str | None = None,
        force_path_style: bool | None = None,
        transport: S3Transport | None = None,
    ) -> None:
        """Store the graph at `s3://{bucket}/{key}` in `region`.

        `credentials` defaults to `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/
        `AWS_SESSION_TOKEN` if omitted. `endpoint` points at a custom
        S3-compatible service (e.g. `"http://localhost:9000"` for MinIO);
        omit for AWS S3. `force_path_style` defaults to `True` whenever
        `endpoint` is set (what MinIO and most self-hosted services
        require) — pass `False` for a custom endpoint that supports
        virtual-hosted style. `transport` overrides how requests are sent —
        inject a fake for tests.
        """
        self._bucket = bucket
        self._key = key
        self._transport: S3Transport = transport or _UrllibS3Transport(
            region, credentials, endpoint, force_path_style
        )
        self._last_known_etag: str | None = None
        self._last_known_rev: int | None = None

    async def load(self) -> IntentGraph | None:
        """Load the stored graph, or `None` if the object does not exist."""
        response = await self._transport.send(
            S3Request(method="GET", bucket=self._bucket, key=self._key, headers={})
        )
        if response.status == 404:
            self._last_known_etag = None
            self._last_known_rev = None
            return None
        if response.status != 200:
            detail = _describe_s3_error(response.body)
            raise RuntimeError(
                f"S3 GetObject failed for s3://{self._bucket}/{self._key} "
                f"with status {response.status}" + (f" ({detail})" if detail else "")
            )
        graph = IntentGraph.from_json(response.body)
        self._last_known_etag = response.headers.get("etag")
        self._last_known_rev = graph.rev
        return graph

    async def save(self, graph: IntentGraph) -> None:
        """Save `graph`, or skip if unchanged since the last save/load `rev`."""
        if self._last_known_rev == graph.rev:
            return

        headers = (
            {"if-match": self._last_known_etag}
            if self._last_known_etag is not None
            else {"if-none-match": "*"}
        )
        body = graph.to_json()
        rev = _rev_of(body)

        response = await self._transport.send(
            S3Request(
                method="PUT",
                bucket=self._bucket,
                key=self._key,
                headers=headers,
                body=body,
            )
        )
        if response.status == 412:
            raise StaleIntentGraphError(
                f"intent graph at s3://{self._bucket}/{self._key} changed since load(); "
                "load() again and reapply your changes before saving"
            )
        if response.status != 200:
            detail = _describe_s3_error(response.body)
            raise RuntimeError(
                f"S3 PutObject failed for s3://{self._bucket}/{self._key} "
                f"with status {response.status}" + (f" ({detail})" if detail else "")
            )
        self._last_known_etag = response.headers.get("etag")
        self._last_known_rev = rev
