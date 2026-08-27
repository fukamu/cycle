#!/usr/bin/env bash

# Security tooling and the M28 supply-chain policy both run from immutable
# images. Workflow Actions, production bases, and operational tools are checked
# by scripts/check-supply-chain.mjs against the candidate snapshot.
readonly SECURITY_PNPM_IMAGE='ghcr.io/pnpm/pnpm:11.22.0@sha256:eba76954b37ec1ba6187f0adb39caee1e31733194857eedd01319da0af3fa00d'
readonly SECURITY_NODE_IMAGE='node:24.19.0@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584'
readonly SECURITY_GO_IMAGE='golang:1.26.6@sha256:0d1d3a794be25f809dd2cb3160d8c73276c4056a9f8242a138e908ddeee7b6b6'
readonly SECURITY_GITLEAKS_IMAGE='ghcr.io/gitleaks/gitleaks:v8.30.0@sha256:691af3c7c5a48b16f187ce3446d5f194838f91238f27270ed36eef6359a574d9'
readonly SECURITY_TRIVY_IMAGE='ghcr.io/aquasecurity/trivy:0.73.0@sha256:7cced7cae583819fc7806d4cbc0dbbc7cad18b99f7d3e235192e6da8c091045c'
readonly SECURITY_TERRAFORM_IMAGE='hashicorp/terraform:1.15.8@sha256:7ae513256f7ce67879e218ae8593d6fbe216ec9e123abe6c94e4e10704857963'
readonly SECURITY_GOSEC_VERSION='v2.22.11'
readonly SECURITY_GOVULNCHECK_VERSION='v1.7.0'
# backend/server.exe was an accidentally committed local Go build in the
# repository-foundation commit and was removed in 8ba77db. Printable ASCII and
# UTF-16 views of this immutable blob were reviewed with the pinned secret
# scanner. Only this exact historical object, size, and path are grandfathered;
# every candidate file and every other reachable historical blob must be text.
readonly SECURITY_LEGACY_BINARY_BLOB_OID='ac78d653896d639a4b9f93ae26d5009fcc39a4db'
readonly SECURITY_LEGACY_BINARY_BLOB_SIZE='9181184'

# The normalized text view deliberately bypasses Gitleaks MIME/path skips. These
# immutable historical blobs are the only reviewed duplicates it omits: nine
# valid backend/go.sum snapshots and four source snapshots containing the two
# synthetic values already scoped by .gitleaksignore. Normal Git/history scans
# remain active, and any content change creates a new OID that is scanned.
readonly SECURITY_NORMALIZED_TEXT_REVIEWED_BLOB_OIDS='00642c8c91ee37c45ce5cea406b4a102997e56cc:02e64350beb2a70155b8762b997bfe948152834b:23d1b139137ce39bf71ebe874614b86d71257ae6:479191b9e5f3ea733e5f78842e82f6df0eac3dd9:5bd22d43e489ec1c6c569faf3086d9fa559261e0:67c128fd0ebd0fba57ba07b3bce8f73d5bb276ba:bb0622f7e163fcd1516e2687e54e9e1b066904ea:cc5455b909a9f30a703ee6808dac190f86b47d7b:cfaf27abc1661d80a66743d5ec10dd13f4822bda:d1cf70a25ef1e83ba780a74dc5c988b18469eec4:daad0b38b5af009b74f9e83fdc1bd64ae5b55b68:ea5334dbb949fda452cd93e10dc7f36a04c2661c:fdc893ea0889c20926d1f3f3e7a131a20def837e'

# Immutable, intentionally obsolete input used only by the runtime-generated
# container-vulnerability negative test. It is never a production base image.
# shellcheck disable=SC2034 # Sourced and used by scripts/tests/check-security.sh.
readonly SECURITY_VULNERABLE_FIXTURE_IMAGE='alpine@sha256:ca1c944a4f8486a153024d9965aafbe24f5723c1d5c02f4964c045a16d19dc54'

security_validate_gitleaks_ignore() {
  local ignore_path="$1"
  local exact_fingerprint_pattern='^[0-9a-f]{40}:[^:]+:[A-Za-z0-9][A-Za-z0-9._-]*:[1-9][0-9]*$'
  local line

  [[ -f "${ignore_path}" ]] || return 1
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" =~ ^[[:space:]]*$ ]] && continue
    [[ "${line}" =~ ^[[:space:]]*# ]] && continue
    [[ "${line}" =~ ${exact_fingerprint_pattern} ]] || return 1
    if [[ "${line}" == *'*'* || "${line}" == *'?'* || "${line}" == *'['* || "${line}" == *']'* || "${line}" == *'{'* || "${line}" == *'}'* ]]; then
      return 1
    fi
  done <"${ignore_path}"
}

security_validate_git_repository_inputs() {
  local source_root="$1"
  # GIT_NO_REPLACE_OBJECTS disables replace refs, but legacy graft files remain
  # active. Reject both, plus alternate object stores, so every history reader
  # sees the self-contained object graph mounted read-only at /source.
  # shellcheck disable=SC2016 # The single-quoted program expands only inside the pinned container.
  local -a command=(
    docker run --rm
    --network none
    --read-only
    --tmpfs "/tmp:rw,nosuid,nodev,noexec"
    --user "$(id -u):$(id -g)"
    --env GIT_CONFIG_GLOBAL=/dev/null
    --env GIT_CONFIG_NOSYSTEM=1
    --env GIT_CONFIG_COUNT=1
    --env GIT_CONFIG_KEY_0=safe.directory
    --env GIT_CONFIG_VALUE_0=/source
    --env GIT_NO_LAZY_FETCH=1
    --env GIT_NO_REPLACE_OBJECTS=1
    --volume "${source_root}:/source:ro"
    --workdir /source
    --entrypoint sh
    "${SECURITY_GITLEAKS_IMAGE}"
    -ceu
    '
      export LC_ALL=C
      include_config_status=0
      git config --no-includes --local --name-only --get-regexp \
        "^(include\.path|includeif\..*\.path|extensions\.worktreeconfig)$" \
        > /tmp/include-config || include_config_status=$?
      case "${include_config_status}" in
        0) exit 1 ;;
        1) ;;
        *) exit 1 ;;
      esac
      test "$(git rev-parse --is-inside-work-tree)" = true
      test "$(git rev-parse --is-shallow-repository)" = false
      for execution_config in core.fsmonitor core.untrackedCache core.hooksPath; do
        config_status=0
        git config --no-includes --local --get-all "${execution_config}" > /tmp/execution-config || config_status=$?
        case "${config_status}" in
          0) exit 1 ;;
          1) ;;
          *) exit 1 ;;
        esac
      done
      pager_config_status=0
      git config --no-includes --local --get-regexp "^(core\.pager|pager\.)" > /tmp/pager-config || pager_config_status=$?
      case "${pager_config_status}" in
        0) exit 1 ;;
        1) ;;
        *) exit 1 ;;
      esac
      diff_config_status=0
      git config --no-includes --local --name-only --get-regexp "^diff[.]" > /tmp/diff-config || diff_config_status=$?
      case "${diff_config_status}" in
        0) exit 1 ;;
        1) ;;
        *) exit 1 ;;
      esac
      promisor_config_status=0
      git config --no-includes --local --name-only --get-regexp \
        "^(extensions\.partialclone|remote\..*\.(promisor|partialclonefilter))$" \
        > /tmp/promisor-config || promisor_config_status=$?
      case "${promisor_config_status}" in
        0) exit 1 ;;
        1) ;;
        *) exit 1 ;;
      esac
      for repository_override in \
        info/grafts \
        objects/info/alternates \
        objects/info/http-alternates; do
        override_path="$(git rev-parse --git-path "${repository_override}")"
        test ! -e "${override_path}"
        test ! -L "${override_path}"
      done
      git for-each-ref --format="%(refname)" refs/replace/ > /tmp/replace-refs
      test ! -s /tmp/replace-refs
      git fsck --connectivity-only --no-dangling
    '
  )
  "${command[@]}" >/dev/null 2>/dev/null
}

security_write_candidate_manifest() {
  local source_root="$1"
  local manifest_path="$2"

  # Do not feed git directly into a process substitution: Bash does not
  # propagate that producer's status to the consuming while loop. Materialize
  # the NUL-delimited list so an enumeration error always fails the gate.
  [[ ! -e "${manifest_path}" && ! -L "${manifest_path}" ]] || return 1
  trusted_git -C "${source_root}" ls-files --cached --others --exclude-standard -z >"${manifest_path}"
}

security_create_candidate_snapshot() {
  local source_root="$1"
  local snapshot_root="$2"
  local manifest_path="$3"
  local deleted_manifest_path="${manifest_path}.initially-deleted"
  local tracked_ignored_manifest_path="${manifest_path}.tracked-ignored"
  local relative_path
  local deleted_path
  local source_path
  local target_path
  local was_initially_deleted

  # A force-tracked ignored path can reintroduce credentials, local state,
  # dependency stores, or provider executables that the candidate policy is
  # designed to exclude. There are no approved tracked+ignored exceptions.
  [[ ! -e "${tracked_ignored_manifest_path}" && ! -L "${tracked_ignored_manifest_path}" ]] || return 1
  trusted_git -C "${source_root}" ls-files --cached --ignored --exclude-standard -z \
    >"${tracked_ignored_manifest_path}" || return 1
  [[ ! -s "${tracked_ignored_manifest_path}" ]] || return 1

  # Capture intentional tracked deletions before enumerating copy candidates.
  # A tracked path that disappears after this point is a concurrent mutation,
  # not an intentional deletion, and must fail the snapshot closed.
  [[ ! -e "${deleted_manifest_path}" && ! -L "${deleted_manifest_path}" ]] || return 1
  trusted_git -C "${source_root}" ls-files --deleted -z >"${deleted_manifest_path}" || return 1
  security_write_candidate_manifest "${source_root}" "${manifest_path}" || return 1
  while IFS= read -r -d '' relative_path; do
    source_path="${source_root}/${relative_path}"
    target_path="${snapshot_root}/${relative_path}"
    if [[ ! -e "${source_path}" && ! -L "${source_path}" ]]; then
      was_initially_deleted=false
      while IFS= read -r -d '' deleted_path; do
        if [[ "${deleted_path}" == "${relative_path}" ]]; then
          was_initially_deleted=true
          break
        fi
      done <"${deleted_manifest_path}"
      [[ "${was_initially_deleted}" == "true" ]] && continue
      return 1
    fi
    mkdir -p -- "$(dirname -- "${target_path}")" || return 1
    if [[ -L "${source_path}" ]]; then
      # The same snapshot is the production build context. Replacing a symlink
      # with link text changes image semantics, while preserving it could reach
      # an ignored or external target. M25 therefore rejects all symlinks.
      return 1
    elif [[ -f "${source_path}" ]]; then
      [[ ! -e "${target_path}" && ! -L "${target_path}" ]] || return 1
      cp --no-dereference -- "${source_path}" "${target_path}" || return 1
      # A path can be replaced or its bytes can change between the lstat-style
      # checks and cp. Only accept a regular, non-link copy that still matches
      # a regular, non-link source after the copy completes.
      [[ -f "${source_path}" && ! -L "${source_path}" &&
        -f "${target_path}" && ! -L "${target_path}" ]] || return 1
      cmp --silent -- "${source_path}" "${target_path}" || return 1
    else
      return 1
    fi
  done <"${manifest_path}"
}

security_validate_text_inventory() {
  local source_root="$1"
  local inventory_mode="$2"

  [[ "${inventory_mode}" == "candidate" || "${inventory_mode}" == "staged" || "${inventory_mode}" == "history" ]] || return 1
  # shellcheck disable=SC2016 # The single-quoted program expands only inside the pinned container.
  local -a command=(
    docker run --rm
    --network none
    --read-only
    --tmpfs "/tmp:rw,nosuid,nodev,noexec"
    --user "$(id -u):$(id -g)"
    --env GIT_CONFIG_GLOBAL=/dev/null
    --env GIT_CONFIG_NOSYSTEM=1
    --env GIT_CONFIG_COUNT=1
    --env GIT_CONFIG_KEY_0=safe.directory
    --env GIT_CONFIG_VALUE_0=/source
    --env GIT_NO_LAZY_FETCH=1
    --env GIT_NO_REPLACE_OBJECTS=1
    --env "INVENTORY_MODE=${inventory_mode}"
    --env "LEGACY_BINARY_BLOB_OID=${SECURITY_LEGACY_BINARY_BLOB_OID}"
    --env "LEGACY_BINARY_BLOB_SIZE=${SECURITY_LEGACY_BINARY_BLOB_SIZE}"
    --volume "${source_root}:/source:ro"
    --workdir /source
    "${SECURITY_NODE_IMAGE}"
    node -e
    '
      try {
        const fs = require("node:fs");
        const path = require("node:path");
        const { execFileSync } = require("node:child_process");
        const { TextDecoder } = require("node:util");
        const root = "/source";
        const mode = process.env.INVENTORY_MODE;
        const legacyOid = process.env.LEGACY_BINARY_BLOB_OID;
        const legacySize = Number(process.env.LEGACY_BINARY_BLOB_SIZE);
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const maximumFileSize = 16 * 1024 * 1024;
        const maximumTreeOutput = 64 * 1024 * 1024;
        const maximumBatchOutput = 256 * 1024 * 1024;
        const maximumEntries = 1000000;
        const exactBasenames = new Set([
          ".dockerignore",
          ".editorconfig",
          ".gitattributes",
          ".gitignore",
          ".gitleaksignore",
          ".prettierignore",
          "Dockerfile",
          "_headers",
        ]);
        const approvedSuffixes = [
          ".css",
          ".example",
          ".fixture",
          ".go",
          ".hcl",
          ".html",
          ".js",
          ".json",
          ".jsonc",
          ".jsonl",
          ".local",
          ".md",
          ".mjs",
          ".mod",
          ".ps1",
          ".sh",
          ".sql",
          ".sum",
          ".tf",
          ".ts",
          ".tsbuildinfo",
          ".tsx",
          ".txt",
          ".yaml",
          ".yml",
        ];

        const validatePath = (relativePath) => {
          if (
            relativePath.length < 1 || relativePath.length > 4096 ||
            !/^[A-Za-z0-9._@+\/-]+$/.test(relativePath)
          ) {
            throw new Error("unapproved path characters");
          }
          const segments = relativePath.split("/");
          if (segments.some((segment) => segment.length < 1 || segment === "." || segment === "..")) {
            throw new Error("unapproved path segment");
          }
          const basename = segments.at(-1);
          if (
            !exactBasenames.has(basename) && !basename.endsWith(".Dockerfile") &&
            !approvedSuffixes.some((suffix) => basename.endsWith(suffix))
          ) {
            throw new Error("unapproved text file type");
          }
        };

        const validateText = (content) => {
          if (content.length > maximumFileSize) throw new Error("text file size bound");
          for (const byte of content) {
            if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
              throw new Error("binary control byte");
            }
          }
          const decoded = decoder.decode(content);
          for (const character of decoded) {
            const codePoint = character.codePointAt(0);
            if ((codePoint >= 0x80 && codePoint <= 0x9f) || codePoint === 0xfeff) {
              throw new Error("non-text Unicode control");
            }
          }
        };

        const parseHexLines = (content, label) => {
          const value = decoder.decode(content);
          const lines = value.split("\n");
          if (lines.at(-1) !== "") throw new Error(label + " missing terminator");
          lines.pop();
          if (
            lines.length < 1 || lines.length > maximumEntries ||
            lines.some((line) => !/^[0-9a-f]{40}$/.test(line))
          ) {
            throw new Error("invalid " + label);
          }
          return [...new Set(lines)];
        };

        const execGit = (args, input, maxBuffer = maximumTreeOutput) => {
          const options = {
            cwd: root,
            encoding: null,
            maxBuffer,
            stdio: ["pipe", "pipe", "ignore"],
          };
          if (input !== undefined) options.input = input;
          return execFileSync("git", args, options);
        };

        if (mode === "candidate") {
          const pending = [root];
          let entryCount = 0;
          let fileCount = 0;
          while (pending.length > 0) {
            const current = pending.pop();
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink()) throw new Error("candidate symlink");
            if (stat.isDirectory()) {
              const children = fs.readdirSync(current).sort().reverse();
              for (const child of children) pending.push(path.join(current, child));
            } else {
              if (!stat.isFile()) throw new Error("candidate special file");
              const relativePath = path.relative(root, current);
              validatePath(relativePath);
              if (stat.size > maximumFileSize) throw new Error("candidate file size bound");
              const content = fs.readFileSync(current);
              const postRead = fs.lstatSync(current);
              if (
                postRead.isSymbolicLink() || !postRead.isFile() ||
                postRead.size !== stat.size || content.length !== stat.size
              ) {
                throw new Error("candidate changed during validation");
              }
              validateText(content);
              fileCount += 1;
            }
            entryCount += 1;
            if (entryCount > maximumEntries) throw new Error("candidate entry count bound");
          }
          if (fileCount < 1) throw new Error("empty candidate tree");
        } else if (mode === "staged") {
          const index = execGit(["ls-files", "--stage", "-z"]);
          const stagedBlobOids = new Set();
          let offset = 0;
          let entryCount = 0;
          while (offset < index.length) {
            const terminator = index.indexOf(0, offset);
            if (terminator < 0) throw new Error("unterminated index record");
            const record = index.subarray(offset, terminator);
            const separator = record.indexOf(0x09);
            if (separator < 0) throw new Error("invalid index record");
            const header = record.subarray(0, separator).toString("ascii");
            const match = /^(100644|100755) ([0-9a-f]{40}) 0$/.exec(header);
            if (match === null) throw new Error("unapproved staged entry mode");
            const relativePath = decoder.decode(record.subarray(separator + 1));
            validatePath(relativePath);
            stagedBlobOids.add(match[2]);
            entryCount += 1;
            if (entryCount > maximumEntries) throw new Error("staged entry count bound");
            offset = terminator + 1;
          }
          if (stagedBlobOids.size < 1) throw new Error("empty staged blob inventory");
          for (const oid of stagedBlobOids) {
            const content = execGit(["cat-file", "blob", oid], undefined, maximumFileSize + 1);
            validateText(content);
          }
        } else if (mode === "history") {
          if (!/^[0-9a-f]{40}$/.test(legacyOid) || !Number.isSafeInteger(legacySize) || legacySize < 1) {
            throw new Error("invalid legacy binary identity");
          }
          const commits = parseHexLines(execGit(["rev-list", "--all"]), "commit inventory");
          const treeBlobOids = new Set();
          let treeEntryCount = 0;
          let legacyPathSeen = false;

          for (const commit of commits) {
            const tree = execGit(["ls-tree", "-r", "-z", "--full-tree", commit]);
            let offset = 0;
            while (offset < tree.length) {
              const terminator = tree.indexOf(0, offset);
              if (terminator < 0) throw new Error("unterminated tree record");
              const record = tree.subarray(offset, terminator);
              const separator = record.indexOf(0x09);
              if (separator < 0) throw new Error("invalid tree record");
              const header = record.subarray(0, separator).toString("ascii");
              const match = /^(100644|100755) blob ([0-9a-f]{40})$/.exec(header);
              if (match === null) throw new Error("unapproved historical entry mode");
              const relativePath = decoder.decode(record.subarray(separator + 1));
              const oid = match[2];
              if (oid === legacyOid) {
                if (relativePath !== "backend/server.exe") {
                  throw new Error("legacy binary used at an unapproved path");
                }
                legacyPathSeen = true;
              } else {
                validatePath(relativePath);
              }
              treeBlobOids.add(oid);
              treeEntryCount += 1;
              if (treeEntryCount > maximumEntries) throw new Error("history tree entry count bound");
              offset = terminator + 1;
            }
          }
          if (treeBlobOids.size < 1) throw new Error("empty history tree inventory");

          const reachableOids = parseHexLines(
            execGit(["rev-list", "--objects", "--all", "--no-object-names"]),
            "reachable object inventory",
          );
          const batchInput = Buffer.from(reachableOids.join("\n") + "\n", "ascii");
          const inventory = decoder.decode(
            execGit(
              ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
              batchInput,
              maximumBatchOutput,
            ),
          );
          const inventoryLines = inventory.split("\n");
          if (inventoryLines.at(-1) !== "") throw new Error("unterminated object inventory");
          inventoryLines.pop();
          if (inventoryLines.length !== reachableOids.length) throw new Error("incomplete object inventory");
          const reachableBlobOids = [];
          const reachableMetadataObjects = new Map();
          for (let index = 0; index < inventoryLines.length; index += 1) {
            const match = /^([0-9a-f]{40}) (blob|commit|tree|tag) ([0-9]+)$/.exec(inventoryLines[index]);
            if (match === null || match[1] !== reachableOids[index]) {
              throw new Error("invalid object inventory");
            }
            const size = Number(match[3]);
            if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid object size");
            if (match[2] === "blob") {
              if (!treeBlobOids.has(match[1])) throw new Error("reachable pathless blob");
              reachableBlobOids.push(match[1]);
            } else if (match[2] === "commit" || match[2] === "tag") {
              reachableMetadataObjects.set(match[1], match[2]);
            }
          }
          if (reachableBlobOids.length !== treeBlobOids.size) {
            throw new Error("history blob inventory mismatch");
          }

          const blobBatch = execGit(
            ["cat-file", "--batch"],
            Buffer.from(reachableBlobOids.join("\n") + "\n", "ascii"),
            maximumBatchOutput,
          );
          let blobOffset = 0;
          for (const expectedOid of reachableBlobOids) {
            const headerEnd = blobBatch.indexOf(0x0a, blobOffset);
            if (headerEnd < 0) throw new Error("unterminated blob header");
            const header = blobBatch.subarray(blobOffset, headerEnd).toString("ascii");
            const match = /^([0-9a-f]{40}) blob ([0-9]+)$/.exec(header);
            if (match === null || match[1] !== expectedOid) throw new Error("invalid blob header");
            const size = Number(match[2]);
            if (!Number.isSafeInteger(size) || size < 0 || size > maximumFileSize) {
              throw new Error("historical blob size bound");
            }
            const contentStart = headerEnd + 1;
            const contentEnd = contentStart + size;
            if (contentEnd >= blobBatch.length || blobBatch[contentEnd] !== 0x0a) {
              throw new Error("truncated blob content");
            }
            const content = blobBatch.subarray(contentStart, contentEnd);
            if (expectedOid === legacyOid) {
              if (!legacyPathSeen || size !== legacySize) throw new Error("legacy binary mismatch");
            } else {
              validateText(content);
            }
            blobOffset = contentEnd + 1;
          }
          if (blobOffset !== blobBatch.length) throw new Error("unexpected blob batch suffix");

          const metadataOids = [...reachableMetadataObjects.keys()];
          if (metadataOids.length < 1) throw new Error("empty commit/tag metadata inventory");
          const metadataBatch = execGit(
            ["cat-file", "--batch"],
            Buffer.from(metadataOids.join("\n") + "\n", "ascii"),
            maximumBatchOutput,
          );
          let metadataOffset = 0;
          for (const expectedOid of metadataOids) {
            const headerEnd = metadataBatch.indexOf(0x0a, metadataOffset);
            if (headerEnd < 0) throw new Error("unterminated metadata header");
            const header = metadataBatch.subarray(metadataOffset, headerEnd).toString("ascii");
            const match = /^([0-9a-f]{40}) (commit|tag) ([0-9]+)$/.exec(header);
            if (
              match === null || match[1] !== expectedOid ||
              match[2] !== reachableMetadataObjects.get(expectedOid)
            ) {
              throw new Error("invalid commit/tag metadata header");
            }
            const size = Number(match[3]);
            if (!Number.isSafeInteger(size) || size < 0 || size > maximumFileSize) {
              throw new Error("commit/tag metadata size bound");
            }
            const contentStart = headerEnd + 1;
            const contentEnd = contentStart + size;
            if (contentEnd >= metadataBatch.length || metadataBatch[contentEnd] !== 0x0a) {
              throw new Error("truncated commit/tag metadata");
            }
            validateText(metadataBatch.subarray(contentStart, contentEnd));
            metadataOffset = contentEnd + 1;
          }
          if (metadataOffset !== metadataBatch.length) {
            throw new Error("unexpected commit/tag metadata batch suffix");
          }
          const refNames = execGit(["for-each-ref", "--format=%(refname)"]);
          if (refNames.length < 1 || refNames.length > maximumFileSize) {
            throw new Error("invalid ref-name inventory size");
          }
          validateText(refNames);
          const decodedRefNames = decoder.decode(refNames);
          if (
            !decodedRefNames.endsWith("\n") ||
            decodedRefNames.split("\n").slice(0, -1).some((refName) => !/^refs\/[A-Za-z0-9._@+\/-]+$/.test(refName))
          ) {
            throw new Error("invalid ref-name inventory");
          }
        } else {
          throw new Error("unknown text inventory mode");
        }
      } catch {
        process.exit(2);
      }
    '
  )
  "${command[@]}" >/dev/null 2>/dev/null
}

security_validate_candidate_text_files() {
  security_validate_text_inventory "$1" candidate
}

security_validate_staged_text_files() {
  security_validate_text_inventory "$1" staged
}

security_validate_history_text_files() {
  security_validate_text_inventory "$1" history
}

security_prepare_go_cache() {
  local cache_root="$1"
  mkdir -p -- "${cache_root}/bin"
  mkdir -p -- "${cache_root}/build"
  mkdir -p -- "${cache_root}/gopath"
  mkdir -p -- "${cache_root}/home"
  mkdir -p -- "${cache_root}/mod"
}

security_remove_temporary_image() {
  local image_tag="$1"
  docker image rm "${image_tag}" >/dev/null 2>&1
}

security_require_temporary_image_tag_absent() {
  local image_tag="$1"
  local image_ids

  # A successful exact-reference query with no IDs is the only accepted proof
  # of absence. Daemon/permission/transient errors therefore cannot be confused
  # with a not-found result before a temporary tag is created.
  if ! image_ids="$(docker image ls --quiet --no-trunc --filter "reference=${image_tag}" 2>/dev/null)"; then
    return 1
  fi
  [[ -z "${image_ids}" ]]
}

security_write_gitleaks_config() {
  local config_path="$1"
  printf '%s\n' '[extend]' 'useDefault = true' >"${config_path}"
}

security_validate_gitleaks_log() {
  local log_path="$1"
  local line

  [[ -f "${log_path}" ]] || return 1
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ "${line}" == *'WRN skipping archive: exceeds max archive depth'* ||
      "${line}" == *'WRN skipping file: too large'* ||
      "${line}" == *' ERR '* ]]; then
      return 1
    fi
  done <"${log_path}"
}

security_validate_normalized_gitleaks_log() {
  local log_path="$1"
  local line
  local scanned_count=0

  security_validate_gitleaks_log "${log_path}" || return 1
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ "${line}" == *'skipping file'* || "${line}" == *'skipping binary file'* ||
      "${line}" == *' FTL '* ]]; then
      return 1
    fi
    [[ "${line}" == *' INF scanned '* ]] && scanned_count=$((scanned_count + 1))
  done <"${log_path}"
  [[ "${scanned_count}" -eq 1 ]]
}

security_write_trivy_config() {
  local config_path="$1"
  printf '%s\n' '{}' >"${config_path}"
}

security_run_node_audit() {
  local source_root="$1"
  local report_path="$2"
  local log_path="$3"
  local -a command=(
    docker run --rm
    --env COREPACK_ENABLE_PROJECT_SPEC=0
    --env npm_config_manage_package_manager_versions=false
    --volume "${source_root}:/workspace:ro"
    --workdir /workspace
    "${SECURITY_PNPM_IMAGE}"
    pnpm --config.manage-package-manager-versions=false --registry=https://registry.npmjs.org/ --ignore-pnpmfile audit --audit-level high --json
  )
  "${command[@]}" >"${report_path}" 2>"${log_path}"
}

security_validate_node_audit_policy() {
  local source_root="$1"
  local output_root="$2"
  local log_path="$3"
  local config_report="${output_root}/pnpm-security-config.json"
  local policy_file_manifest="${output_root}/pnpm-policy-files.nul"

  # pnpm 11 does not expose every .npmrc transport option or hook file through
  # `config list`, although `audit` can still honor them. The repository needs
  # neither input, so reject every candidate instance by name without reading
  # its contents before any registry request can occur.
  if ! find "${source_root}" \( -name .npmrc -o -name .pnpmfile.cjs -o -name .pnpmfile.js \) -print0 >"${policy_file_manifest}"; then
    return 1
  fi
  [[ ! -s "${policy_file_manifest}" ]] || return 1

  local -a validate_command=(
    docker run --rm
    --network none
    --read-only
    --tmpfs "/tmp:rw,nosuid,nodev,noexec"
    --volume "${source_root}:/workspace:ro"
    --volume "${output_root}:/policy:ro"
    "${SECURITY_NODE_IMAGE}"
    node -e
    '
      try {
        const fs = require("node:fs");
        const path = require("node:path");
        const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
        const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
        const exactObject = (value, expected) =>
          object(value) &&
          JSON.stringify(Object.keys(value).sort()) === JSON.stringify(Object.keys(expected).sort()) &&
          Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
        const parse = (path, optional) => {
          const raw = fs.readFileSync(path, "utf8").trim();
          if (optional && raw.length === 0) return null;
          const value = JSON.parse(raw);
          if (!object(value)) throw new Error("invalid policy object");
          return value;
        };
        const manifest = parse("/workspace/package.json", false);
        const config = parse(process.argv[1], false);
        if (manifest.packageManager !== "pnpm@11.22.0") process.exit(1);
        const expectedWorkspacePolicy = [
          "packages:",
          "  - frontend",
          "  - cloudflare",
          "",
          "allowBuilds:",
          "  esbuild: true",
          "  workerd: true",
          "",
        ].join("\n");
        if (fs.readFileSync("/workspace/pnpm-workspace.yaml", "utf8") !== expectedWorkspacePolicy) {
          process.exit(1);
        }

        const lockfilePath = "/workspace/pnpm-lock.yaml";
        const lockfileStat = fs.lstatSync(lockfilePath);
        if (
          !lockfileStat.isFile() || lockfileStat.isSymbolicLink() ||
          lockfileStat.size < 1 || lockfileStat.size > 8 * 1024 * 1024
        ) {
          process.exit(1);
        }
        const lockfile = fs.readFileSync(lockfilePath, "utf8");
        const expectedLockfilePrefix = [
          "lockfileVersion: \x279.0\x27",
          "",
          "settings:",
          "  autoInstallPeers: true",
          "  excludeLinksFromLockfile: false",
          "",
          "importers:",
          "",
        ].join("\n");
        if (!lockfile.startsWith(expectedLockfilePrefix)) process.exit(1);
        const topLevelLines = lockfile
          .split("\n")
          .filter((line) => line.length > 0 && !/^\s/.test(line));
        if (
          JSON.stringify(topLevelLines) !==
          JSON.stringify([
            "lockfileVersion: \x279.0\x27",
            "settings:",
            "importers:",
            "packages:",
            "snapshots:",
          ])
        ) {
          process.exit(1);
        }
        if (/[\r\t\\&!]/.test(lockfile) || /(^|\s)<<:/.test(lockfile)) process.exit(1);
        if (/@jsr\//i.test(lockfile)) process.exit(1);
        const sourcePolicyText = lockfile
          .split("\n")
          .map((line) => {
            if (/^    engines: \{.*\}$/.test(line)) {
              return line.replace(/\bnpm:/g, "registry-engine:");
            }
            if (/^    deprecated: /.test(line)) {
              return line.replace(/https?:\/\/\S+/g, "registry-documentation");
            }
            return line;
          })
          .join("\n");
        if (
          /(?:^|[^A-Za-z0-9_-])(?:link|file|portal|workspace|patch|npm|jsr|https?|git(?:\+https?|\+ssh)?|ssh|tarball|directory):/i.test(
            sourcePolicyText,
          )
        ) {
          process.exit(1);
        }
        const packagesMarker = "\npackages:\n";
        const snapshotsMarker = "\nsnapshots:\n";
        const packagesOffset = lockfile.indexOf(packagesMarker);
        const snapshotsOffset = lockfile.indexOf(snapshotsMarker);
        if (
          packagesOffset < 0 ||
          snapshotsOffset <= packagesOffset ||
          lockfile.indexOf(packagesMarker, packagesOffset + 1) !== -1 ||
          lockfile.indexOf(snapshotsMarker, snapshotsOffset + 1) !== -1
        ) {
          process.exit(1);
        }
        const importerBlock = lockfile.slice(expectedLockfilePrefix.length, packagesOffset);
        if (/(?:specifier|version):\s*["\x27]?(?:file|link|portal|workspace|git\+|https?|npm|patch):/i.test(importerBlock)) {
          process.exit(1);
        }
        const packagesBlock = lockfile.slice(packagesOffset + packagesMarker.length, snapshotsOffset);
        const packageEntries = packagesBlock.match(/^  \S[^\n]*:$/gm) ?? [];
        if (
          packageEntries.some((entry) =>
            /(?:file|link|portal|workspace|git\+|https?|npm|patch):/i.test(entry),
          )
        ) {
          process.exit(1);
        }
        const resolutionLines = packagesBlock.match(
          /^    resolution: \{integrity: sha512-[A-Za-z0-9+/]+={0,2}\}$/gm,
        ) ?? [];
        const allResolutionLines = packagesBlock.match(/^    resolution:/gm) ?? [];
        if (
          packageEntries.length !== resolutionLines.length ||
          resolutionLines.length !== allResolutionLines.length
        ) {
          process.exit(1);
        }

        if (config.registry !== "https://registry.npmjs.org/") process.exit(1);
        if (config.managePackageManagerVersions !== false) process.exit(1);
        if (
          !Array.isArray(config.packages) ||
          JSON.stringify(config.packages) !== JSON.stringify(["frontend", "cloudflare"])
        ) {
          process.exit(1);
        }
        if (
          !object(config.allowBuilds) ||
          JSON.stringify(Object.keys(config.allowBuilds).sort()) !==
            JSON.stringify(["esbuild", "workerd"]) ||
          config.allowBuilds.esbuild !== true ||
          config.allowBuilds.workerd !== true
        ) {
          process.exit(1);
        }

        const lifecycleScripts = new Set([
          "preinstall",
          "install",
          "postinstall",
          "preprepare",
          "prepare",
          "postprepare",
          "prepublish",
          "prepublishOnly",
          "pnpm:devPreinstall",
        ]);
        const packageManifests = [];
        const expectedWorkspacePackages = new Map([
          [
            "/workspace/frontend/package.json",
            {
              name: "fukamu-cycle-frontend",
              scripts: {
                dev: "vite",
                build: "tsc -b && vite build",
                format: "prettier --write .",
                "format:check": "prettier --check .",
                lint: "eslint . --max-warnings 0",
                test: "vitest run",
                "test:watch": "vitest",
                "test:e2e": "playwright test",
                typecheck: "tsc -b --pretty false",
              },
            },
          ],
          [
            "/workspace/cloudflare/package.json",
            {
              name: "fukamu-cycle-cloudflare",
              scripts: {
                format: "prettier --write .",
                "format:check": "prettier --check .",
                types: "wrangler types",
                typecheck: "tsc --noEmit --pretty false",
                test: "node --test src/beta-admission/beta-admission.test.mjs src/config/trace-forwarding-contract.test.mjs src/config/validate-deploy-inputs.test.mjs",
                check: "prettier --check . && wrangler types && tsc --noEmit --pretty false && node --test src/beta-admission/beta-admission.test.mjs src/config/trace-forwarding-contract.test.mjs src/config/validate-deploy-inputs.test.mjs",
                "deploy:dry-run": "wrangler deploy --dry-run --outdir .wrangler/dry-run",
              },
            },
          ],
        ]);
        const collectPackageManifests = (directory) => {
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const candidate = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) throw new Error("candidate symlink");
            if (entry.isDirectory()) {
              collectPackageManifests(candidate);
            } else if (entry.isFile() && entry.name === "package.json") {
              packageManifests.push(candidate);
            }
          }
        };
        collectPackageManifests("/workspace");
        const dependencyFields = [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
        ];
        const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
        for (const packageManifestPath of packageManifests) {
          const packageManifest = parse(packageManifestPath, false);
          const expectedWorkspacePackage = expectedWorkspacePackages.get(packageManifestPath);
          if (expectedWorkspacePackage !== undefined) {
            if (
              packageManifest.name !== expectedWorkspacePackage.name ||
              !exactObject(packageManifest.scripts, expectedWorkspacePackage.scripts)
            ) {
              process.exit(1);
            }
            expectedWorkspacePackages.delete(packageManifestPath);
          }
          if (
            packageManifestPath !== "/workspace/package.json" &&
            own(packageManifest, "packageManager")
          ) {
            process.exit(1);
          }
          if (
            own(packageManifest, "pnpm") || own(packageManifest, "devEngines") ||
            own(packageManifest, "peerDependencies") || own(packageManifest, "peerDependenciesMeta") ||
            own(packageManifest, "dependenciesMeta")
          ) {
            process.exit(1);
          }
          for (const dependencyField of dependencyFields) {
            if (!own(packageManifest, dependencyField)) continue;
            const dependencies = packageManifest[dependencyField];
            if (!object(dependencies)) throw new Error("invalid dependency map");
            for (const specifier of Object.values(dependencies)) {
              if (typeof specifier !== "string" || !exactVersion.test(specifier)) process.exit(1);
            }
          }
          if (!own(packageManifest, "scripts")) continue;
          if (!object(packageManifest.scripts)) throw new Error("invalid package scripts");
          for (const lifecycleScript of lifecycleScripts) {
            if (own(packageManifest.scripts, lifecycleScript)) process.exit(1);
          }
        }
        if (expectedWorkspacePackages.size !== 0) process.exit(1);

        const configured = [];
        if (own(config, "auditConfig")) {
          if (!object(config.auditConfig)) throw new Error("invalid workspace auditConfig");
          configured.push(config.auditConfig);
        }
        if (own(manifest, "auditConfig")) {
          if (!object(manifest.auditConfig)) throw new Error("invalid auditConfig");
          configured.push(manifest.auditConfig);
        }
        if (own(manifest, "pnpm")) process.exit(1);
        for (const auditConfig of configured) {
          if (auditConfig && (own(auditConfig, "ignoreCves") || own(auditConfig, "ignoreGhsas"))) {
            process.exit(1);
          }
        }
        const audit = own(config, "audit") ? config.audit : null;
        if (audit !== null && !object(audit)) throw new Error("invalid audit policy");
        if (audit && own(audit, "ignore")) process.exit(1);
        for (const key of ["ignoreUnfixable", "ignoreRegistryErrors", "prod", "production", "dev"]) {
          if (own(config, key) && config[key] !== false) process.exit(1);
        }
        if (own(config, "only")) process.exit(1);
        if (own(config, "optional") && config.optional !== true) process.exit(1);
        for (const key of ["proxy", "httpsProxy", "ca", "cafile", "cert", "key"]) {
          if (own(config, key)) process.exit(1);
        }
        for (const key of ["pnpmfile", "globalPnpmfile", "ignorePnpmfile", "hooks", "readPackage"]) {
          if (own(config, key)) process.exit(1);
        }
        if (own(config, "strictSsl") && config.strictSsl !== true) process.exit(1);
        const authKeys = new Set(["_auth", "_authtoken", "token", "username", "_password", "alwaysauth"]);
        for (const key of Object.keys(config)) {
          const lower = key.toLowerCase();
          if (lower.startsWith("//") || authKeys.has(lower)) {
            process.exit(1);
          }
          if (/^@[^:]+:registry$/.test(lower)) {
            if (lower !== "@jsr:registry" || config[key] !== "https://npm.jsr.io/") process.exit(1);
          }
        }
      } catch {
        process.exit(2);
      }
    '
    "/policy/$(basename -- "${config_report}")"
  )

  # Validate every candidate-controlled package-manager input with the pinned
  # Node runtime before pnpm can inspect packageManager/devEngines or select a
  # different executable. The trusted config exercises the same single policy
  # implementation used to validate pnpm's eventual effective configuration.
  if ! printf '%s\n' '{"registry":"https://registry.npmjs.org/","packages":["frontend","cloudflare"],"allowBuilds":{"esbuild":true,"workerd":true},"managePackageManagerVersions":false}' >"${config_report}"; then
    return 1
  fi
  if ! "${validate_command[@]}" >/dev/null 2>/dev/null; then
    return 1
  fi

  local -a pnpm_command=(
    docker run --rm
    --network none
    --read-only
    --tmpfs "/tmp:rw,nosuid,nodev,noexec"
    --env COREPACK_ENABLE_PROJECT_SPEC=0
    --env npm_config_manage_package_manager_versions=false
    --volume "${source_root}:/workspace:ro"
    --workdir /workspace
    "${SECURITY_PNPM_IMAGE}"
    pnpm --config.manage-package-manager-versions=false config list --json
  )
  if ! "${pnpm_command[@]}" >"${config_report}" 2>"${log_path}"; then
    return 1
  fi
  [[ ! -s "${log_path}" ]] || return 1

  if ! "${validate_command[@]}" >/dev/null 2>/dev/null; then
    return 1
  fi

  local lock_graph_report="${output_root}/pnpm-lock-graph.json"
  local lock_graph_log="${output_root}/pnpm-lock-graph.log"
  local -a lock_graph_command=(
    docker run --rm
    --network none
    --read-only
    --tmpfs "/tmp:rw,nosuid,nodev,noexec"
    --env COREPACK_ENABLE_PROJECT_SPEC=0
    --env npm_config_manage_package_manager_versions=false
    --volume "${source_root}:/workspace:ro"
    --workdir /workspace
    "${SECURITY_PNPM_IMAGE}"
    pnpm --config.manage-package-manager-versions=false
    list --lockfile-only --json --depth Infinity
  )
  if ! "${lock_graph_command[@]}" >"${lock_graph_report}" 2>"${lock_graph_log}"; then
    return 1
  fi
  [[ ! -s "${lock_graph_log}" ]] || return 1

  local -a validate_lock_graph_command=(
    docker run --rm
    --network none
    --read-only
    --tmpfs "/tmp:rw,nosuid,nodev,noexec"
    --volume "${source_root}:/workspace:ro"
    --volume "${output_root}:/policy:ro"
    "${SECURITY_NODE_IMAGE}"
    node -e
    '
      try {
        const fs = require("node:fs");
        const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
        const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
        const requireSchema = (condition) => {
          if (!condition) throw new Error("invalid pnpm lock graph schema");
        };
        const exactKeys = (value, expected) =>
          object(value) &&
          JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
        const readObject = (filePath, maximumSize) => {
          const stat = fs.lstatSync(filePath);
          requireSchema(
            stat.isFile() && !stat.isSymbolicLink() &&
            stat.size > 0 && stat.size <= maximumSize,
          );
          const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
          requireSchema(object(value));
          return value;
        };
        const reportPath = process.argv[1];
        const reportStat = fs.lstatSync(reportPath);
        requireSchema(
          reportStat.isFile() && !reportStat.isSymbolicLink() &&
          reportStat.size > 0 && reportStat.size <= 32 * 1024 * 1024,
        );
        const graph = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        requireSchema(Array.isArray(graph) && graph.length === 3);

        const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"];
        const nestedDependencySections = ["dependencies", "optionalDependencies"];
        const semanticVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
        const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
        const expectedProjects = new Map([
          ["/workspace", "/workspace/package.json"],
          ["/workspace/frontend", "/workspace/frontend/package.json"],
          ["/workspace/cloudflare", "/workspace/cloudflare/package.json"],
        ]);
        const seenProjects = new Set();
        const pending = [];

        const pushDependencies = (dependencies, expectedVersions) => {
          requireSchema(object(dependencies));
          const names = Object.keys(dependencies).sort();
          if (expectedVersions !== null) {
            requireSchema(object(expectedVersions));
            requireSchema(
              JSON.stringify(names) === JSON.stringify(Object.keys(expectedVersions).sort()),
            );
          }
          for (const name of names) {
            pending.push({
              name,
              value: dependencies[name],
              expectedVersion: expectedVersions === null ? null : expectedVersions[name],
            });
          }
        };

        for (const project of graph) {
          requireSchema(object(project) && typeof project.path === "string");
          const manifestPath = expectedProjects.get(project.path);
          requireSchema(manifestPath !== undefined && !seenProjects.has(project.path));
          seenProjects.add(project.path);
          const manifest = readObject(manifestPath, 1024 * 1024);
          const expectedProjectKeys = ["name", "version", "path", "private"];
          for (const section of dependencySections) {
            if (object(manifest[section]) && Object.keys(manifest[section]).length > 0) {
              expectedProjectKeys.push(section);
            }
          }
          requireSchema(exactKeys(project, expectedProjectKeys));
          requireSchema(
            project.name === manifest.name && project.version === manifest.version &&
            project.private === true,
          );
          for (const section of dependencySections) {
            const expected = object(manifest[section]) && Object.keys(manifest[section]).length > 0
              ? manifest[section]
              : null;
            if (expected === null) {
              requireSchema(!own(project, section));
            } else {
              requireSchema(own(project, section));
              pushDependencies(project[section], expected);
            }
          }
        }
        requireSchema(seenProjects.size === expectedProjects.size);

        let nodeCount = 0;
        while (pending.length > 0) {
          const { name, value, expectedVersion } = pending.pop();
          nodeCount += 1;
          requireSchema(nodeCount <= 100000);
          requireSchema(object(value) && packageName.test(name) && name !== "@jsr" && !name.startsWith("@jsr/"));
          requireSchema(value.from === name && semanticVersion.test(value.version));
          if (expectedVersion !== null) requireSchema(value.version === expectedVersion);

          const expectedNodeKeys = ["from", "version", "resolved", "path"];
          for (const section of nestedDependencySections) {
            if (own(value, section)) expectedNodeKeys.push(section);
          }
          const hasDeduplication = own(value, "deduped") || own(value, "dedupedDependenciesCount");
          if (hasDeduplication) expectedNodeKeys.push("deduped", "dedupedDependenciesCount");
          requireSchema(exactKeys(value, expectedNodeKeys));
          if (hasDeduplication) {
            requireSchema(
              value.deduped === true && Number.isSafeInteger(value.dedupedDependenciesCount) &&
              value.dedupedDependenciesCount > 0,
            );
          }

          const packageBasename = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
          const expectedResolved =
            "https://registry.npmjs.org/" + name + "/-/" + packageBasename + "-" + value.version + ".tgz";
          requireSchema(value.resolved === expectedResolved);

          const encodedName = name.replaceAll("/", "+");
          const pathPrefix = ".pnpm/" + encodedName + "@" + value.version;
          const pathSuffix = "/node_modules/" + name;
          requireSchema(
            typeof value.path === "string" && value.path.startsWith(pathPrefix) &&
            value.path.endsWith(pathSuffix),
          );
          const peerSuffix = value.path.slice(pathPrefix.length, value.path.length - pathSuffix.length);
          requireSchema(peerSuffix === "" || /^_[A-Za-z0-9@+._-]+$/.test(peerSuffix));

          for (const section of nestedDependencySections) {
            if (own(value, section)) pushDependencies(value[section], null);
          }
        }
        requireSchema(nodeCount > 0);
      } catch {
        process.exit(2);
      }
    '
    "/policy/$(basename -- "${lock_graph_report}")"
  )
  "${validate_lock_graph_command[@]}" >/dev/null 2>/dev/null
}

security_validate_go_module_policy() {
  local source_root="$1"
  local report_path="$2"
  local log_path="$3"
  local candidate_root="${4:-${source_root}}"
  local vendor_path
  local wildcard_excluded_go_path

  [[ -d "${source_root}" && ! -L "${source_root}" &&
    -d "${candidate_root}" && ! -L "${candidate_root}" ]] || return 1
  [[ -f "${source_root}/go.mod" && ! -L "${source_root}/go.mod" &&
    -s "${source_root}/go.mod" ]] || return 1
  [[ -f "${source_root}/go.sum" && ! -L "${source_root}/go.sum" &&
    -s "${source_root}/go.sum" ]] || return 1
  [[ ! -e "${source_root}/go.work" && ! -L "${source_root}/go.work" &&
    ! -e "${source_root}/go.work.sum" && ! -L "${source_root}/go.work.sum" &&
    ! -e "${candidate_root}/go.work" && ! -L "${candidate_root}/go.work" &&
    ! -e "${candidate_root}/go.work.sum" && ! -L "${candidate_root}/go.work.sum" ]] || return 1
  if ! vendor_path="$(cd -- "${source_root}" && find -P . -type d -name vendor -print -quit)"; then
    return 1
  fi
  [[ -z "${vendor_path}" ]] || return 1
  if ! wildcard_excluded_go_path="$(cd -- "${source_root}" && find -P . -type f -name '*.go' \
    \( -path '*/testdata/*' -o -path '*/.*/*' -o -path '*/_*/*' \) -print -quit)"; then
    return 1
  fi
  [[ -z "${wildcard_excluded_go_path}" ]] || return 1
  [[ ! -L "${report_path}" && ! -d "${report_path}" ]] || return 1

  local -a parse_command=(
    docker run --rm
    --network none
    --read-only
    --tmpfs "/tmp:rw,nosuid,nodev,noexec"
    --user "$(id -u):$(id -g)"
    --env HOME=/tmp/home
    --env GOENV=off
    --env GOWORK=off
    --env GOTOOLCHAIN=local
    --volume "${source_root}:/workspace:ro"
    --workdir /workspace
    "${SECURITY_GO_IMAGE}"
    go mod edit -json
  )
  if ! "${parse_command[@]}" >"${report_path}" 2>"${log_path}"; then
    return 1
  fi

  local -a validate_command=(
    docker run --rm
    --network none
    --read-only
    --tmpfs "/tmp:rw,nosuid,nodev,noexec"
    --volume "${report_path}:/policy/go-module.json:ro"
    "${SECURITY_NODE_IMAGE}"
    node -e
    '
      try {
        const fs = require("node:fs");
        const path = "/policy/go-module.json";
        const stat = fs.lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 8 * 1024 * 1024) {
          throw new Error("invalid Go module report");
        }
        const report = JSON.parse(fs.readFileSync(path, "utf8"));
        const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
        if (
          !object(report) || !object(report.Module) ||
          typeof report.Module.Path !== "string" || report.Module.Path.length < 1 ||
          typeof report.Go !== "string" || report.Go.length < 1 ||
          report.Replace !== null || report.Ignore !== null ||
          (Object.prototype.hasOwnProperty.call(report, "Toolchain") && report.Toolchain !== null)
        ) {
          throw new Error("unapproved Go module directive");
        }
      } catch {
        process.exit(2);
      }
    '
  )
  "${validate_command[@]}" >/dev/null 2>>"${log_path}"
}

security_run_govulncheck() {
  local source_root="$1"
  local cache_root="$2"
  local log_path="$3"

  security_prepare_go_cache "${cache_root}"
  # shellcheck disable=SC2016 # The single-quoted program expands in the container shell.
  local -a command=(
    docker run --rm
    --user "$(id -u):$(id -g)"
    --env HOME=/cache/home
    --env GOBIN=/cache/bin
    --env GOCACHE=/cache/build
    --env GOMODCACHE=/cache/mod
    --env GOPATH=/cache/gopath
    --env GOENV=off
    --env "GOFLAGS=-modcacherw -mod=readonly"
    --env GOWORK=off
    --env CGO_ENABLED=0
    --env GOOS=linux
    --env GOTOOLCHAIN=local
    --env "GOVULNCHECK_VERSION=${SECURITY_GOVULNCHECK_VERSION}"
    --volume "${cache_root}:/cache"
    --volume "${source_root}:/workspace:ro"
    --workdir /workspace
    "${SECURITY_GO_IMAGE}"
    sh -ceu
    'go install "golang.org/x/vuln/cmd/govulncheck@${GOVULNCHECK_VERSION}"; exec /cache/bin/govulncheck ./...'
  )
  "${command[@]}" >"${log_path}" 2>&1
}

security_run_gosec() {
  local source_root="$1"
  local cache_root="$2"
  local output_root="$3"
  local report_name="$4"
  local log_path="$5"
  local report_path="${output_root}/${report_name}"

  [[ "${report_name}" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
  security_prepare_go_cache "${cache_root}"
  # shellcheck disable=SC2016 # The single-quoted program expands in the container shell.
  local -a command=(
    docker run --rm
    --user "$(id -u):$(id -g)"
    --env HOME=/cache/home
    --env GOBIN=/cache/bin
    --env GOCACHE=/cache/build
    --env GOMODCACHE=/cache/mod
    --env GOPATH=/cache/gopath
    --env GOENV=off
    --env "GOFLAGS=-modcacherw -mod=readonly"
    --env GOWORK=off
    --env CGO_ENABLED=0
    --env GOOS=linux
    --env GOTOOLCHAIN=local
    --env "GOSEC_VERSION=${SECURITY_GOSEC_VERSION}"
    --env "GOSEC_REPORT_NAME=${report_name}"
    --volume "${cache_root}:/cache"
    --volume "${output_root}:/output"
    --volume "${source_root}:/workspace:ro"
    --workdir /workspace
    "${SECURITY_GO_IMAGE}"
    sh -ceu
    'go install "github.com/securego/gosec/v2/cmd/gosec@${GOSEC_VERSION}"
    tab="$(printf "\t")"
    go version -m /cache/bin/gosec | grep -F "${tab}mod${tab}github.com/securego/gosec/v2${tab}${GOSEC_VERSION}${tab}" >/dev/null
    printf "%s\n" "${GOSEC_VERSION}" >"/output/${GOSEC_REPORT_NAME}.module-version"
    exec /cache/bin/gosec -fmt=json -severity=high -confidence=high ./...'
  )
  "${command[@]}" >"${report_path}" 2>"${log_path}"
}

security_run_gitleaks_normalized_text() {
  local source_root="$1"
  local inventory_mode="$2"
  local config_path="$3"
  local log_path="$4"
  local scan_status=0

  [[ "${inventory_mode}" == "candidate" || "${inventory_mode}" == "staged" || "${inventory_mode}" == "history" ]] || return 1
  # shellcheck disable=SC2016 # The single-quoted program expands only inside the pinned container.
  local -a command=(
    docker run --rm
    --network none
    --read-only
    --tmpfs "/tmp:rw,nosuid,nodev,noexec"
    --user "$(id -u):$(id -g)"
    --env GIT_CONFIG_GLOBAL=/dev/null
    --env GIT_CONFIG_NOSYSTEM=1
    --env GIT_CONFIG_COUNT=1
    --env GIT_CONFIG_KEY_0=safe.directory
    --env GIT_CONFIG_VALUE_0=/source
    --env GIT_NO_LAZY_FETCH=1
    --env GIT_NO_REPLACE_OBJECTS=1
    --env "INVENTORY_MODE=${inventory_mode}"
    --env "LEGACY_BINARY_BLOB_OID=${SECURITY_LEGACY_BINARY_BLOB_OID}"
    --env "REVIEWED_BLOB_OIDS=${SECURITY_NORMALIZED_TEXT_REVIEWED_BLOB_OIDS}"
    --volume "${source_root}:/source:ro"
    --volume "${config_path}:/gitleaks/config.toml:ro"
    --workdir /source
    --entrypoint sh
    "${SECURITY_GITLEAKS_IMAGE}"
    -ceu
    '
      export LC_ALL=C
      mkdir /tmp/normalized
      materialized_count=0

      is_reviewed_blob() {
        case ":${REVIEWED_BLOB_OIDS}:" in
          *":$1:"*) return 0 ;;
          *) return 1 ;;
        esac
      }

      materialize_file() {
        object_id="$1"
        source_file="$2"
        case "${object_id}" in
          "" | *[!0-9a-f]*) exit 1 ;;
        esac
        test "${#object_id}" -eq 40
        if test "${object_id}" = "${LEGACY_BINARY_BLOB_OID}" || is_reviewed_blob "${object_id}"; then
          return 0
        fi
        target_file="/tmp/normalized/${object_id}.txt"
        if test -e "${target_file}"; then
          return 0
        fi
        printf "%s\n" FUKAMU_SECURITY_NORMALIZED_TEXT_BLOB > "${target_file}"
        cat -- "${source_file}" >> "${target_file}"
        printf "\n" >> "${target_file}"
        materialized_count=$((materialized_count + 1))
      }

      materialize_object() {
        object_id="$1"
        object_type="$2"
        case "${object_id}" in
          "" | *[!0-9a-f]*) exit 1 ;;
        esac
        test "${#object_id}" -eq 40
        case "${object_type}" in
          blob | commit | tag) ;;
          *) exit 1 ;;
        esac
        if test "${object_type}" = blob &&
          { test "${object_id}" = "${LEGACY_BINARY_BLOB_OID}" || is_reviewed_blob "${object_id}"; }; then
          return 0
        fi
        target_file="/tmp/normalized/${object_id}.txt"
        if test -e "${target_file}"; then
          return 0
        fi
        printf "%s\n" FUKAMU_SECURITY_NORMALIZED_TEXT_BLOB > "${target_file}"
        git cat-file "${object_type}" "${object_id}" >> "${target_file}"
        printf "\n" >> "${target_file}"
        materialized_count=$((materialized_count + 1))
      }

      manifest_entry_count=0
      manifest_byte_count=0
      validate_manifest_name() {
        manifest_name="$1"
        test -n "${manifest_name}"
        test "${#manifest_name}" -le 4096
        case "${manifest_name}" in
          *[!A-Za-z0-9._@+/-]*) exit 1 ;;
        esac
        case "/${manifest_name}/" in
          *"//"* | *"/./"* | *"/../"*) exit 1 ;;
        esac
      }

      append_manifest_name() {
        manifest_kind="$1"
        manifest_name="$2"
        manifest_file="$3"
        validate_manifest_name "${manifest_name}"
        manifest_entry_count=$((manifest_entry_count + 1))
        manifest_byte_count=$((manifest_byte_count + ${#manifest_kind} + ${#manifest_name} + 2))
        test "${manifest_entry_count}" -le 1000000
        test "${manifest_byte_count}" -le 16777216
        printf "%s\t%s\n" "${manifest_kind}" "${manifest_name}" >> "${manifest_file}"
      }

      materialize_manifest() {
        manifest_label="$1"
        manifest_file="$2"
        test "${manifest_entry_count}" -gt 0
        manifest_size="$(wc -c < "${manifest_file}")"
        case "${manifest_size}" in
          "" | *[!0-9]*) exit 1 ;;
        esac
        test "${manifest_size}" -eq "${manifest_byte_count}"
        target_file="/tmp/normalized/FUKAMU_SECURITY_${manifest_label}_MANIFEST.txt"
        test ! -e "${target_file}"
        printf "%s\n" FUKAMU_SECURITY_NORMALIZED_TEXT_NAME_MANIFEST > "${target_file}"
        cat -- "${manifest_file}" >> "${target_file}"
        printf "\n" >> "${target_file}"
        materialized_count=$((materialized_count + 1))
      }

      old_ifs="${IFS}"
      IFS=:
      set -- ${REVIEWED_BLOB_OIDS}
      IFS="${old_ifs}"
      test "$#" -eq 13
      for reviewed_oid in "$@"; do
        case "${reviewed_oid}" in
          "" | *[!0-9a-f]*) exit 1 ;;
        esac
        test "${#reviewed_oid}" -eq 40
      done

      case "${INVENTORY_MODE}" in
        candidate)
          : > /tmp/candidate-names
          find -P /source -type f -print0 > /tmp/candidate-files
          test -s /tmp/candidate-files
          while IFS= read -r -d "" source_file; do
            relative_path="${source_file#/source/}"
            test "${relative_path}" != "${source_file}"
            append_manifest_name candidate-path "${relative_path}" /tmp/candidate-names
            object_id="$(git hash-object --no-filters -- "${source_file}")"
            materialize_file "${object_id}" "${source_file}"
          done < /tmp/candidate-files
          materialize_manifest CANDIDATE_NAMES /tmp/candidate-names
          ;;
        staged)
          : > /tmp/staged-names
          : > /tmp/index-oids
          tab="$(printf "\t")"
          git ls-files --stage -z > /tmp/index-inventory
          test -s /tmp/index-inventory
          while IFS= read -r -d "" index_record; do
            case "${index_record}" in
              *"${tab}"*) ;;
              *) exit 1 ;;
            esac
            index_header="${index_record%%"${tab}"*}"
            relative_path="${index_record#*"${tab}"}"
            set -- ${index_header}
            test "$#" -eq 3
            test "$1" = 100644 || test "$1" = 100755
            case "$2" in
              "" | *[!0-9a-f]*) exit 1 ;;
            esac
            test "${#2}" -eq 40
            test "$3" = 0
            append_manifest_name staged-path "${relative_path}" /tmp/staged-names
            printf "%s\n" "$2" >> /tmp/index-oids
          done < /tmp/index-inventory
          sort -u /tmp/index-oids > /tmp/index-oids.sorted
          test -s /tmp/index-oids.sorted
          while IFS= read -r object_id; do
            materialize_object "${object_id}" blob
          done < /tmp/index-oids.sorted
          materialize_manifest STAGED_NAMES /tmp/staged-names
          ;;
        history)
          : > /tmp/history-names
          tab="$(printf "\t")"
          git rev-list --all > /tmp/history-commits
          test -s /tmp/history-commits
          while IFS= read -r commit_id; do
            case "${commit_id}" in
              "" | *[!0-9a-f]*) exit 1 ;;
            esac
            test "${#commit_id}" -eq 40
            git ls-tree -r -z --full-tree "${commit_id}" > /tmp/history-tree
            while IFS= read -r -d "" tree_record; do
              case "${tree_record}" in
                *"${tab}"*) ;;
                *) exit 1 ;;
              esac
              tree_header="${tree_record%%"${tab}"*}"
              relative_path="${tree_record#*"${tab}"}"
              set -- ${tree_header}
              test "$#" -eq 3
              test "$1" = 100644 || test "$1" = 100755
              test "$2" = blob
              case "$3" in
                "" | *[!0-9a-f]*) exit 1 ;;
              esac
              test "${#3}" -eq 40
              append_manifest_name history-path "${relative_path}" /tmp/history-names
            done < /tmp/history-tree
          done < /tmp/history-commits
          git rev-list --objects --all --no-object-names > /tmp/reachable-objects
          test -s /tmp/reachable-objects
          sort -u /tmp/reachable-objects > /tmp/unique-objects
          git cat-file --batch-check="%(objectname) %(objecttype) %(objectsize)" \
            < /tmp/unique-objects > /tmp/object-inventory
          while IFS=" " read -r object_id object_type object_size extra; do
            test -z "${extra}"
            case "${object_type}" in
              blob | commit | tag) materialize_object "${object_id}" "${object_type}" ;;
              tree) ;;
              *) exit 1 ;;
            esac
            case "${object_size}" in
              "" | *[!0-9]*) exit 1 ;;
            esac
          done < /tmp/object-inventory
          git for-each-ref --format="%(refname)%00" > /tmp/ref-names
          test -s /tmp/ref-names
          while IFS= read -r -d "" ref_name; do
            case "${ref_name}" in
              refs/*) ;;
              *) exit 1 ;;
            esac
            append_manifest_name history-ref "${ref_name}" /tmp/history-names
            IFS= read -r ref_record_terminator
            test -z "${ref_record_terminator}"
          done < /tmp/ref-names
          materialize_manifest HISTORY_NAMES /tmp/history-names
          ;;
        *) exit 1 ;;
      esac
      test "${materialized_count}" -gt 0
      exec gitleaks \
        --config=/gitleaks/config.toml \
        --ignore-gitleaks-allow \
        --max-archive-depth=5 \
        --max-decode-depth=5 \
        --max-target-megabytes=0 \
        --no-banner \
        --no-color \
        --redact \
        --verbose \
        --log-level=debug \
        dir /tmp/normalized
    '
  )
  "${command[@]}" >"${log_path}" 2>&1 || scan_status=$?
  ((scan_status == 0)) || return "${scan_status}"
  security_validate_normalized_gitleaks_log "${log_path}"
}

security_run_gitleaks_history() {
  local source_root="$1"
  local config_path="$2"
  local ignore_relative_path="$3"
  local log_path="$4"
  local scan_status=0
  local -a command=(
    docker run --rm
    --network none
    --read-only
    --tmpfs "/tmp:rw,nosuid,nodev,noexec"
    --user "$(id -u):$(id -g)"
    --env GIT_CONFIG_GLOBAL=/dev/null
    --env GIT_CONFIG_NOSYSTEM=1
    --env GIT_CONFIG_COUNT=1
    --env GIT_CONFIG_KEY_0=safe.directory
    --env GIT_CONFIG_VALUE_0=/source
    --env GIT_NO_LAZY_FETCH=1
    --env GIT_NO_REPLACE_OBJECTS=1
    --volume "${source_root}:/source:ro"
    --volume "${config_path}:/gitleaks/config.toml:ro"
    --workdir /source
    "${SECURITY_GITLEAKS_IMAGE}"
    --config=/gitleaks/config.toml
    --ignore-gitleaks-allow
    --max-archive-depth=5
    --max-decode-depth=5
    --max-target-megabytes=0
    git --no-banner --no-color --redact --verbose --timeout 600
  )
  if [[ -n "${ignore_relative_path}" ]]; then
    command+=(--gitleaks-ignore-path "/source/${ignore_relative_path}")
  fi
  command+=("--log-opts=--all --full-history -m --text --no-ext-diff --no-textconv" /source)
  "${command[@]}" >"${log_path}" 2>&1 || scan_status=$?
  ((scan_status == 0)) || return "${scan_status}"
  security_validate_gitleaks_log "${log_path}"
}

security_run_gitleaks_staged() {
  local source_root="$1"
  local config_path="$2"
  local ignore_relative_path="$3"
  local log_path="$4"
  local scan_status=0
  local -a command=(
    docker run --rm
    --network none
    --read-only
    --tmpfs "/tmp:rw,nosuid,nodev,noexec"
    --user "$(id -u):$(id -g)"
    --env GIT_CONFIG_GLOBAL=/dev/null
    --env GIT_CONFIG_NOSYSTEM=1
    --env GIT_CONFIG_COUNT=1
    --env GIT_CONFIG_KEY_0=safe.directory
    --env GIT_CONFIG_VALUE_0=/source
    --env GIT_NO_LAZY_FETCH=1
    --env GIT_NO_REPLACE_OBJECTS=1
    --volume "${source_root}:/source:ro"
    --volume "${config_path}:/gitleaks/config.toml:ro"
    --workdir /source
    "${SECURITY_GITLEAKS_IMAGE}"
    --config=/gitleaks/config.toml
    --ignore-gitleaks-allow
    --max-archive-depth=5
    --max-decode-depth=5
    --max-target-megabytes=0
    git --no-banner --no-color --redact --verbose --timeout 600
  )
  if [[ -n "${ignore_relative_path}" ]]; then
    command+=(--gitleaks-ignore-path "/source/${ignore_relative_path}")
  fi
  command+=(--staged /source)
  "${command[@]}" >"${log_path}" 2>&1 || scan_status=$?
  ((scan_status == 0)) || return "${scan_status}"
  security_validate_gitleaks_log "${log_path}"
}

security_run_gitleaks_directory() {
  local source_root="$1"
  local config_path="$2"
  local ignore_relative_path="$3"
  local log_path="$4"
  local scan_status=0
  local -a command=(
    docker run --rm
    --network none
    --read-only
    --tmpfs "/tmp:rw,nosuid,nodev,noexec"
    --user "$(id -u):$(id -g)"
    --env GIT_CONFIG_GLOBAL=/dev/null
    --env GIT_CONFIG_NOSYSTEM=1
    --env GIT_CONFIG_COUNT=1
    --env GIT_CONFIG_KEY_0=safe.directory
    --env GIT_CONFIG_VALUE_0=/source
    --env GIT_NO_LAZY_FETCH=1
    --env GIT_NO_REPLACE_OBJECTS=1
    --volume "${source_root}:/source:ro"
    --volume "${config_path}:/gitleaks/config.toml:ro"
    "${SECURITY_GITLEAKS_IMAGE}"
    --config=/gitleaks/config.toml
    --ignore-gitleaks-allow
    --max-archive-depth=5
    --max-decode-depth=5
    --max-target-megabytes=0
    dir --no-banner --no-color --redact --verbose --timeout 600
  )
  if [[ -n "${ignore_relative_path}" ]]; then
    command+=(--gitleaks-ignore-path "/source/${ignore_relative_path}")
  fi
  command+=(/source)
  "${command[@]}" >"${log_path}" 2>&1 || scan_status=$?
  ((scan_status == 0)) || return "${scan_status}"
  security_validate_gitleaks_log "${log_path}"
}

security_run_supply_chain_policy() {
  local source_root="$1"
  local -a command=(
    docker run --rm
    --network none
    --read-only
    --tmpfs "/tmp:rw,nosuid,nodev,noexec"
    --user "$(id -u):$(id -g)"
    --volume "${source_root}:/workspace:ro"
    --workdir /workspace
    "${SECURITY_NODE_IMAGE}"
    node scripts/check-supply-chain.mjs /workspace
  )
  "${command[@]}"
}

security_validate_terraform_module_policy() {
  local source_root="$1"
  local scan_target="$2"

  [[ -n "${scan_target}" && "${scan_target}" != /* && "${scan_target}" != ".." &&
    "${scan_target}" != ../* && "${scan_target}" != */../* && "${scan_target}" != */.. ]] || return 1
  local -a command=(
    docker run --rm
    --network none
    --read-only
    --tmpfs "/tmp:rw,nosuid,nodev,noexec"
    --user "$(id -u):$(id -g)"
    --volume "${source_root}:/workspace:ro"
    "${SECURITY_NODE_IMAGE}"
    node -e
    '
      try {
        const fs = require("node:fs");
        const path = require("node:path");
        const { TextDecoder } = require("node:util");
        const root = "/workspace";
        const target = path.resolve(root, process.argv[1]);
        const relativeTarget = path.relative(root, target);
        if (
          relativeTarget === "" ? false :
          relativeTarget === ".." || relativeTarget.startsWith("../") || path.isAbsolute(relativeTarget)
        ) {
          throw new Error("Terraform target escapes workspace");
        }
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const maximumFileSize = 16 * 1024 * 1024;
        const maximumFileCount = 10000;

        const identifierStart = (character) => /[A-Za-z_]/.test(character);
        const identifierContinue = (character) => /[A-Za-z0-9_-]/.test(character);

        const skipQuotedString = (source, start) => {
          let offset = start + 1;
          while (offset < source.length) {
            if (source[offset] === "\\") {
              offset += 2;
            } else if (source[offset] === "\"") {
              return offset + 1;
            } else {
              offset += 1;
            }
          }
          throw new Error("unterminated HCL string");
        };

        const skipBlockComment = (source, start) => {
          const end = source.indexOf("*/", start + 2);
          if (end < 0) throw new Error("unterminated HCL block comment");
          return end + 2;
        };

        const skipHeredoc = (source, start) => {
          let offset = start + 2;
          let indented = false;
          if (source[offset] === "-") {
            indented = true;
            offset += 1;
          }
          while (source[offset] === " " || source[offset] === "\t") offset += 1;
          const markerStart = offset;
          if (!identifierStart(source[offset] ?? "")) throw new Error("invalid HCL heredoc marker");
          offset += 1;
          while (identifierContinue(source[offset] ?? "")) offset += 1;
          const marker = source.slice(markerStart, offset);
          while (source[offset] === " " || source[offset] === "\t" || source[offset] === "\r") offset += 1;
          if (source[offset] !== "\n") throw new Error("invalid HCL heredoc introducer");
          offset += 1;
          while (offset <= source.length) {
            const lineEnd = source.indexOf("\n", offset);
            const end = lineEnd < 0 ? source.length : lineEnd;
            let line = source.slice(offset, end);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            const candidate = indented ? line.replace(/^[ \t]*/, "") : line;
            if (candidate === marker) return lineEnd < 0 ? source.length : lineEnd + 1;
            if (lineEnd < 0) break;
            offset = lineEnd + 1;
          }
          throw new Error("unterminated HCL heredoc");
        };

        const hasModuleBlock = (source) => {
          let offset = 0;
          let braceDepth = 0;
          let moduleState = 0;

          const acceptToken = (kind, value = "") => {
            if (braceDepth === 0) {
              if (moduleState === 0) {
                moduleState = kind === "identifier" && value === "module" ? 1 : 0;
              } else if (moduleState === 1) {
                moduleState = kind === "string" ? 2 :
                  kind === "identifier" && value === "module" ? 1 : 0;
              } else {
                if (kind === "left-brace") return true;
                moduleState = kind === "identifier" && value === "module" ? 1 : 0;
              }
            } else {
              moduleState = 0;
            }
            if (kind === "left-brace") {
              braceDepth += 1;
            } else if (kind === "right-brace") {
              braceDepth -= 1;
              if (braceDepth < 0) throw new Error("invalid HCL brace depth");
            }
            return false;
          };

          while (offset < source.length) {
            const character = source[offset];
            if (/\s/.test(character)) {
              offset += 1;
              continue;
            }
            if (character === "#" || (character === "/" && source[offset + 1] === "/")) {
              const newline = source.indexOf("\n", offset + 1);
              offset = newline < 0 ? source.length : newline + 1;
              continue;
            }
            if (character === "/" && source[offset + 1] === "*") {
              offset = skipBlockComment(source, offset);
              continue;
            }
            if (character === "<" && source[offset + 1] === "<") {
              offset = skipHeredoc(source, offset);
              if (acceptToken("other")) return true;
              continue;
            }
            if (character === "\"") {
              offset = skipQuotedString(source, offset);
              if (acceptToken("string")) return true;
              continue;
            }
            if (identifierStart(character)) {
              const start = offset;
              offset += 1;
              while (identifierContinue(source[offset] ?? "")) offset += 1;
              if (acceptToken("identifier", source.slice(start, offset))) return true;
              continue;
            }
            offset += 1;
            if (character === "{") {
              if (acceptToken("left-brace")) return true;
            } else if (character === "}") {
              if (acceptToken("right-brace")) return true;
            } else if (acceptToken("other")) {
              return true;
            }
          }
          return false;
        };

        const terraformFiles = [];
        const pending = [target];
        while (pending.length > 0) {
          const current = pending.pop();
          const stat = fs.lstatSync(current);
          if (stat.isSymbolicLink()) throw new Error("Terraform symlink");
          if (stat.isDirectory()) {
            for (const child of fs.readdirSync(current).sort().reverse()) {
              pending.push(path.join(current, child));
            }
          } else if (stat.isFile()) {
            if (current.endsWith(".tf")) terraformFiles.push(current);
          } else {
            throw new Error("Terraform special file");
          }
          if (terraformFiles.length > maximumFileCount) throw new Error("Terraform file count bound");
        }
        if (terraformFiles.length < 1) throw new Error("empty Terraform source inventory");
        for (const terraformFile of terraformFiles) {
          const stat = fs.lstatSync(terraformFile);
          if (stat.size > maximumFileSize) throw new Error("Terraform file size bound");
          const source = decoder.decode(fs.readFileSync(terraformFile));
          if (hasModuleBlock(source)) process.exit(1);
        }
      } catch {
        process.exit(2);
      }
    '
    "${scan_target}"
  )
  "${command[@]}" >/dev/null 2>/dev/null
}

security_run_terraform_syntax_check() {
  local source_root="$1"
  local scan_target="$2"
  local log_path="$3"

  [[ -n "${scan_target}" && "${scan_target}" != /* && "${scan_target}" != ".." &&
    "${scan_target}" != ../* && "${scan_target}" != */../* && "${scan_target}" != */.. ]] || return 1
  local -a command=(
    docker run --rm
    --network none
    --read-only
    --tmpfs "/tmp:rw,nosuid,nodev,noexec"
    --user "$(id -u):$(id -g)"
    --env CHECKPOINT_DISABLE=1
    --env HOME=/tmp/home
    --env TF_IN_AUTOMATION=1
    --volume "${source_root}:/workspace:ro"
    --workdir /workspace
    "${SECURITY_TERRAFORM_IMAGE}"
    fmt -check -diff=false -recursive "${scan_target}"
  )
  if ! "${command[@]}" >"${log_path}" 2>&1; then
    return 1
  fi

  # Terraform is the pinned syntax parser. The second pinned, networkless lexer
  # follows strings, line/block comments, heredocs, and brace depth so only a
  # real top-level `module "name" {` declaration is rejected. Fetched module
  # content remains unsupported until it has a separate pin-and-scan contract.
  security_validate_terraform_module_policy "${source_root}" "${scan_target}"
}

security_run_trivy_config() {
  local source_root="$1"
  local scan_target="$2"
  local cache_root="$3"
  local output_root="$4"
  local report_name="$5"
  local log_path="$6"
  local config_path="$7"
  local scan_path="${source_root}/${scan_target}"
  local terraform_source=''
  local terraform_json_source=''
  local terraform_variable_source=''
  local terraform_working_directory=''

  if [[ -d "${scan_path}" ]]; then
    if ! terraform_working_directory="$(find -P "${scan_path}" -type d -name .terraform -print -quit)"; then
      return 1
    fi
    [[ -z "${terraform_working_directory}" ]] || return 1
    if ! terraform_variable_source="$(find -P "${scan_path}" -type f \
      \( -name 'terraform.tfvars' -o -name 'terraform.tfvars.json' \
      -o -name '*.auto.tfvars' -o -name '*.auto.tfvars.json' \) -print -quit)"; then
      return 1
    fi
    [[ -z "${terraform_variable_source}" ]] || return 1
    if ! terraform_json_source="$(find -P "${scan_path}" -type f -name '*.tf.json' -print -quit)"; then
      return 1
    fi
    [[ -z "${terraform_json_source}" ]] || return 1
    if ! terraform_source="$(find -P "${scan_path}" -type f -name '*.tf' -print -quit)"; then
      return 1
    fi
    if [[ -n "${terraform_source}" ]] \
      && ! security_run_terraform_syntax_check "${source_root}" "${scan_target}" "${log_path}.terraform-syntax"; then
      return 1
    fi
  elif [[ -f "${scan_path}" ]]; then
    case "$(basename -- "${scan_path}")" in
      terraform.tfvars | terraform.tfvars.json | *.auto.tfvars | *.auto.tfvars.json | *.tf.json) return 1 ;;
    esac
  fi

  local -a command=(
    docker run --rm
    --network none
    --read-only
    --tmpfs "/tmp:rw,nosuid,nodev,noexec"
    --user "$(id -u):$(id -g)"
    --env HOME=/tmp/home
    --volume "${cache_root}:/cache"
    --volume "${output_root}:/output"
    --volume "${source_root}:/workspace:ro"
    --volume "${config_path}:/trivy/config.yaml:ro"
    --workdir /workspace
    "${SECURITY_TRIVY_IMAGE}"
    --config /trivy/config.yaml
    config
    --cache-dir /cache
    --disable-telemetry
    --skip-version-check
    --skip-check-update
    --ignorefile /dev/null
    --quiet
    --exit-code 1
    --severity "HIGH,CRITICAL"
    --format json
    --output "/output/${report_name}"
    "${scan_target}"
  )
  "${command[@]}" >"${log_path}" 2>&1
}

security_run_trivy_image_tar() {
  local image_tar="$1"
  local cache_root="$2"
  local output_root="$3"
  local report_name="$4"
  local log_path="$5"
  local config_path="$6"
  local -a command=(
    docker run --rm
    --user "$(id -u):$(id -g)"
    --volume "${cache_root}:/cache"
    --volume "$(dirname -- "${image_tar}"):/input:ro"
    --volume "${output_root}:/output"
    --volume "${config_path}:/trivy/config.yaml:ro"
    "${SECURITY_TRIVY_IMAGE}"
    --config /trivy/config.yaml
    image
    --input "/input/$(basename -- "${image_tar}")"
    --cache-dir /cache
    --disable-telemetry
    --skip-version-check
    --quiet
    --scanners vuln
    --pkg-types os
    --ignore-unfixed
    --exit-code 1
    --severity "HIGH,CRITICAL"
    --format json
    --output "/output/${report_name}"
  )
  "${command[@]}" >"${log_path}" 2>&1
}

security_classify_json_report() {
  local report_path="$1"
  local report_mode="$2"
  [[ -s "${report_path}" ]] || return 2

  local -a command=(
    docker run --rm
    --network none
    --read-only
    --tmpfs "/tmp:rw,nosuid,nodev,noexec"
    --volume "$(dirname -- "${report_path}"):/input:ro"
    "${SECURITY_NODE_IMAGE}"
    node -e
    '
      try {
        const fs = require("node:fs");
        const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const mode = process.argv[2];
        const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
        const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
        const text = (value) => typeof value === "string" && value.length > 0;
        const integer = (value) => Number.isSafeInteger(value) && value >= 0;
        const requireSchema = (condition) => {
          if (!condition) {
            throw new Error("invalid scanner report schema");
          }
        };
        const clean = (value) =>
          String(value ?? "unknown").replace(/[^A-Za-z0-9@._/:=+,>-]/g, "_").slice(0, 300);
        const findings = [];

        requireSchema(object(report));
        if (mode === "node-vulnerability") {
          requireSchema(object(report.advisories));
          requireSchema(object(report.metadata));
          const counts = report.metadata.vulnerabilities;
          requireSchema(object(counts));
          const severities = ["info", "low", "moderate", "high", "critical"];
          const countKeys = new Set([...severities, "total"]);
          requireSchema(Object.keys(counts).every((key) => countKeys.has(key)));
          for (const severity of severities) {
            requireSchema(own(counts, severity) && integer(counts[severity]));
          }
          const severityTotal = severities.reduce((sum, severity) => sum + counts[severity], 0);
          if (own(counts, "total")) {
            requireSchema(integer(counts.total) && counts.total === severityTotal);
          }
          const advisorySeverities = new Set(["info", "low", "moderate", "high", "critical"]);
          for (const advisory of Object.values(report.advisories)) {
            requireSchema(
              object(advisory) && text(advisory.severity) &&
              advisorySeverities.has(advisory.severity),
            );
            if (advisory.severity === "high" || advisory.severity === "critical") {
              findings.push("advisory severity=" + clean(advisory.severity));
            }
          }
          if (counts.high + counts.critical > 0) {
            findings.push(
              "critical=" + clean(counts.critical) +
              " high=" + clean(counts.high) +
              " moderate=" + clean(counts.moderate) +
              " low=" + clean(counts.low),
            );
          }
        } else if (mode === "gosec-high") {
          requireSchema(
            own(report, "Golang errors") && object(report["Golang errors"]) &&
            Object.keys(report["Golang errors"]).length === 0,
          );
          requireSchema(Array.isArray(report.Issues));
          requireSchema(object(report.Stats));
          requireSchema(text(report.GosecVersion) && report.GosecVersion.length <= 100);
          const moduleVersionPath = process.argv[1] + ".module-version";
          const moduleVersionStat = fs.lstatSync(moduleVersionPath);
          requireSchema(
            moduleVersionStat.isFile() && !moduleVersionStat.isSymbolicLink() &&
            moduleVersionStat.size > 0 && moduleVersionStat.size <= 32 &&
            fs.readFileSync(moduleVersionPath, "utf8") === "v2.22.11\n",
          );
          for (const field of ["files", "lines", "nosec", "found"]) {
            requireSchema(own(report.Stats, field) && integer(report.Stats[field]));
          }
          requireSchema(report.Stats.files > 0 && report.Stats.lines > 0);
          requireSchema(report.Stats.nosec === 0);
          requireSchema(report.Stats.found === report.Issues.length);
          for (const issue of report.Issues) {
            requireSchema(
              object(issue) && issue.severity === "HIGH" && issue.confidence === "HIGH" &&
              text(issue.rule_id) && text(issue.file) && text(issue.line),
            );
            findings.push(
              clean(issue.severity) + " " + clean(issue.rule_id) + " " +
              clean(issue.file) + ":" + clean(issue.line) +
              " confidence=" + clean(issue.confidence),
            );
          }
        } else if (mode === "trivy-misconfiguration") {
          requireSchema(
            report.SchemaVersion === 2 && report.ArtifactType === "filesystem" &&
            object(report.Trivy) && report.Trivy.Version === "0.73.0" &&
            Array.isArray(report.Results) && report.Results.length > 0,
          );
          for (const result of report.Results) {
            requireSchema(
              object(result) && result.Class === "config" && text(result.Type) &&
              text(result.Target) && object(result.MisconfSummary),
            );
            const summary = result.MisconfSummary;
            requireSchema(integer(summary.Successes) && integer(summary.Failures));
            const exceptions = own(summary, "Exceptions") ? summary.Exceptions : 0;
            requireSchema(integer(exceptions) && exceptions === 0);
            requireSchema(summary.Successes + summary.Failures > 0);
            const issues = own(result, "Misconfigurations") ? result.Misconfigurations : [];
            requireSchema(Array.isArray(issues) && issues.length === summary.Failures);
            for (const issue of issues) {
              requireSchema(
                object(issue) && ["HIGH", "CRITICAL"].includes(issue.Severity) &&
                text(issue.ID) && object(issue.CauseMetadata) &&
                Number.isSafeInteger(issue.CauseMetadata.StartLine) && issue.CauseMetadata.StartLine > 0,
              );
              findings.push(
                clean(issue.Severity) + " " + clean(issue.ID) + " " +
                clean(result.Target) + ":" + clean(issue.CauseMetadata.StartLine),
              );
            }
          }
        } else if (mode === "trivy-vulnerability") {
          requireSchema(
            report.SchemaVersion === 2 && report.ArtifactType === "container_image" &&
            object(report.Trivy) && report.Trivy.Version === "0.73.0" &&
            object(report.Metadata) && object(report.Metadata.OS) &&
            text(report.Metadata.OS.Family) && text(report.Metadata.OS.Name) &&
            Array.isArray(report.Results) && report.Results.length > 0,
          );
          let packageCount = 0;
          for (const result of report.Results) {
            requireSchema(
              object(result) && result.Class === "os-pkgs" && text(result.Type) &&
              text(result.Target) && Array.isArray(result.Packages),
            );
            for (const packageEntry of result.Packages) {
              requireSchema(
                object(packageEntry) && text(packageEntry.Name) && text(packageEntry.Version),
              );
            }
            packageCount += result.Packages.length;
            const issues = own(result, "Vulnerabilities") ? result.Vulnerabilities : [];
            requireSchema(Array.isArray(issues));
            for (const issue of issues) {
              requireSchema(
                object(issue) && ["HIGH", "CRITICAL"].includes(issue.Severity) &&
                text(issue.VulnerabilityID) && text(issue.PkgName) &&
                text(issue.InstalledVersion) && text(issue.FixedVersion),
              );
              findings.push(
                clean(issue.Severity) + " " + clean(issue.VulnerabilityID) + " " +
                clean(result.Target) + " " + clean(issue.PkgName) + " " +
                clean(issue.InstalledVersion) + " -> " + clean(issue.FixedVersion),
              );
            }
          }
          requireSchema(packageCount > 0);
        } else {
          throw new Error("unknown scanner report mode");
        }

        if (findings.length === 0) {
          process.exit(1);
        }
        for (const finding of findings) {
          console.log("  " + finding);
        }
      } catch {
        process.exit(2);
      }
    '
    "/input/$(basename -- "${report_path}")"
    "${report_mode}"
  )
  local classifier_status=0
  "${command[@]}" 2>/dev/null || classifier_status=$?
  case "${classifier_status}" in
    0 | 1 | 2) return "${classifier_status}" ;;
    *) return 2 ;;
  esac
}
