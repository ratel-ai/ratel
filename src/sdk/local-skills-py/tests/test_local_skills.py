"""Tests for LocalSkillsLoader — mirrors `src/sdk/local-skills/src/local-skills-loader.test.ts`."""

from __future__ import annotations

from pathlib import Path

import pytest
from ratel_ai import SkillCatalog, attach_loader

from ratel_ai_local_skills import LocalSkillsLoader


def _write_skill(root: Path, name: str, content: str) -> None:
    directory = root / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "SKILL.md").write_text(content, encoding="utf-8")


# --- start & parse -----------------------------------------------------------


def test_defaults_dir_to_home_ratel_skills() -> None:
    assert LocalSkillsLoader().dir == Path.home() / ".ratel" / "skills"


def test_hydrates_catalog_from_skill_md_on_start(tmp_path: Path) -> None:
    _write_skill(
        tmp_path,
        "api-design",
        "---\ndescription: REST API design patterns, resource naming, pagination.\n"
        "---\n# API Design\n\nUse nouns for resources.",
    )
    _write_skill(
        tmp_path,
        "frontend-slides",
        "---\ndescription: Build animation-rich HTML presentations.\n---\n# Slides",
    )
    catalog = SkillCatalog()

    LocalSkillsLoader(tmp_path).start(catalog)

    assert catalog.size() == 2
    hits = catalog.search("design a REST endpoint with pagination", 5)
    assert hits[0].skill_id == "api-design"
    assert "Use nouns for resources." in catalog.invoke("api-design")


def test_frontmatter_id_beats_dirname_and_name_defaults_to_id(tmp_path: Path) -> None:
    _write_skill(tmp_path, "dir-name", "---\nid: real-id\ndescription: An explicit id.\n---\nbody")
    catalog = SkillCatalog()

    LocalSkillsLoader(tmp_path).start(catalog)

    assert catalog.has("real-id")
    assert not catalog.has("dir-name")
    assert catalog.get("real-id").name == "real-id"


def test_id_defaults_to_dirname_when_omitted(tmp_path: Path) -> None:
    _write_skill(tmp_path, "my-skill", "---\ndescription: no explicit id.\n---\nbody")
    catalog = SkillCatalog()

    LocalSkillsLoader(tmp_path).start(catalog)

    assert catalog.has("my-skill")


def test_optional_fields_default_to_empty(tmp_path: Path) -> None:
    _write_skill(tmp_path, "min", "---\ndescription: minimal skill.\n---\nbody")
    catalog = SkillCatalog()

    LocalSkillsLoader(tmp_path).start(catalog)

    skill = catalog.get("min")
    assert skill.tags == []
    assert skill.tools == []
    assert skill.metadata == {}


def test_round_trips_full_frontmatter(tmp_path: Path) -> None:
    _write_skill(
        tmp_path,
        "full",
        "\n".join(
            [
                "---",
                "id: full-skill",
                "name: Full Skill",
                "description: Everything set.",
                "tags: [frontend, login form]",
                "tools:",
                "  - read_file",
                "  - write_file",
                "metadata:",
                "  stacks: [react, next]",
                "  langs:",
                "    - ts",
                "---",
                "# Body",
            ]
        ),
    )
    catalog = SkillCatalog()

    LocalSkillsLoader(tmp_path).start(catalog)

    skill = catalog.get("full-skill")
    assert skill.name == "Full Skill"
    assert skill.description == "Everything set."
    assert skill.tags == ["frontend", "login form"]
    assert skill.tools == ["read_file", "write_file"]
    assert skill.metadata == {"stacks": ["react", "next"], "langs": ["ts"]}


def test_extracts_body_verbatim_trimming_leading_blank_lines(tmp_path: Path) -> None:
    _write_skill(tmp_path, "b", "---\ndescription: d\n---\n\n\n# Title\n\nLine 1\n  indented\n")
    catalog = SkillCatalog()

    LocalSkillsLoader(tmp_path).start(catalog)

    assert catalog.invoke("b") == "# Title\n\nLine 1\n  indented\n"


def test_skips_malformed_files_loads_siblings_and_records_diagnostics(tmp_path: Path) -> None:
    _write_skill(tmp_path, "good", "---\ndescription: a good skill.\n---\nbody")
    _write_skill(tmp_path, "no-fence", "no frontmatter here")
    _write_skill(tmp_path, "no-desc", "---\nname: x\n---\nbody")
    catalog = SkillCatalog()
    loader = LocalSkillsLoader(tmp_path)

    loader.start(catalog)

    assert catalog.has("good")
    assert catalog.size() == 1
    assert len(loader.diagnostics) == 2
    assert any("no-fence" in d.path for d in loader.diagnostics)
    assert any("no-desc" in d.path for d in loader.diagnostics)


def test_diagnoses_wrong_typed_field(tmp_path: Path) -> None:
    _write_skill(tmp_path, "bad-tags", "---\ndescription: d\ntags: not-a-list\n---\nbody")
    catalog = SkillCatalog()
    loader = LocalSkillsLoader(tmp_path)

    loader.start(catalog)

    assert not catalog.has("bad-tags")
    assert "tags" in loader.diagnostics[0].reason


def test_starts_empty_when_directory_missing(tmp_path: Path) -> None:
    catalog = SkillCatalog()
    loader = LocalSkillsLoader(tmp_path / "does-not-exist")

    loader.start(catalog)

    assert catalog.size() == 0
    assert loader.diagnostics == []


def test_ignores_directories_without_skill_md(tmp_path: Path) -> None:
    (tmp_path / "empty-dir").mkdir()
    _write_skill(tmp_path, "real", "---\ndescription: d\n---\nbody")
    catalog = SkillCatalog()
    loader = LocalSkillsLoader(tmp_path)

    loader.start(catalog)

    assert catalog.size() == 1
    assert loader.diagnostics == []


def test_duplicate_id_first_wins_and_diagnoses_rest(tmp_path: Path) -> None:
    _write_skill(tmp_path, "a-dir", "---\nid: dup\ndescription: first wins.\n---\nfirst")
    _write_skill(tmp_path, "b-dir", "---\nid: dup\ndescription: second loses.\n---\nsecond")
    catalog = SkillCatalog()
    loader = LocalSkillsLoader(tmp_path)

    loader.start(catalog)

    assert catalog.size() == 1
    assert catalog.invoke("dup") == "first"
    assert any("duplicate" in d.reason and "b-dir" in d.path for d in loader.diagnostics)


def test_second_start_without_stop_raises(tmp_path: Path) -> None:
    _write_skill(tmp_path, "s", "---\ndescription: d\n---\nbody")
    catalog = SkillCatalog()
    loader = LocalSkillsLoader(tmp_path)
    loader.start(catalog)

    with pytest.raises(RuntimeError, match="already started"):
        loader.start(catalog)


# --- refresh & lifecycle -----------------------------------------------------


def test_refresh_before_start_raises(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="not started"):
        LocalSkillsLoader(tmp_path).refresh()


def test_refresh_adds_new_skills(tmp_path: Path) -> None:
    _write_skill(tmp_path, "first", "---\ndescription: the first skill.\n---\nbody")
    catalog = SkillCatalog()
    loader = LocalSkillsLoader(tmp_path)
    loader.start(catalog)
    assert catalog.size() == 1

    _write_skill(tmp_path, "second", "---\ndescription: the second skill.\n---\nbody")
    loader.refresh()

    assert catalog.size() == 2
    assert catalog.has("second")


def test_refresh_serves_updated_body(tmp_path: Path) -> None:
    _write_skill(tmp_path, "s", "---\ndescription: d\n---\noriginal body")
    catalog = SkillCatalog()
    loader = LocalSkillsLoader(tmp_path)
    loader.start(catalog)
    assert catalog.invoke("s") == "original body"

    _write_skill(tmp_path, "s", "---\ndescription: d\n---\nrewritten body")
    loader.refresh()

    assert catalog.size() == 1
    assert catalog.invoke("s") == "rewritten body"


def test_refresh_removes_vanished_skill(tmp_path: Path) -> None:
    import shutil

    _write_skill(tmp_path, "keep", "---\ndescription: keeper.\n---\nbody")
    _write_skill(tmp_path, "drop", "---\ndescription: goner.\n---\nbody")
    catalog = SkillCatalog()
    loader = LocalSkillsLoader(tmp_path)
    loader.start(catalog)
    assert catalog.size() == 2

    shutil.rmtree(tmp_path / "drop")
    loader.refresh()

    assert catalog.has("keep")
    assert not catalog.has("drop")
    assert catalog.size() == 1


def test_refresh_never_removes_foreign_skill(tmp_path: Path) -> None:
    from ratel_ai import Skill

    _write_skill(tmp_path, "owned", "---\ndescription: loader-owned.\n---\nbody")
    catalog = SkillCatalog()
    loader = LocalSkillsLoader(tmp_path)
    loader.start(catalog)
    catalog.upsert(Skill(id="foreign", name="foreign", description="put here by someone else"))
    assert catalog.size() == 2

    loader.refresh()

    assert catalog.has("foreign")
    assert catalog.has("owned")


def test_refresh_skips_unchanged_files(tmp_path: Path) -> None:
    _write_skill(tmp_path, "a", "---\ndescription: skill a.\n---\nbody a")
    _write_skill(tmp_path, "b", "---\ndescription: skill b.\n---\nbody b")
    catalog = SkillCatalog()
    loader = LocalSkillsLoader(tmp_path)
    loader.start(catalog)

    changes = []
    catalog.on_change(lambda: changes.append(1))
    _write_skill(tmp_path, "b", "---\ndescription: skill b.\n---\nbody b rewritten")
    loader.refresh()

    assert len(changes) == 1
    assert catalog.invoke("a") == "body a"
    assert catalog.invoke("b") == "body b rewritten"


def test_stop_keeps_skills_and_start_after_stop_rescans(tmp_path: Path) -> None:
    _write_skill(tmp_path, "s", "---\ndescription: d\n---\nbody")
    catalog = SkillCatalog()
    loader = LocalSkillsLoader(tmp_path)
    loader.start(catalog)

    loader.stop()
    assert catalog.has("s")
    assert loader.diagnostics == []

    _write_skill(tmp_path, "t", "---\ndescription: added while stopped.\n---\nbody")
    loader.start(catalog)
    assert catalog.size() == 2
    assert catalog.has("t")


async def test_integrates_with_attach_loader(tmp_path: Path) -> None:
    _write_skill(tmp_path, "one", "---\ndescription: skill one.\n---\nbody one")
    catalog = SkillCatalog()

    handle = await attach_loader(catalog, LocalSkillsLoader(tmp_path))
    assert catalog.has("one")

    _write_skill(tmp_path, "two", "---\ndescription: skill two.\n---\nbody two")
    await handle.refresh()
    assert catalog.size() == 2
    assert catalog.has("two")

    await handle.detach()
    assert catalog.has("one")
