"""Tests for the catalog-source config seam (`ratel_ai.source`)."""

from ratel_ai.source import SourceConfig, SourceOptions, resolve_source_config


def test_resolves_url_and_api_key_from_env() -> None:
    config = resolve_source_config(
        env={"RATEL_URL": "https://cloud.ratel.sh", "RATEL_API_KEY": "sk-test"}
    )
    assert config == SourceConfig(url="https://cloud.ratel.sh", api_key="sk-test", scope=None)


def test_explicit_options_beat_the_environment() -> None:
    config = resolve_source_config(
        SourceOptions(url="https://self-hosted.example", api_key="sk-opt"),
        env={"RATEL_URL": "https://cloud.ratel.sh", "RATEL_API_KEY": "sk-env"},
    )
    assert config == SourceConfig(url="https://self-hosted.example", api_key="sk-opt", scope=None)


def test_option_url_with_env_api_key_composes() -> None:
    config = resolve_source_config(
        SourceOptions(url="https://self-hosted.example"),
        env={"RATEL_API_KEY": "sk-env"},
    )
    assert config == SourceConfig(url="https://self-hosted.example", api_key="sk-env", scope=None)


def test_no_url_anywhere_is_the_embedded_floor() -> None:
    assert resolve_source_config(env={}) is None
    assert resolve_source_config(SourceOptions(api_key="sk-only"), env={}) is None
    assert resolve_source_config(env={"RATEL_URL": ""}) is None


def test_scope_comes_from_options_only() -> None:
    config = resolve_source_config(
        SourceOptions(scope="user:alice"),
        env={"RATEL_URL": "https://cloud.ratel.sh", "RATEL_SCOPE": "user:bob"},
    )
    assert config is not None
    assert config.scope == "user:alice"

    from_env_only = resolve_source_config(env={"RATEL_URL": "https://cloud.ratel.sh"})
    assert from_env_only is not None
    assert from_env_only.api_key is None
    assert from_env_only.scope is None
