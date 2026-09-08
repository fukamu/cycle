#!/usr/bin/env python3
"""Validate the canonical playbook or a self-contained consumer adoption."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote


RULE_HEADING = re.compile(r"^### (?P<id>PE-[A-Z]{3}-\d{3}) — .+$")
RULE_METADATA = re.compile(
    r"^`(?P<level>MUST|MUST NOT|SHOULD|SHOULD NOT|MAY)` "
    r"· override: `(?P<override>never|approved)`$"
)
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
MARKDOWN_LINK = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
GITHUB_URL = re.compile(r"^https://github\.com/[^/]+/[^/]+/(issues|pull)/\d+(?:#.*)?$")


@dataclass(frozen=True)
class Rule:
    rule_id: str
    level: str
    override: str


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(64 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path, errors: list[str]) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        errors.append(f"missing file: {path}")
    except json.JSONDecodeError as exc:
        errors.append(f"invalid JSON in {path}: {exc}")
    return None


def parse_playbook(path: Path) -> tuple[str | None, dict[str, Rule], list[str]]:
    errors: list[str] = []
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None, {}, [f"missing playbook: {path}"]

    version_match = re.search(r"^Version: (\S+)$", text, re.MULTILINE)
    version = version_match.group(1) if version_match else None
    if version is None or SEMVER.fullmatch(version) is None:
        errors.append(f"{path}: Version must be an exact semantic version")

    lines = text.splitlines()
    rules: dict[str, Rule] = {}
    for index, line in enumerate(lines):
        heading = RULE_HEADING.fullmatch(line)
        if heading is None:
            if line.startswith("### PE-"):
                errors.append(f"{path}:{index + 1}: malformed rule heading")
            continue
        rule_id = heading.group("id")
        if rule_id in rules:
            errors.append(f"{path}:{index + 1}: duplicate rule id {rule_id}")
            continue
        if index + 1 >= len(lines):
            errors.append(f"{path}:{index + 1}: missing metadata for {rule_id}")
            continue
        metadata = RULE_METADATA.fullmatch(lines[index + 1])
        if metadata is None:
            errors.append(
                f"{path}:{index + 2}: invalid metadata for {rule_id}; "
                "expected a normative level and override mode"
            )
            continue
        rules[rule_id] = Rule(
            rule_id=rule_id,
            level=metadata.group("level"),
            override=metadata.group("override"),
        )

    if not rules:
        errors.append(f"{path}: no rule ids found")
    return version, rules, errors


def validate_markdown_links(root: Path) -> list[str]:
    errors: list[str] = []
    for markdown in sorted(root.rglob("*.md")):
        if ".git" in markdown.parts:
            continue
        text = markdown.read_text(encoding="utf-8")
        for raw_target in MARKDOWN_LINK.findall(text):
            target = raw_target.strip().strip("<>").split("#", 1)[0]
            if not target or re.match(r"^(https?://|mailto:)", target):
                continue
            resolved = (markdown.parent / unquote(target)).resolve()
            if not resolved.exists():
                errors.append(f"{markdown}: broken relative link: {raw_target}")
    return errors


def validate_repository(root: Path) -> list[str]:
    errors: list[str] = []
    required = [
        "README.md",
        "AGENTS.md",
        "PLAYBOOK.md",
        "ADOPTION.md",
        "VERSION",
        "CHANGELOG.md",
        "sources/cycle.md",
        "templates/consumer/.fukamu/playbook/lock.json.example",
        "templates/consumer/.fukamu/playbook/overrides.json",
        "templates/consumer/AGENTS.fragment.md",
        "templates/consumer/.github/workflows/playbook.yml",
    ]
    for relative in required:
        if not (root / relative).exists():
            errors.append(f"missing required path: {relative}")

    try:
        version = (root / "VERSION").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        version = ""
    if SEMVER.fullmatch(version) is None:
        errors.append("VERSION must contain an exact semantic version")

    playbook_version, _, playbook_errors = parse_playbook(root / "PLAYBOOK.md")
    errors.extend(playbook_errors)
    if version and playbook_version and version != playbook_version:
        errors.append("VERSION and PLAYBOOK.md Version differ")

    try:
        changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
        if version and f"## {version} " not in changelog:
            errors.append(f"CHANGELOG.md has no entry for {version}")
    except FileNotFoundError:
        pass

    for relative in [
        "templates/consumer/.fukamu/playbook/lock.json.example",
        "templates/consumer/.fukamu/playbook/overrides.json",
    ]:
        load_json(root / relative, errors)

    for workflow in [
        root / ".github/workflows/validate.yml",
        root / "templates/consumer/.github/workflows/playbook.yml",
    ]:
        try:
            workflow_text = workflow.read_text(encoding="utf-8")
            checkout_refs = re.findall(r"actions/checkout@([^\s#]+)", workflow_text)
            if not checkout_refs or any(
                REVISION.fullmatch(ref) is None for ref in checkout_refs
            ):
                errors.append(f"{workflow}: actions/checkout must use a full commit SHA")
        except FileNotFoundError:
            errors.append(f"missing file: {workflow}")

    errors.extend(validate_markdown_links(root))
    return errors


def resolve_consumer_path(root: Path, value: Any, field: str, errors: list[str]) -> Path | None:
    if not isinstance(value, str) or not value or Path(value).is_absolute():
        errors.append(f"lock.{field} must be a non-empty relative path")
        return None
    resolved_root = root.resolve()
    resolved = (resolved_root / value).resolve()
    try:
        resolved.relative_to(resolved_root)
    except ValueError:
        errors.append(f"lock.{field} escapes the consumer root")
        return None
    return resolved


def non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def read_source_blob(
    repository: Path, revision: str, source_path: str, errors: list[str]
) -> bytes | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(repository), "show", f"{revision}:{source_path}"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except OSError as exc:
        errors.append(f"cannot execute git for source verification: {exc}")
        return None
    if result.returncode != 0:
        errors.append(f"source revision does not contain {source_path}: {revision}")
        return None
    return result.stdout


def validate_source_repository(
    repository: Path,
    revision: str,
    bundle_path: Path | None,
    validator_path: Path | None,
) -> list[str]:
    errors: list[str] = []
    repository = repository.resolve()
    try:
        remote = subprocess.run(
            ["git", "-C", str(repository), "remote", "get-url", "origin"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except OSError as exc:
        return [f"cannot execute git for source verification: {exc}"]
    normalized_remote = remote.stdout.strip().removesuffix(".git")
    if remote.returncode != 0 or not (
        normalized_remote.endswith("github.com/fukamu/product-engineering-playbook")
        or normalized_remote.endswith("github.com:fukamu/product-engineering-playbook")
    ):
        errors.append(
            "source repository origin must be fukamu/product-engineering-playbook"
        )

    source_bundle = read_source_blob(repository, revision, "PLAYBOOK.md", errors)
    source_validator = read_source_blob(
        repository, revision, "scripts/validate.py", errors
    )
    if bundle_path is not None and bundle_path.exists() and source_bundle is not None:
        if bundle_path.read_bytes() != source_bundle:
            errors.append("vendored PLAYBOOK.md differs from the pinned source revision")
    if (
        validator_path is not None
        and validator_path.exists()
        and source_validator is not None
        and validator_path.read_bytes() != source_validator
    ):
        errors.append("vendored validate.py differs from the pinned source revision")
    return errors


def validate_consumer(
    root: Path,
    today: dt.date | None = None,
    source_repository: Path | None = None,
) -> list[str]:
    root = root.resolve()
    today = today or dt.date.today()
    errors: list[str] = []

    agents_path = root / "AGENTS.md"
    lock_path = root / ".fukamu/playbook/lock.json"
    overrides_path = root / ".fukamu/playbook/overrides.json"
    lock = load_json(lock_path, errors)
    overrides = load_json(overrides_path, errors)

    if not isinstance(lock, dict):
        return errors
    if lock.get("schemaVersion") != 1:
        errors.append("lock.schemaVersion must be 1")
    if lock.get("source") != "fukamu/product-engineering-playbook":
        errors.append("lock.source must be fukamu/product-engineering-playbook")

    version = lock.get("version")
    if not isinstance(version, str) or SEMVER.fullmatch(version) is None:
        errors.append("lock.version must be an exact semantic version")
    revision = lock.get("revision")
    if not isinstance(revision, str) or REVISION.fullmatch(revision) is None:
        errors.append("lock.revision must be a 40-character lowercase commit SHA")

    if lock.get("bundlePath") != ".fukamu/playbook/PLAYBOOK.md":
        errors.append("lock.bundlePath must be .fukamu/playbook/PLAYBOOK.md")
    if lock.get("validatorPath") != ".fukamu/playbook/validate.py":
        errors.append("lock.validatorPath must be .fukamu/playbook/validate.py")

    bundle_path = resolve_consumer_path(root, lock.get("bundlePath"), "bundlePath", errors)
    validator_path = resolve_consumer_path(
        root, lock.get("validatorPath"), "validatorPath", errors
    )

    bundle_hash = lock.get("bundleSha256")
    validator_hash = lock.get("validatorSha256")
    if not isinstance(bundle_hash, str) or SHA256.fullmatch(bundle_hash) is None:
        errors.append("lock.bundleSha256 must be 64 lowercase hex characters")
    if not isinstance(validator_hash, str) or SHA256.fullmatch(validator_hash) is None:
        errors.append("lock.validatorSha256 must be 64 lowercase hex characters")

    rules: dict[str, Rule] = {}
    if bundle_path is not None and bundle_path.exists():
        actual_hash = file_sha256(bundle_path)
        if bundle_hash != actual_hash:
            errors.append("vendored PLAYBOOK.md does not match lock.bundleSha256")
        bundle_version, rules, parse_errors = parse_playbook(bundle_path)
        errors.extend(parse_errors)
        if isinstance(version, str) and bundle_version and version != bundle_version:
            errors.append("lock.version and vendored PLAYBOOK.md Version differ")
    elif bundle_path is not None:
        errors.append(f"missing vendored playbook: {bundle_path}")

    if validator_path is not None and validator_path.exists():
        actual_hash = file_sha256(validator_path)
        if validator_hash != actual_hash:
            errors.append("vendored validate.py does not match lock.validatorSha256")
    elif validator_path is not None:
        errors.append(f"missing vendored validator: {validator_path}")

    try:
        agents = agents_path.read_text(encoding="utf-8")
        for required_reference in [
            ".fukamu/playbook/PLAYBOOK.md",
            ".fukamu/playbook/lock.json",
            ".fukamu/playbook/overrides.json",
        ]:
            if required_reference not in agents:
                errors.append(f"AGENTS.md must reference {required_reference}")
    except FileNotFoundError:
        errors.append(f"missing file: {agents_path}")

    workflow_path = root / ".github/workflows/playbook.yml"
    try:
        workflow = workflow_path.read_text(encoding="utf-8")
        checkout_refs = re.findall(r"actions/checkout@([^\s#]+)", workflow)
        if not checkout_refs or any(
            REVISION.fullmatch(ref) is None for ref in checkout_refs
        ):
            errors.append("consumer playbook workflow must pin actions/checkout by full SHA")
        for required_text in [
            "pull_request:",
            "push:",
            "permissions:",
            "contents: read",
            "python3 .fukamu/playbook/validate.py --consumer .",
        ]:
            if required_text not in workflow:
                errors.append(
                    f"consumer playbook workflow must contain: {required_text}"
                )
    except FileNotFoundError:
        errors.append(f"missing file: {workflow_path}")

    if not isinstance(overrides, dict):
        return errors
    if overrides.get("schemaVersion") != 1:
        errors.append("overrides.schemaVersion must be 1")
    entries = overrides.get("overrides")
    if not isinstance(entries, list):
        errors.append("overrides.overrides must be an array")
        return errors

    seen: set[tuple[str, tuple[str, ...]]] = set()
    for index, entry in enumerate(entries):
        prefix = f"overrides[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{prefix} must be an object")
            continue
        rule_id = entry.get("ruleId")
        if not isinstance(rule_id, str) or rule_id not in rules:
            errors.append(f"{prefix}.ruleId must identify a vendored playbook rule")
            continue
        if rules[rule_id].override == "never":
            errors.append(f"{prefix} cannot override {rule_id}: override mode is never")

        scope = entry.get("scope")
        if not isinstance(scope, list) or not scope or not all(non_empty_string(v) for v in scope):
            errors.append(f"{prefix}.scope must be a non-empty array of paths")
            scope_key: tuple[str, ...] = ()
        else:
            scope_key = tuple(sorted(scope))
        duplicate_key = (rule_id, scope_key)
        if duplicate_key in seen:
            errors.append(f"{prefix} duplicates an override for {rule_id} and the same scope")
        seen.add(duplicate_key)

        for field in ["rationale", "mitigation", "owner"]:
            if not non_empty_string(entry.get(field)):
                errors.append(f"{prefix}.{field} must be a non-empty string")
        approved_in = entry.get("approvedIn")
        if not isinstance(approved_in, str) or GITHUB_URL.fullmatch(approved_in) is None:
            errors.append(f"{prefix}.approvedIn must be a GitHub Issue or PR URL")
        expires_on = entry.get("expiresOn")
        try:
            expiry = dt.date.fromisoformat(expires_on)
            if expiry < today:
                errors.append(f"{prefix} expired on {expiry.isoformat()}")
        except (TypeError, ValueError):
            errors.append(f"{prefix}.expiresOn must be an ISO date")

    if source_repository is not None and isinstance(revision, str) and REVISION.fullmatch(revision):
        errors.extend(
            validate_source_repository(
                source_repository, revision, bundle_path, validator_path
            )
        )

    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--consumer",
        type=Path,
        help="validate a consumer repository instead of this canonical repository",
    )
    parser.add_argument(
        "--source-repository",
        type=Path,
        help="verify vendored files against the lock revision in a fetched source clone",
    )
    args = parser.parse_args(argv)
    if args.consumer is not None:
        errors = validate_consumer(
            args.consumer, source_repository=args.source_repository
        )
        label = f"consumer {args.consumer}"
    else:
        if args.source_repository is not None:
            parser.error("--source-repository requires --consumer")
        root = Path(__file__).resolve().parents[1]
        errors = validate_repository(root)
        label = "canonical repository"

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"Validated {label}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
