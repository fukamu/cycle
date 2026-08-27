#!/usr/bin/env bash

# Operational tool and local/CI service images are immutable. Keep the readable
# version tag and update the digest in the same reviewed change.
# shellcheck disable=SC2034 # Sourced by scripts/check-before-commit.sh.
readonly SUPPLY_CHAIN_ACTIONLINT_IMAGE='rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667'
# shellcheck disable=SC2034 # Sourced by scripts/check-shell.sh.
readonly SUPPLY_CHAIN_SHELLCHECK_IMAGE='koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d'
# shellcheck disable=SC2034 # Sourced by scripts/check-shell.sh.
readonly SUPPLY_CHAIN_SHFMT_IMAGE='mvdan/shfmt:v3.13.1@sha256:f22f3936140be1ba02d493b5d2b91d0e8b4af93fd903e7f46c477822bca4a3be'
# shellcheck disable=SC2034 # Sourced by scripts/invoke-sqlc.sh.
readonly SUPPLY_CHAIN_SQLC_IMAGE='sqlc/sqlc:1.31.1@sha256:70f53171d27b2424e9358869975455a6e955a5aa8e58a998a270a6e34e525537'
# shellcheck disable=SC2034 # Sourced by scripts/reset-local-db.sh.
readonly SUPPLY_CHAIN_POSTGRES_IMAGE='postgres:18.6-alpine3.24@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2'
