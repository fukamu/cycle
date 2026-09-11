#!/usr/bin/env python3

"""Classify a complete repository change inventory into a closed CI profile."""

from __future__ import annotations

import argparse
import fnmatch
import json
import pathlib
import re
import sys
from dataclasses import dataclass


MAX_CHANGED_PATHS = 100
PROFILES = {"docs", "frontend", "backend", "application", "full"}


@dataclass(frozen=True)
class Change:
    status: str
    old_mode: str
    new_mode: str
    path: str


def canonical_path(path: str) -> bool:
    return (
        bool(path)
        and not path.startswith("/")
        and "\\" not in path
        and "\x00" not in path
        and "\n" not in path
        and "\r" not in path
        and all(part not in {"", ".", ".."} for part in path.split("/"))
    )


def matches(path: str, patterns: tuple[str, ...]) -> bool:
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def is_full_profile_path(path: str) -> bool:
    basename = path.rsplit("/", 1)[-1]
    exact_paths = {
        ".dockerignore",
        ".editorconfig",
        ".env.example",
        ".eslintignore",
        ".gitattributes",
        ".gitignore",
        ".gitleaks.toml",
        ".gitleaksignore",
        ".node-version",
        ".npmrc",
        ".nvmrc",
        ".pnpmfile.cjs",
        ".pnpmfile.js",
        ".prettierignore",
        ".shellcheckrc",
        ".tool-versions",
        "AGENTS.md",
        "Dockerfile",
        "compose.local.yaml",
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "sitecustomize.py",
        "turbo.json",
        "usercustomize.py",
        "yarn.lock",
        "bun.lock",
        "bun.lockb",
        "backend/sqlc.yaml",
        "backend/sqlc.yml",
        "frontend/.env.example",
        "frontend/public/_headers",
    }
    exact_basenames = {
        ".dockerignore",
        ".editorconfig",
        ".env.example",
        ".eslintignore",
        ".gitattributes",
        ".gitignore",
        ".gitleaks.toml",
        ".gitleaksignore",
        ".npmrc",
        ".nvmrc",
        ".pnpmfile.cjs",
        ".pnpmfile.js",
        ".prettierignore",
        ".shellcheckrc",
        ".terraform.lock.hcl",
        ".tool-versions",
        "sitecustomize.py",
        "usercustomize.py",
        "go.mod",
        "go.sum",
        "go.work",
        "go.work.sum",
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "sqlc.yaml",
        "sqlc.yml",
        "yarn.lock",
        "bun.lock",
        "bun.lockb",
    }
    full_basename = re.compile(
        r"^(?:"
        r"Dockerfile(?:\.[^/]+)?|[^/]+\.Dockerfile|"
        r"compose(?:\.[^/]+)?\.ya?ml|docker-compose[^/]*\.ya?ml|"
        r"tsconfig(?:\.[^/]+)?\.json|wrangler\.(?:json|jsonc|toml)|"
        r"(?:babel|eslint|jest|playwright|prettier|rollup|stylelint|vite|vitest|webpack)"
        r"\.config\.[^/]+|vitest\.workspace\.[^/]+|"
        r"\.eslintrc[^/]*|\.prettierrc[^/]*"
        r")$"
    )
    return (
        path in exact_paths
        or path.startswith((".github/", ".fukamu/", "scripts/", "config/", "infra/", "cloudflare/"))
        or path.startswith("backend/cmd/configcheck/")
        or basename in exact_basenames
        or full_basename.fullmatch(basename) is not None
    )


def path_scope(path: str) -> str | None:
    if is_full_profile_path(path):
        return "full"
    if path == "README.md" or matches(path, ("docs/*.md",)):
        return "docs"
    if matches(
        path,
        (
            "frontend/index.html",
            "frontend/src/*.css",
            "frontend/src/*.ts",
            "frontend/src/*.tsx",
            "frontend/e2e/*.mjs",
            "frontend/e2e/*.ts",
            "frontend/vite/*.ts",
        ),
    ):
        return "frontend"
    if matches(
        path,
        (
            "backend/*.go",
            "backend/*.sql",
            "backend/internal/ai/prompts/*.txt",
            "backend/testdata/*.jsonl",
        ),
    ):
        return "backend"
    return None


def classify(changes: list[Change]) -> tuple[str, str]:
    if not changes:
        return "full", "empty_change_inventory"
    if len(changes) > MAX_CHANGED_PATHS:
        return "full", "change_limit_exceeded"

    scopes: set[str] = set()
    seen_paths: set[str] = set()
    allowed_shapes = {
        ("A", "000000", "100644"),
        ("A", "000000", "100755"),
        ("M", "100644", "100644"),
        ("M", "100755", "100755"),
        ("D", "100644", "000000"),
        ("D", "100755", "000000"),
    }
    for change in changes:
        if not canonical_path(change.path) or change.path in seen_paths:
            return "full", "ambiguous_path_inventory"
        seen_paths.add(change.path)
        shape = (change.status, change.old_mode, change.new_mode)
        if shape not in allowed_shapes:
            return "full", "rename_or_type_change"
        scope = path_scope(change.path)
        if scope is None:
            return "full", "unknown_path"
        if scope == "full":
            return "full", "control_or_infrastructure_change"
        scopes.add(scope)

    application_scopes = scopes - {"docs"}
    if not application_scopes:
        return "docs", "docs_only"
    if application_scopes == {"frontend"}:
        return "frontend", "frontend_scope"
    if application_scopes == {"backend"}:
        return "backend", "backend_scope"
    if application_scopes == {"frontend", "backend"}:
        return "application", "application_union"
    return "full", "classification_failed"


def read_manifest(path: pathlib.Path) -> tuple[list[Change] | None, str]:
    try:
        fields = path.read_bytes().split(b"\x00")
        if fields and fields[-1] == b"":
            fields.pop()
        if len(fields) % 4 != 0:
            return None, "classification_failed"
        changes = []
        for index in range(0, len(fields), 4):
            decoded = [field.decode("utf-8", errors="strict") for field in fields[index : index + 4]]
            changes.append(Change(*decoded))
        return changes, ""
    except (OSError, UnicodeError, ValueError):
        return None, "classification_failed"


def read_github_files(path: pathlib.Path, expected_count: int) -> tuple[list[Change] | None, str]:
    try:
        files = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None, "classification_failed"
    if (
        not isinstance(files, list)
        or expected_count < 0
        or expected_count > MAX_CHANGED_PATHS
        or len(files) != expected_count
    ):
        return None, "classification_failed"

    changes: list[Change] = []
    allowed_statuses = {"added", "removed", "modified", "renamed"}
    for item in files:
        if not isinstance(item, dict):
            return None, "classification_failed"
        filename = item.get("filename")
        status = item.get("status")
        if not isinstance(filename, str) or not filename or status not in allowed_statuses:
            return None, "classification_failed"
        if status == "renamed":
            previous = item.get("previous_filename")
            if not isinstance(previous, str) or not previous:
                return None, "classification_failed"
            return [Change("R100", "100644", "100644", filename)], ""
        if "previous_filename" in item:
            return None, "classification_failed"
        shape = {
            "added": ("A", "000000", "100644"),
            "removed": ("D", "100644", "000000"),
            "modified": ("M", "100644", "100644"),
        }[status]
        changes.append(Change(*shape, filename))
    return changes, ""


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--manifest", type=pathlib.Path)
    modes.add_argument("--github-files", type=pathlib.Path)
    parser.add_argument("--expected-count", type=int)
    args = parser.parse_args()

    if args.manifest is not None:
        if args.expected_count is not None:
            profile, reason = "full", "classification_failed"
        else:
            changes, error = read_manifest(args.manifest)
            profile, reason = ("full", error) if changes is None else classify(changes)
    elif args.expected_count is None:
        profile, reason = "full", "classification_failed"
    else:
        changes, error = read_github_files(args.github_files, args.expected_count)
        profile, reason = ("full", error) if changes is None else classify(changes)

    if profile not in PROFILES or not re.fullmatch(r"[a-z_]+", reason):
        profile, reason = "full", "classification_failed"
    print(f"change_profile={profile}")
    print(f"change_reason={reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
