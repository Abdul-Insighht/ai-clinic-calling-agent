#!/usr/bin/env bash
set -euo pipefail

# PostgreSQL backup script for AiBitSol
# Usage: DATABASE_URL=... ./infrastructure/scripts/backup-postgres.sh [output_dir]

OUTPUT_DIR="${1:-./backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="${OUTPUT_DIR}/aibitsol_${TIMESTAMP}.sql.gz"

mkdir -p "${OUTPUT_DIR}"
pg_dump --format=plain --no-owner --no-acl "${DATABASE_URL:?Set DATABASE_URL}" | gzip > "${BACKUP_FILE}"
echo "Backup written to ${BACKUP_FILE}"
