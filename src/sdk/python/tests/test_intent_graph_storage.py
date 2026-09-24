"""Host-owned intent graph persistence: local file and S3 backends (ADR-0025)."""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import pytest

from ratel_ai import ExecutableTool, IntentGraph, ToolCatalog
from ratel_ai._sigv4 import resolve_s3_endpoint, sign_s3_request
from ratel_ai.intent_graph_storage import (
    ExperimentalLocalFileIntentGraphStorage,
    ExperimentalS3IntentGraphStorage,
    ExperimentalS3IntentGraphStorageCredentials,
    S3Request,
    S3Response,
    StaleIntentGraphError,
)


def _graph_json(rev: int) -> str:
    return json.dumps({"v": 1, "built_from_ts": 0, "rev": rev, "intents": []})


async def _learning_catalog() -> ToolCatalog:
    """A catalog that learns, so `rev` moves through the real observation path."""
    catalog = ToolCatalog()
    await catalog.register(
        [
            ExecutableTool(
                id="gh_run_list",
                name="gh_run_list",
                description="List CI workflow runs and whether the build passed",
                execute=lambda _args: "listed",
            ),
            ExecutableTool(
                id="docker_build",
                name="docker_build",
                description="Build a Docker image from a Dockerfile",
                execute=lambda _args: "built",
            ),
        ]
    )
    return catalog


async def _use_it(catalog: ToolCatalog, query: str, chosen: str) -> None:
    """One confirmed observation: search, then invoke what you wanted. Bumps `rev`."""
    catalog.search(query, 5)
    await catalog.invoke(chosen, {})


class TestExperimentalLocalFileIntentGraphStorage:
    async def test_load_returns_none_when_file_does_not_exist(self, tmp_path: Path) -> None:
        storage = ExperimentalLocalFileIntentGraphStorage(tmp_path / "intent-graph.json")
        assert await storage.load() is None

    async def test_round_trips_a_saved_graph_preserving_rev(self, tmp_path: Path) -> None:
        path = tmp_path / "intent-graph.json"
        storage = ExperimentalLocalFileIntentGraphStorage(path)
        await storage.save(IntentGraph.from_json(_graph_json(3)))

        other = ExperimentalLocalFileIntentGraphStorage(path)
        loaded = await other.load()
        assert loaded is not None
        assert loaded.rev == 3

    async def test_writes_atomically_leaving_no_temp_file_behind(self, tmp_path: Path) -> None:
        path = tmp_path / "intent-graph.json"
        storage = ExperimentalLocalFileIntentGraphStorage(path)
        await storage.save(IntentGraph.from_json(_graph_json(1)))

        assert json.loads(path.read_text())["rev"] == 1
        assert all(not p.name.startswith(".tmp-") for p in tmp_path.iterdir())

    async def test_skips_write_when_rev_unchanged_since_last_save(self, tmp_path: Path) -> None:
        path = tmp_path / "intent-graph.json"
        storage = ExperimentalLocalFileIntentGraphStorage(path)
        graph = IntentGraph.from_json(_graph_json(5))
        await storage.save(graph)
        first_mtime = path.stat().st_mtime_ns

        await storage.save(graph)
        assert path.stat().st_mtime_ns == first_mtime

    async def test_raises_stale_error_when_on_disk_rev_moved_since_load(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "intent-graph.json"
        writer1 = ExperimentalLocalFileIntentGraphStorage(path)
        await writer1.save(IntentGraph.from_json(_graph_json(1)))

        reader = ExperimentalLocalFileIntentGraphStorage(path)
        loaded = await reader.load()
        assert loaded is not None
        assert loaded.rev == 1

        # Someone else loads the current graph and advances it on disk.
        writer2 = ExperimentalLocalFileIntentGraphStorage(path)
        await writer2.load()
        await writer2.save(IntentGraph.from_json(_graph_json(2)))

        # reader now has its own local change (rev 3); saving it should detect the
        # clobber, since reader's base (rev 1) no longer matches what's on disk (rev 2).
        with pytest.raises(StaleIntentGraphError):
            await reader.save(IntentGraph.from_json(_graph_json(3)))

    async def test_raises_stale_error_on_first_save_if_file_exists_and_never_loaded(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "intent-graph.json"
        writer1 = ExperimentalLocalFileIntentGraphStorage(path)
        await writer1.save(IntentGraph.from_json(_graph_json(1)))

        blind_writer = ExperimentalLocalFileIntentGraphStorage(path)
        with pytest.raises(StaleIntentGraphError):
            await blind_writer.save(IntentGraph.from_json(_graph_json(1)))


class TestSignS3Request:
    _base_kwargs = {
        "method": "GET",
        "host": "examplebucket.s3.amazonaws.com",
        "path": "/test.txt",
        "headers": {"range": "bytes=0-9"},
        "body": "",
        "region": "us-east-1",
        "access_key_id": "AKIAIOSFODNN7EXAMPLE",
        "secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "date": datetime(2013, 5, 24, tzinfo=timezone.utc),
    }

    def test_is_deterministic_for_identical_inputs(self) -> None:
        a = sign_s3_request(**self._base_kwargs).headers["authorization"]
        b = sign_s3_request(**self._base_kwargs).headers["authorization"]
        assert a == b

    def test_changes_signature_when_secret_key_changes(self) -> None:
        a = sign_s3_request(**self._base_kwargs).headers["authorization"]
        b = sign_s3_request(**{**self._base_kwargs, "secret_access_key": "different"}).headers[
            "authorization"
        ]
        assert a != b

    def test_changes_signature_when_body_changes(self) -> None:
        a = sign_s3_request(**self._base_kwargs).headers["authorization"]
        b = sign_s3_request(**{**self._base_kwargs, "body": "some content"}).headers[
            "authorization"
        ]
        assert a != b

    def test_builds_canonical_signed_headers_per_sigv4_spec(self) -> None:
        # https://docs.aws.amazon.com/general/latest/gr/create-signed-request.html
        signed = sign_s3_request(**self._base_kwargs)
        assert "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date" in signed.headers[
            "authorization"
        ]
        assert (
            "Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request"
            in signed.headers["authorization"]
        )

    def test_hashes_empty_body_to_well_known_sha256_empty_digest(self) -> None:
        signed = sign_s3_request(**self._base_kwargs)
        assert signed.headers["x-amz-content-sha256"] == hashlib.sha256(b"").hexdigest()


class TestResolveS3Endpoint:
    def test_defaults_to_aws_virtual_hosted_style_when_no_endpoint_is_given(self) -> None:
        target = resolve_s3_endpoint(
            bucket="my-bucket", key="intent-graph.json", region="eu-central-1"
        )
        assert target.scheme == "https"
        assert target.host == "my-bucket.s3.eu-central-1.amazonaws.com"
        assert target.path == "/intent-graph.json"

    def test_defaults_to_path_style_once_a_custom_endpoint_is_set(self) -> None:
        target = resolve_s3_endpoint(
            bucket="my-bucket",
            key="intent-graph.json",
            region="us-east-1",
            endpoint="http://localhost:9000",
        )
        assert target.scheme == "http"
        assert target.host == "localhost:9000"
        assert target.path == "/my-bucket/intent-graph.json"

    def test_honors_force_path_style_false_for_virtual_hosted_custom_endpoint(self) -> None:
        target = resolve_s3_endpoint(
            bucket="my-bucket",
            key="intent-graph.json",
            region="auto",
            endpoint="https://minio.internal:9000",
            force_path_style=False,
        )
        assert target.scheme == "https"
        assert target.host == "my-bucket.minio.internal:9000"
        assert target.path == "/intent-graph.json"

    def test_preserves_a_non_default_port_in_the_host(self) -> None:
        target = resolve_s3_endpoint(
            bucket="b", key="k", region="us-east-1", endpoint="https://minio.internal:9000"
        )
        assert target.host == "minio.internal:9000"

    def test_percent_encodes_special_characters_in_the_key_under_path_style(self) -> None:
        target = resolve_s3_endpoint(
            bucket="my-bucket",
            key="a!b*c'd(e)f",
            region="us-east-1",
            endpoint="http://localhost:9000",
        )
        assert target.path == "/my-bucket/a%21b%2Ac%27d%28e%29f"


@dataclass
class _StoredObject:
    body: str
    etag: str


class _FakeS3Transport:
    """In-memory S3 stand-in: enough conditional-write semantics to test against."""

    def __init__(self) -> None:
        self.store: dict[str, _StoredObject] = {}
        self._etag_counter = 0
        self.calls: list[S3Request] = []

    async def send(self, request: S3Request) -> S3Response:
        self.calls.append(request)
        key = f"{request.bucket}/{request.key}"
        if request.method == "GET":
            entry = self.store.get(key)
            if entry is None:
                return S3Response(status=404, headers={}, body="")
            return S3Response(status=200, headers={"etag": entry.etag}, body=entry.body)

        # PUT
        existing = self.store.get(key)
        if_match = request.headers.get("if-match")
        if_none_match = request.headers.get("if-none-match")
        if if_none_match == "*" and existing is not None:
            return S3Response(status=412, headers={}, body="")
        if if_match is not None and (existing is None or existing.etag != if_match):
            return S3Response(status=412, headers={}, body="")

        self._etag_counter += 1
        etag = f'"etag-{self._etag_counter}"'
        self.store[key] = _StoredObject(body=request.body or "", etag=etag)
        return S3Response(status=200, headers={"etag": etag}, body="")


class _FixedResponseS3Transport:
    """Always returns the same canned response(s), regardless of the request."""

    def __init__(
        self, get_response: S3Response | None = None, put_response: S3Response | None = None
    ) -> None:
        # A single positional response applies to both GET and PUT.
        self._get_response = get_response
        self._put_response = put_response if put_response is not None else get_response

    async def send(self, request: S3Request) -> S3Response:
        response = self._get_response if request.method == "GET" else self._put_response
        assert response is not None
        return response


_CREDENTIALS = ExperimentalS3IntentGraphStorageCredentials(
    access_key_id="AKIA", secret_access_key="secret"
)


class TestExperimentalS3IntentGraphStorage:
    async def test_load_returns_none_when_object_does_not_exist(self) -> None:
        transport = _FakeS3Transport()
        storage = ExperimentalS3IntentGraphStorage(
            bucket="my-bucket",
            key="intent-graph.json",
            credentials=_CREDENTIALS,
            transport=transport,
        )
        assert await storage.load() is None

    async def test_round_trips_a_saved_graph_through_the_fake_transport(self) -> None:
        transport = _FakeS3Transport()
        storage = ExperimentalS3IntentGraphStorage(
            bucket="my-bucket",
            key="intent-graph.json",
            credentials=_CREDENTIALS,
            transport=transport,
        )
        await storage.save(IntentGraph.from_json(_graph_json(7)))

        other = ExperimentalS3IntentGraphStorage(
            bucket="my-bucket",
            key="intent-graph.json",
            credentials=_CREDENTIALS,
            transport=transport,
        )
        loaded = await other.load()
        assert loaded is not None
        assert loaded.rev == 7

    async def test_skips_put_when_rev_unchanged_since_last_save(self) -> None:
        transport = _FakeS3Transport()
        storage = ExperimentalS3IntentGraphStorage(
            bucket="my-bucket",
            key="intent-graph.json",
            credentials=_CREDENTIALS,
            transport=transport,
        )
        graph = IntentGraph.from_json(_graph_json(2))
        await storage.save(graph)
        calls_after_first_save = len(transport.calls)

        await storage.save(graph)
        assert len(transport.calls) == calls_after_first_save

    async def test_raises_stale_error_on_conditional_write_412(self) -> None:
        transport = _FakeS3Transport()
        options = dict(bucket="my-bucket", key="intent-graph.json", credentials=_CREDENTIALS)
        writer_a = ExperimentalS3IntentGraphStorage(**options, transport=transport)
        writer_b = ExperimentalS3IntentGraphStorage(**options, transport=transport)

        await writer_a.save(IntentGraph.from_json(_graph_json(1)))
        await writer_b.load()  # B observes rev 1 / the current etag

        await writer_a.save(IntentGraph.from_json(_graph_json(2)))  # A advances it first

        with pytest.raises(StaleIntentGraphError):
            await writer_b.save(IntentGraph.from_json(_graph_json(2)))

    async def test_persists_a_turn_that_lands_while_a_save_is_in_flight(self) -> None:
        # `rev` must be read out of the bytes being written, not from the graph
        # after the await: the graph keeps learning during the save, and
        # recording the newer rev against older content makes the next save skip
        # that turn for good (save-when-changed sees no change).
        catalog = await _learning_catalog()
        graph = IntentGraph()
        catalog.experimental_enable_adaptive_ranking(graph)

        state: dict[str, object] = {"stored": "", "etag": 0, "hold": False}
        held = asyncio.Event()

        class _GatedTransport:
            async def send(self, request: S3Request) -> S3Response:
                if request.method == "GET":
                    stored = str(state["stored"])
                    if not stored:
                        return S3Response(status=404, headers={}, body="")
                    return S3Response(
                        status=200, headers={"etag": f'"etag-{state["etag"]}"'}, body=stored
                    )
                if state["hold"]:
                    await held.wait()
                state["stored"] = request.body or ""
                state["etag"] = int(state["etag"]) + 1  # type: ignore[call-overload]
                return S3Response(
                    status=200, headers={"etag": f'"etag-{state["etag"]}"'}, body=""
                )

        storage = ExperimentalS3IntentGraphStorage(
            bucket="my-bucket",
            key="intent-graph.json",
            credentials=_CREDENTIALS,
            transport=_GatedTransport(),
        )

        await _use_it(catalog, "why is the build broken", "gh_run_list")
        await storage.save(graph)

        await _use_it(catalog, "is the build broken again", "gh_run_list")
        state["hold"] = True
        in_flight = asyncio.create_task(storage.save(graph))
        await asyncio.sleep(0)  # let the save reach the gate
        await _use_it(catalog, "build broken on main", "gh_run_list")  # lands mid-save
        held.set()
        await in_flight

        state["hold"] = False
        await storage.save(graph)

        assert json.loads(str(state["stored"]))["rev"] == graph.rev

    async def test_load_surfaces_aws_error_code_and_message(self) -> None:
        transport = _FixedResponseS3Transport(
            S3Response(
                status=403,
                headers={},
                body=(
                    '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>SignatureDoesNotMatch'
                    "</Code><Message>The request signature we calculated does not match the "
                    "signature you provided.</Message></Error>"
                ),
            )
        )
        storage = ExperimentalS3IntentGraphStorage(
            bucket="my-bucket",
            key="intent-graph.json",
            credentials=_CREDENTIALS,
            transport=transport,
        )
        with pytest.raises(
            RuntimeError,
            match=r"status 403 \(SignatureDoesNotMatch: The request signature we calculated "
            r"does not match the signature you provided\.\)",
        ):
            await storage.load()

    async def test_save_surfaces_aws_error_code_and_message(self) -> None:
        transport = _FixedResponseS3Transport(
            get_response=S3Response(status=404, headers={}, body=""),
            put_response=S3Response(
                status=403,
                headers={},
                body=(
                    '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code>'
                    "<Message>Access Denied</Message></Error>"
                ),
            ),
        )
        storage = ExperimentalS3IntentGraphStorage(
            bucket="my-bucket",
            key="intent-graph.json",
            credentials=_CREDENTIALS,
            transport=transport,
        )
        with pytest.raises(RuntimeError, match=r"status 403 \(AccessDenied: Access Denied\)"):
            await storage.save(IntentGraph.from_json(_graph_json(1)))

    async def test_falls_back_to_bare_status_when_body_has_no_aws_code(self) -> None:
        transport = _FixedResponseS3Transport(
            S3Response(status=500, headers={}, body="Internal Server Error")
        )
        storage = ExperimentalS3IntentGraphStorage(
            bucket="my-bucket",
            key="intent-graph.json",
            credentials=_CREDENTIALS,
            transport=transport,
        )
        with pytest.raises(RuntimeError, match=r"status 500$"):
            await storage.load()
