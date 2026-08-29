#!/usr/bin/env bash

create_docs_config_candidate_snapshot() {
  (($# == 3)) || die "create_docs_config_candidate_snapshot requires source, destination, and metadata roots"

  local source_root
  source_root="$(realpath -e -- "$1")" \
    || die "Git candidate source root does not exist."
  local destination_root="$2"
  local metadata_root="$3"
  [[ -d "${destination_root}" && ! -L "${destination_root}" ]] \
    || die "Git candidate destination must be a real directory."
  [[ -d "${metadata_root}" && ! -L "${metadata_root}" ]] \
    || die "Git candidate metadata root must be a real directory."

  local git_root
  if ! git_root="$(trusted_git -C "${source_root}" rev-parse --show-toplevel 2>/dev/null)"; then
    die "Documentation/configuration checks require a Git worktree."
  fi
  git_root="$(realpath -e -- "${git_root}")" \
    || die "Git worktree root cannot be resolved."
  [[ "${git_root}" == "${source_root}" ]] \
    || die "Documentation/configuration checks must run from the Git worktree root."

  local candidate_manifest="${metadata_root}/candidate-manifest"
  local deleted_manifest="${metadata_root}/deleted-manifest"
  if ! trusted_git -C "${source_root}" \
    ls-files --cached --others --exclude-standard -z \
    >"${candidate_manifest}"; then
    die "Git candidate manifest generation failed."
  fi
  if ! trusted_git -C "${source_root}" ls-files --deleted -z >"${deleted_manifest}"; then
    die "Git deleted-path manifest generation failed."
  fi

  local relative_path
  local source_path
  local source_parent
  local canonical_source_path
  local canonical_source_parent
  local destination_path
  local deleted_path
  local is_deleted
  local file_count=0
  while IFS= read -r -d '' relative_path; do
    case "${relative_path}" in
      "" | /* | .. | ../* | */../* | */..)
        die "Git candidate manifest contains an unsafe path."
        ;;
    esac

    source_path="${source_root}/${relative_path}"
    if [[ ! -e "${source_path}" && ! -L "${source_path}" ]]; then
      is_deleted=false
      while IFS= read -r -d '' deleted_path; do
        if [[ "${deleted_path}" == "${relative_path}" ]]; then
          is_deleted=true
          break
        fi
      done <"${deleted_manifest}"
      [[ "${is_deleted}" == true ]] \
        || die "Git candidate path disappeared during snapshot: ${relative_path}"
      continue
    fi

    destination_path="${destination_root}/${relative_path}"
    mkdir -p -- "$(dirname -- "${destination_path}")" \
      || die "Git candidate destination directory creation failed."
    if [[ -L "${source_path}" ]]; then
      source_parent="$(dirname -- "${source_path}")"
      canonical_source_parent="$(realpath -e -- "${source_parent}")" \
        || die "Git candidate symlink parent cannot be resolved: ${relative_path}"
      [[ "${canonical_source_parent}" == "${source_parent}" ]] \
        || die "CANDIDATE_SYMLINK_COMPONENT_NOT_ALLOWED: ${relative_path}"
      cp --no-dereference -- "${source_path}" "${destination_path}" \
        || die "Git candidate symlink copy failed: ${relative_path}"
      [[ -L "${destination_path}" ]] \
        || die "Git candidate symlink was not preserved: ${relative_path}"
      ((file_count += 1))
      continue
    fi

    canonical_source_path="$(realpath -e -- "${source_path}")" \
      || die "Git candidate path cannot be resolved: ${relative_path}"
    [[ "${canonical_source_path}" == "${source_path}" ]] \
      || die "CANDIDATE_SYMLINK_COMPONENT_NOT_ALLOWED: ${relative_path}"
    [[ -f "${source_path}" ]] \
      || die "Git candidate path must be a regular file: ${relative_path}"
    cp --no-dereference --preserve=mode -- "${source_path}" "${destination_path}" \
      || die "Git candidate file copy failed: ${relative_path}"
    [[ -f "${destination_path}" && ! -L "${destination_path}" ]] \
      || die "Git candidate snapshot contains a non-regular file: ${relative_path}"
    ((file_count += 1))
  done <"${candidate_manifest}"

  rm -f -- "${candidate_manifest}" "${deleted_manifest}"
  ((file_count > 0)) || die "Git candidate snapshot is empty."
}

assert_docs_config_snapshot_regular_file() {
  (($# == 3)) || die "assert_docs_config_snapshot_regular_file requires root, path, and error code"
  local snapshot_root="$1"
  local relative_path="$2"
  local error_code="$3"
  local candidate_path="${snapshot_root}/${relative_path}"
  local canonical_path
  [[ -f "${candidate_path}" && ! -L "${candidate_path}" ]] \
    || die "${error_code}: ${relative_path}"
  canonical_path="$(realpath -e -- "${candidate_path}")" \
    || die "${error_code}: ${relative_path}"
  [[ "${canonical_path}" == "${candidate_path}" ]] \
    || die "${error_code}: ${relative_path}"
}

assert_docs_config_snapshot_real_directory() {
  (($# == 3)) || die "assert_docs_config_snapshot_real_directory requires root, path, and error code"
  local snapshot_root="$1"
  local relative_path="$2"
  local error_code="$3"
  local candidate_path="${snapshot_root}/${relative_path}"
  local canonical_path
  [[ -d "${candidate_path}" && ! -L "${candidate_path}" ]] \
    || die "${error_code}: ${relative_path}"
  canonical_path="$(realpath -e -- "${candidate_path}")" \
    || die "${error_code}: ${relative_path}"
  [[ "${canonical_path}" == "${candidate_path}" ]] \
    || die "${error_code}: ${relative_path}"
}
