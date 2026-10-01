#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${AWS_REGION:?AWS_REGION is required}"
: "${S3_BUCKET_NAME:?S3_BUCKET_NAME is required}"

backup_dir="$(mktemp -d)"
restore_data="$backup_dir/restore-data"
cleanup() {
	if [ -d "$restore_data" ]; then
		pg_ctl -D "$restore_data" -m fast -w stop >/dev/null 2>&1 || true
	fi
	rm -rf "$backup_dir"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
backup_name="grubox-$(date -u +%Y%m%dT%H%M%SZ).dump"
backup_path="$backup_dir/$backup_name"
restore_path="$backup_dir/restore-test.dump"
backup_key="${BACKUP_PREFIX:-grubox}/$(date -u +%Y/%m/%d)/$backup_name"

pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$backup_path"
pg_restore --list "$backup_path" >/dev/null
aws s3 cp "$backup_path" "s3://$S3_BUCKET_NAME/$backup_key" --region "$AWS_REGION" --sse AES256
aws s3 cp "s3://$S3_BUCKET_NAME/$backup_key" "$restore_path" --region "$AWS_REGION"
pg_restore --list "$restore_path" >/dev/null
initdb -D "$restore_data" --auth-local=trust --auth-host=reject --no-instructions >/dev/null
pg_ctl -D "$restore_data" -o "-c listen_addresses='' -c unix_socket_directories='$backup_dir' -p 55432" -w start >/dev/null
createdb --host="$backup_dir" --port=55432 --username=postgres grubox_restore_verify
pg_restore --host="$backup_dir" --port=55432 --username=postgres --dbname=grubox_restore_verify --no-owner --no-privileges --exit-on-error "$restore_path"
psql --host="$backup_dir" --port=55432 --username=postgres --dbname=grubox_restore_verify --set=ON_ERROR_STOP=1 --command='SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM clients; SELECT COUNT(*) FROM appointments;' >/dev/null
printf 'Downloaded, restored, and verified s3://%s/%s\n' "$S3_BUCKET_NAME" "$backup_key"