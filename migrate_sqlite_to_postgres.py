import argparse
import os
import sqlite3
import sys
from pathlib import Path

from sqlalchemy.exc import SQLAlchemyError


TABLES = (
    'users',
    'clients',
    'client_history',
    'audit_log',
    'seller_locations',
    'location_history',
    'sales_activities',
    'appointments',
    'appointment_history',
)
SEQUENCED_TABLES = tuple(table for table in TABLES if table != 'seller_locations')


def open_source(path):
    if not path.is_file():
        raise RuntimeError(f'Source database not found: {path}')
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA query_only = ON')
    return connection


def source_counts(connection):
    available = {row['name'] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    missing = set(TABLES) - available
    if missing:
        raise RuntimeError(f'Source database is missing tables: {", ".join(sorted(missing))}')
    violations = connection.execute('PRAGMA foreign_key_check').fetchall()
    if violations:
        raise RuntimeError('Source database contains broken foreign-key references')
    return {table: connection.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] for table in TABLES}


def migrate(source_path):
    if not os.environ.get('DATABASE_URL'):
        raise RuntimeError('Set DATABASE_URL to the external PostgreSQL connection string')
    os.environ['APP_ENV'] = 'production'

    import server

    if not server.IS_POSTGRES:
        raise RuntimeError('DATABASE_URL must use PostgreSQL')
    if not os.environ.get('BOOTSTRAP_ADMIN_USERNAME'):
        raise RuntimeError('Set BOOTSTRAP_ADMIN_USERNAME to the initial cloud administrator')

    source = open_source(source_path)
    try:
        counts = source_counts(source)
        source_users = source.execute('SELECT username, password_hash FROM users').fetchall()
        for user in source_users:
            demo_password = 'admin123' if user['username'] == 'admin' else 'ana123' if user['username'] == 'ana' else None
            if demo_password and server.password_matches(demo_password, user['password_hash']):
                raise RuntimeError(f'Change the demonstration password for {user["username"]} before migration')

        server.initialize_database()
        with server.db() as target:
            target_users = target.execute('SELECT id, username, role FROM users').fetchall()
            bootstrap_username = os.environ['BOOTSTRAP_ADMIN_USERNAME'].strip().lower()
            if len(target_users) != 1 or target_users[0]['username'] != bootstrap_username or target_users[0]['role'] != 'admin':
                raise RuntimeError('Target PostgreSQL must contain only the initial administrator')
            bootstrap_id = target_users[0]['id']
            for table in TABLES:
                if table == 'users':
                    continue
                count = target.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                if count:
                    raise RuntimeError(f'Target PostgreSQL table {table} is not empty; migration was stopped')

            target.execute('DELETE FROM users WHERE id = ?', (bootstrap_id,))
            for table in TABLES:
                source_columns = [row['name'] for row in source.execute(f'PRAGMA table_info({table})')]
                target_columns = server.table_columns(target, table)
                if not set(source_columns).issubset(target_columns):
                    raise RuntimeError(f'Target PostgreSQL schema is missing columns from {table}')
                columns_sql = ', '.join(source_columns)
                placeholders = ', '.join('?' for _ in source_columns)
                insert_sql = f'INSERT INTO {table} ({columns_sql}) VALUES ({placeholders})'
                source_rows = source.execute(f'SELECT {columns_sql} FROM {table}')
                while rows := source_rows.fetchmany(500):
                    target.executemany(insert_sql, [tuple(row) for row in rows])

            for table, expected_count in counts.items():
                actual_count = target.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                if actual_count != expected_count:
                    raise RuntimeError(f'Row-count verification failed for {table}: expected {expected_count}, got {actual_count}')
            for table in TABLES:
                if table != 'users':
                    target.execute(f'SELECT 1 FROM {table} LIMIT 0').fetchall()

            for table in SEQUENCED_TABLES:
                target.execute(f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), COALESCE(MAX(id), 1), COUNT(*) > 0) FROM {table}")
        return counts
    finally:
        source.close()


def main():
    parser = argparse.ArgumentParser(description='Copy Grubox CRM data from SQLite to PostgreSQL.')
    parser.add_argument('--source', type=Path, default=Path(__file__).with_name('grubox.db'))
    parser.add_argument('--execute', action='store_true', help='Write data to PostgreSQL. Without this option, only inspect SQLite.')
    arguments = parser.parse_args()

    try:
        source = open_source(arguments.source)
        try:
            counts = source_counts(source)
        finally:
            source.close()
        print('SQLite source counts:')
        for table, count in counts.items():
            print(f'  {table}: {count}')
        if not arguments.execute:
            print('Dry run only. No PostgreSQL connection or writes were made.')
            return 0
        migrated = migrate(arguments.source)
        print(f'Migration committed. Imported {sum(migrated.values())} rows across {len(TABLES)} tables.')
        return 0
    except (OSError, RuntimeError, sqlite3.Error, SQLAlchemyError) as error:
        print(f'Migration stopped: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())