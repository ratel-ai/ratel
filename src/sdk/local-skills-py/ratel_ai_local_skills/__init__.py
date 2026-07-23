"""ratel-ai-local-skills — the Python mirror of `src/sdk/local-skills`.

The reference `CatalogLoader`: hydrate a `SkillCatalog` from a directory of
`<name>/SKILL.md` files (the `.claude/skills` convention; default
`~/.ratel/skills`, ADR-0005). It is the first loader package on the SDK's loader
seam (ADR-0003) — shipped separately so the SDK stays dependency-lean and owns
neither the filesystem scan nor the YAML dependency.

The lifecycle methods are plain synchronous `def`s (idiomatic for local disk);
they conform to the `CatalogLoader` Protocol structurally, and `attach_loader`
absorbs the sync return.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import yaml
from ratel_ai import CatalogLoader, Skill, SkillCatalog

__all__ = ["LocalSkillDiagnostic", "LocalSkillsLoader"]


@dataclass
class LocalSkillDiagnostic:
    """A file the loader could not turn into a skill, and why. Replaced per scan."""

    path: str
    reason: str


class LocalSkillsLoader(CatalogLoader):
    """Load a directory of `<name>/SKILL.md` files into a `SkillCatalog`.

    Non-recursive, sorted scan — only immediate `<dir>/<name>/SKILL.md` files
    count; a subdirectory without a SKILL.md is ignored. Each file is YAML
    frontmatter (fenced by `---` at byte 0) plus a Markdown body. A bad file is
    skipped and recorded on `diagnostics` rather than failing the whole scan.
    """

    def __init__(self, dir: str | Path | None = None) -> None:
        """Create a loader for `dir` (default `~/.ratel/skills`).

        Args:
            dir: directory of `<name>/SKILL.md` folders to load.
        """
        self.dir: Path = Path(dir) if dir is not None else Path.home() / ".ratel" / "skills"
        self._catalog: SkillCatalog | None = None
        # id -> raw file text of the last-synced version: the change fingerprint
        # and the set of ids this loader owns (refresh never removes others').
        self._loaded: dict[str, str] = {}
        self._diagnostics: list[LocalSkillDiagnostic] = []

    @property
    def diagnostics(self) -> list[LocalSkillDiagnostic]:
        """Files skipped by the most recent scan, and why. Empty after a clean scan."""
        return self._diagnostics

    async def start(self, catalog: SkillCatalog) -> None:
        """Store the catalog, scan once, and `upsert` every valid skill.

        Args:
            catalog: the catalog to hydrate and keep in sync.

        Raises:
            RuntimeError: if the loader is already started.
        """
        if self._catalog is not None:
            raise RuntimeError("loader already started; stop it before starting again")
        self._catalog = catalog
        await self._sync()

    async def refresh(self) -> None:
        """Re-scan now: upsert new/changed files, remove vanished loaded ids.

        Raw-text equality is the change fingerprint, so an untouched file is not
        re-embedded. Only ids this loader loaded are removed — never foreign
        skills another writer put in the catalog.

        Raises:
            RuntimeError: if called before `start`.
        """
        if self._catalog is None:
            raise RuntimeError("loader not started; call start(catalog) first")
        await self._sync()

    def stop(self) -> None:
        """Forget the catalog and the loaded-set; the skills stay in the catalog.

        ADR-0003 offline semantics: the last-synced catalog survives. Restartable;
        a no-op before `start`. No filesystem watcher is torn down (there is none).
        """
        self._catalog = None
        self._loaded = {}
        self._diagnostics = []

    async def _sync(self) -> None:
        """One scan-and-reconcile pass against the current catalog."""
        catalog = self._catalog
        if catalog is None:
            return  # unreachable: start/refresh guard first
        skills, diagnostics = self._scan()
        nxt: dict[str, str] = {}
        for skill_id, (skill, raw) in skills.items():
            nxt[skill_id] = raw
            if self._loaded.get(skill_id) != raw:
                await catalog.upsert(skill)
        for skill_id in self._loaded:
            if skill_id not in nxt:
                catalog.remove(skill_id)
        self._loaded = nxt
        self._diagnostics = diagnostics

    def _scan(self) -> tuple[dict[str, tuple[Skill, str]], list[LocalSkillDiagnostic]]:
        """Read every `<dir>/<name>/SKILL.md`, parsing each; collect skills + diagnostics."""
        skills: dict[str, tuple[Skill, str]] = {}
        diagnostics: list[LocalSkillDiagnostic] = []

        try:
            entries = sorted((p for p in self.dir.iterdir() if p.is_dir()), key=lambda p: p.name)
        except FileNotFoundError:
            return skills, diagnostics  # missing dir -> empty, not an error

        for entry in entries:
            file = entry / "SKILL.md"
            try:
                raw = file.read_text(encoding="utf-8")
            except FileNotFoundError:
                continue  # a directory without a SKILL.md is ignored
            except OSError as err:
                diagnostics.append(LocalSkillDiagnostic(str(file), f"cannot read file: {err}"))
                continue

            parsed = _parse_skill_file(raw, entry.name)
            if isinstance(parsed, str):
                diagnostics.append(LocalSkillDiagnostic(str(file), parsed))
                continue
            if parsed.id in skills:
                diagnostics.append(
                    LocalSkillDiagnostic(
                        str(file), f'duplicate id "{parsed.id}" (first sorted directory wins)'
                    )
                )
                continue
            skills[parsed.id] = (parsed, raw)
        return skills, diagnostics


def _parse_skill_file(raw: str, dir_name: str) -> Skill | str:
    """Parse one SKILL.md into a `Skill`, or return a reason string it can't be."""
    split = _split_frontmatter(raw)
    if split is None:
        return "missing YAML frontmatter (expected a --- fence at byte 0)"
    yaml_text, body = split

    try:
        data = yaml.safe_load(yaml_text)
    except yaml.YAMLError as err:
        return f"invalid YAML frontmatter: {err}"
    if data is None:
        data = {}
    if not isinstance(data, dict):
        return "frontmatter is not a mapping"

    raw_id = data.get("id", dir_name)
    if not isinstance(raw_id, str) or not raw_id:
        return "field `id` must be a non-empty string"
    name = data.get("name", raw_id)
    if not isinstance(name, str):
        return "field `name` must be a string"
    description = data.get("description")
    if not isinstance(description, str) or not description:
        return "field `description` is required and must be a non-empty string"

    tags = _as_string_list(data.get("tags"), "tags")
    if isinstance(tags, str):
        return tags
    tools = _as_string_list(data.get("tools"), "tools")
    if isinstance(tools, str):
        return tools
    metadata = _as_string_list_map(data.get("metadata"), "metadata")
    if isinstance(metadata, str):
        return metadata

    return Skill(
        id=raw_id,
        name=name,
        description=description,
        tags=tags,
        tools=tools,
        metadata=metadata,
        body=body,
    )


def _split_frontmatter(raw: str) -> tuple[str, str] | None:
    """Split a `---`-fenced document into its YAML head and Markdown body."""
    if re.match(r"^---\r?\n", raw) is None:
        return None
    lines = re.split(r"\r?\n", raw)
    end = -1
    for i in range(1, len(lines)):
        if lines[i] == "---":
            end = i
            break
    if end == -1:
        return None  # no closing fence
    yaml_text = "\n".join(lines[1:end])
    # Body is verbatim after the fence, minus any leading blank lines.
    body = re.sub(r"^(?:[ \t]*\n)+", "", "\n".join(lines[end + 1 :]))
    return yaml_text, body


def _as_string_list(value: object, field: str) -> list[str] | str:
    """Coerce a frontmatter value to a `list[str]` (empty if absent), or an error reason."""
    if value is None:
        return []
    if not isinstance(value, list):
        return f"field `{field}` must be a list of strings"
    result: list[str] = []
    for item in value:
        if not isinstance(item, str):
            return f"field `{field}` must be a list of strings"
        result.append(item)
    return result


def _as_string_list_map(value: object, field: str) -> dict[str, list[str]] | str:
    """Coerce a frontmatter value to a `dict[str, list[str]]` (empty if absent), or an error."""
    if value is None:
        return {}
    if not isinstance(value, dict):
        return f"field `{field}` must be a mapping of string lists"
    out: dict[str, list[str]] = {}
    for key, entry in value.items():
        inner = _as_string_list(entry, f"{field}.{key}")
        if isinstance(inner, str):
            return inner
        out[str(key)] = inner
    return out
