import hashlib
import ipaddress
import json
import math
import mimetypes
import os
import secrets
import socket
import ssl
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import RLock
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

from sqlalchemy import create_engine, event, text
from sqlalchemy.exc import IntegrityError

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
# Todo el proyecto vive en esta carpeta; así SQLite y los archivos de la interfaz
# se encuentran igual aunque el servidor se inicie desde otro directorio.
BASE_DIR = Path(__file__).parent
APP_ENV = os.environ.get('APP_ENV', 'local').lower()
IS_PRODUCTION = APP_ENV in {'production', 'prod'}
DB_PATH = Path(os.environ.get('GRUBOX_DB_PATH', str(BASE_DIR / 'grubox.db'))).expanduser()
DATABASE_URL = os.environ.get('DATABASE_URL', '').strip()
if DATABASE_URL.startswith('postgres://'):
    DATABASE_URL = 'postgresql+psycopg://' + DATABASE_URL[len('postgres://'):]
elif DATABASE_URL.startswith('postgresql://'):
    DATABASE_URL = 'postgresql+psycopg://' + DATABASE_URL[len('postgresql://'):]
IS_POSTGRES = bool(DATABASE_URL)
if IS_PRODUCTION and not IS_POSTGRES:
    raise RuntimeError('DATABASE_URL de PostgreSQL es obligatorio en producción')
# 0.0.0.0 permite que entren equipos de la misma red local. El firewall sigue
# siendo quien decide desde qué perfiles de red se acepta la conexión.
HOST = os.environ.get('HOST', '0.0.0.0')
PORT = int(os.environ.get('PORT', '8000'))
APP_TIMEZONE = ZoneInfo(os.environ.get('APP_TIMEZONE', 'America/Mexico_City'))
CERT_DIR = BASE_DIR / '.cert'
# Las sesiones son ligeras y temporales. Al reiniciar el servidor, todos vuelven
# a iniciar sesión, pero los datos permanentes permanecen en SQLite.
SESSIONS = {}
# Solo estos archivos se entregan al navegador. Si agregas otro archivo a la
# interfaz (otro .js, un ícono), súmalo aquí o responderá 404.
PUBLIC_FILES = {'index.html', 'app.js', 'styles.css', 'grubox.png'}
LOGIN_ATTEMPTS = {}
MAX_LOGIN_FAILURES = 5
LOGIN_LOCK_SECONDS = 300
RESPONSE_CACHE = {}
RESPONSE_CACHE_LOCK = RLock()
RESPONSE_CACHE_TTL = 20
RESPONSE_CACHE_LIMIT = 256


def cached_response(key):
    now = time.monotonic()
    with RESPONSE_CACHE_LOCK:
        entry = RESPONSE_CACHE.get(key)
        if not entry:
            return None
        expires_at, payload = entry
        if expires_at <= now:
            RESPONSE_CACHE.pop(key, None)
            return None
        return payload


def cache_response(key, payload):
    now = time.monotonic()
    with RESPONSE_CACHE_LOCK:
        expired = [item_key for item_key, (expires_at, _) in RESPONSE_CACHE.items() if expires_at <= now]
        for item_key in expired:
            RESPONSE_CACHE.pop(item_key, None)
        if len(RESPONSE_CACHE) >= RESPONSE_CACHE_LIMIT:
            oldest = min(RESPONSE_CACHE, key=lambda item_key: RESPONSE_CACHE[item_key][0])
            RESPONSE_CACHE.pop(oldest, None)
        RESPONSE_CACHE[key] = (now + RESPONSE_CACHE_TTL, payload)


def clear_response_cache():
    with RESPONSE_CACHE_LOCK:
        RESPONSE_CACHE.clear()


def login_is_locked(key):
    """Bloquea temporalmente tras varios intentos fallidos desde la misma IP y usuario."""
    now = time.time()
    recent = [stamp for stamp in LOGIN_ATTEMPTS.get(key, []) if now - stamp < LOGIN_LOCK_SECONDS]
    LOGIN_ATTEMPTS[key] = recent
    return len(recent) >= MAX_LOGIN_FAILURES


def login_register_failure(key):
    LOGIN_ATTEMPTS.setdefault(key, []).append(time.time())


def local_timestamp():
    """Devuelve la hora local del equipo que ejecuta el servidor."""
    return datetime.now(APP_TIMEZONE).strftime('%Y-%m-%d %H:%M:%S')


def db():
    """Abre una transacción corta contra el motor configurado."""
    return DatabaseSession()


class DatabaseRow(dict):
    def __getitem__(self, key):
        if isinstance(key, int):
            return tuple(self.values())[key]
        return super().__getitem__(key)


class DatabaseResult:
    def __init__(self, result):
        self.result = result

    @staticmethod
    def _row(row):
        return DatabaseRow(row._mapping) if row is not None else None

    def fetchone(self):
        return self._row(self.result.fetchone())

    def fetchall(self):
        return [self._row(row) for row in self.result.fetchall()]

def _bind_qmark_parameters(statement, parameters):
    """Translate SQLite-style placeholders to SQLAlchemy named parameters."""
    if isinstance(parameters, dict):
        return statement, parameters
    values = tuple(parameters or ())
    output = []
    quote = None
    index = 0
    position = 0
    while position < len(statement):
        character = statement[position]
        if quote:
            output.append(character)
            if character == quote:
                if position + 1 < len(statement) and statement[position + 1] == quote:
                    output.append(statement[position + 1])
                    position += 1
                else:
                    quote = None
        elif character in "'\"":
            quote = character
            output.append(character)
        elif character == '?':
            output.append(f':p{index}')
            index += 1
        else:
            output.append(character)
        position += 1
    if index != len(values):
        raise ValueError(f'La consulta esperaba {index} parámetros y recibió {len(values)}')
    return ''.join(output), {f'p{index}': value for index, value in enumerate(values)}


class DatabaseSession:
    def __enter__(self):
        self.connection = DATABASE_ENGINE.connect()
        self.transaction = self.connection.begin()
        return self

    def __exit__(self, exception_type, exception, traceback):
        try:
            if exception_type:
                self.transaction.rollback()
            else:
                self.transaction.commit()
        finally:
            self.connection.close()

    def execute(self, statement, parameters=()):
        if IS_POSTGRES:
            statement = statement.replace('CURRENT_TIMESTAMP', 'CAST(CURRENT_TIMESTAMP AS TEXT)')
        statement, bound = _bind_qmark_parameters(statement, parameters)
        return DatabaseResult(self.connection.execute(text(statement), bound))

    def executemany(self, statement, parameter_sets):
        parameter_sets = list(parameter_sets)
        if not parameter_sets:
            return DatabaseResult(self.connection.execute(text(statement), []))
        original_statement = statement
        statement, first_bound = _bind_qmark_parameters(original_statement, parameter_sets[0])
        bound_sets = [first_bound]
        for parameters in parameter_sets[1:]:
            _, bound = _bind_qmark_parameters(original_statement, parameters)
            bound_sets.append(bound)
        return DatabaseResult(self.connection.execute(text(statement), bound_sets))

    def executescript(self, script):
        if IS_POSTGRES:
            script = script.replace('INTEGER PRIMARY KEY AUTOINCREMENT', 'SERIAL PRIMARY KEY')
        for statement in script.split(';'):
            if statement.strip():
                self.execute(statement)


if IS_POSTGRES:
    DATABASE_ENGINE = create_engine(
        DATABASE_URL,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=5,
        pool_recycle=1800,
    )
else:
    DATABASE_ENGINE = create_engine(
        f'sqlite:///{DB_PATH.as_posix()}',
        connect_args={'check_same_thread': False},
    )

    @event.listens_for(DATABASE_ENGINE, 'connect')
    def enable_sqlite_foreign_keys(connection, record):
        connection.execute('PRAGMA foreign_keys = ON')


def table_columns(connection, table_name):
    if IS_POSTGRES:
        rows = connection.execute('''SELECT column_name AS name FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = ?''', (table_name,)).fetchall()
    else:
        rows = connection.execute(f'PRAGMA table_info({table_name})').fetchall()
    return {row['name'] for row in rows}


def password_hash(password, salt=None):
    """Guarda contraseñas como hash con salt; nunca almacenamos el texto original."""
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 120000).hex()
    return f'{salt}${digest}'


def password_matches(password, stored):
    """Comprueba una contraseña sin comparar ni exponer contraseñas en claro."""
    try:
        salt, digest = stored.split('$', 1)
        candidate = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 120000).hex()
        return secrets.compare_digest(candidate, digest)
    except ValueError:
        return False


def initialize_database():
    """Crea la estructura inicial y datos de demostración solo si está vacía."""
    if not IS_POSTGRES and not DB_PATH.parent.is_dir():
        raise RuntimeError(f'No existe el directorio de datos de SQLite: {DB_PATH.parent}')
    with db() as connection:
        # Las tablas se crean una sola vez. La baja de vendedores es lógica
        # mediante `active`, para conservar sus prospectos y auditoría.
        connection.executescript('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('admin', 'seller')),
                password_hash TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS clients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                company TEXT NOT NULL,
                contact TEXT NOT NULL,
                value INTEGER NOT NULL DEFAULT 0,
                won_value INTEGER,
                estimated_quantity INTEGER NOT NULL DEFAULT 0,
                next_action TEXT NOT NULL,
                stage TEXT NOT NULL DEFAULT 'new',
                owner_id INTEGER NOT NULL REFERENCES users(id),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                call_date TEXT,
                call_time TEXT,
                contact_phone TEXT,
                email TEXT,
                company_phone TEXT,
                box_type TEXT,
                internal_code TEXT,
                sample_provided INTEGER,
                preferred_contact TEXT,
                drawing_provided INTEGER,
                requested_delivery_date TEXT,
                expected_delivery_date TEXT,
                plant TEXT,
                material_code TEXT,
                purchase_order TEXT,
                pieces_per_kg REAL,
                unit_of_measure TEXT,
                planned_requirement TEXT,
                supplier TEXT,
                company_location TEXT,
                delivery_address TEXT,
                delivery_conditions TEXT,
                quote_specifications TEXT,
                flute TEXT,
                ink_count INTEGER,
                internal_dimensions TEXT,
                external_dimensions TEXT,
                liner_type TEXT,
                mikelman_treatment TEXT,
                pallet TEXT,
                periodicity TEXT,
                payment_terms TEXT,
                max_pallet_height TEXT,
                target_price REAL,
                opportunity_type TEXT,
                industry TEXT,
                product_measure TEXT,
                probability INTEGER NOT NULL DEFAULT 0,
                weighted_forecast REAL NOT NULL DEFAULT 0,
                estimated_close_date TEXT,
                capture_step INTEGER NOT NULL DEFAULT 3,
                capture_complete INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS client_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id),
                from_stage TEXT,
                to_stage TEXT,
                call_date TEXT,
                call_time TEXT,
                note TEXT,
                activity_type TEXT,
                outcome TEXT,
                next_action TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id),
                action TEXT NOT NULL,
                detail TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS seller_locations (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                accuracy REAL,
                sharing INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS location_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                accuracy REAL,
                recorded_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sales_activities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id),
                activity_type TEXT NOT NULL,
                amount INTEGER NOT NULL DEFAULT 0,
                note TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS appointments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id),
                appointment_date TEXT NOT NULL,
                appointment_time TEXT NOT NULL,
                appointment_type TEXT NOT NULL,
                stage TEXT NOT NULL,
                estimated_sale INTEGER NOT NULL DEFAULT 0,
                result TEXT NOT NULL DEFAULT 'pending',
                note TEXT,
                result_note TEXT,
                next_action TEXT,
                follow_up_date TEXT,
                follow_up_time TEXT,
                result_stage TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS appointment_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id),
                event_type TEXT NOT NULL,
                result TEXT,
                appointment_date TEXT,
                appointment_time TEXT,
                previous_stage TEXT,
                current_stage TEXT,
                note TEXT,
                next_action TEXT,
                follow_up_date TEXT,
                follow_up_time TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_client_history_client_id ON client_history(client_id, id DESC);
            CREATE INDEX IF NOT EXISTS idx_client_history_user_id ON client_history(user_id, id DESC);
            CREATE INDEX IF NOT EXISTS idx_location_history_user_date ON location_history(user_id, recorded_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_clients_owner_id ON clients(owner_id, id DESC);
            CREATE INDEX IF NOT EXISTS idx_clients_owner_stage_created ON clients(owner_id, stage, created_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_clients_owner_call_schedule ON clients(owner_id, call_date, call_time) WHERE call_date IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_clients_email_lower ON clients(LOWER(email)) WHERE email IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_clients_contact_phone ON clients(contact_phone) WHERE contact_phone IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_clients_company_phone ON clients(company_phone) WHERE company_phone IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_sales_activities_week ON sales_activities(created_at, user_id, activity_type);
            CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(appointment_date, appointment_time, user_id);
            CREATE INDEX IF NOT EXISTS idx_appointments_user_schedule ON appointments(user_id, appointment_date, appointment_time);
            CREATE INDEX IF NOT EXISTS idx_appointment_history_date ON appointment_history(created_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_appointment_history_appointment ON appointment_history(appointment_id, id DESC);
        ''')
        if IS_POSTGRES:
            connection.execute('CREATE EXTENSION IF NOT EXISTS pg_trgm')
            for column in ('company', 'contact', 'email', 'contact_phone', 'company_phone'):
                connection.execute(f'CREATE INDEX IF NOT EXISTS idx_clients_{column}_trgm ON clients USING GIN ({column} gin_trgm_ops)')
        # Migracion ligera para instalaciones creadas antes del registro de llamadas.
        client_columns = table_columns(connection, 'clients')
        if 'call_date' not in client_columns:
            connection.execute('ALTER TABLE clients ADD COLUMN call_date TEXT')
        if 'call_time' not in client_columns:
            connection.execute('ALTER TABLE clients ADD COLUMN call_time TEXT')
        if 'contact_phone' not in client_columns:
            connection.execute('ALTER TABLE clients ADD COLUMN contact_phone TEXT')
        if 'email' not in client_columns:
            connection.execute('ALTER TABLE clients ADD COLUMN email TEXT')
        if 'company_phone' not in client_columns:
            connection.execute('ALTER TABLE clients ADD COLUMN company_phone TEXT')
        if 'box_type' not in client_columns:
            connection.execute('ALTER TABLE clients ADD COLUMN box_type TEXT')
        if 'estimated_quantity' not in client_columns:
            connection.execute('ALTER TABLE clients ADD COLUMN estimated_quantity INTEGER NOT NULL DEFAULT 0')
        if 'won_value' not in client_columns:
            connection.execute('ALTER TABLE clients ADD COLUMN won_value INTEGER')
        if 'internal_code' not in client_columns:
            connection.execute('ALTER TABLE clients ADD COLUMN internal_code TEXT')
        if 'sample_provided' not in client_columns:
            connection.execute('ALTER TABLE clients ADD COLUMN sample_provided INTEGER')
        if 'preferred_contact' not in client_columns:
            connection.execute('ALTER TABLE clients ADD COLUMN preferred_contact TEXT')
        if 'drawing_provided' not in client_columns:
            connection.execute('ALTER TABLE clients ADD COLUMN drawing_provided INTEGER')
        if 'requested_delivery_date' not in client_columns:
            connection.execute('ALTER TABLE clients ADD COLUMN requested_delivery_date TEXT')
        if 'expected_delivery_date' not in client_columns:
            connection.execute('ALTER TABLE clients ADD COLUMN expected_delivery_date TEXT')
        for column in ('plant', 'material_code', 'purchase_order', 'unit_of_measure', 'planned_requirement', 'supplier'):
            if column not in client_columns:
                connection.execute(f'ALTER TABLE clients ADD COLUMN {column} TEXT')
        for column in ('company_location', 'delivery_address', 'delivery_conditions', 'quote_specifications',
                       'flute', 'internal_dimensions', 'external_dimensions', 'liner_type', 'mikelman_treatment',
                       'pallet', 'periodicity', 'payment_terms', 'max_pallet_height', 'opportunity_type',
                       'industry', 'product_measure', 'estimated_close_date'):
            if column not in client_columns:
                connection.execute(f'ALTER TABLE clients ADD COLUMN {column} TEXT')
        for column, declaration in (('ink_count', 'INTEGER'), ('probability', 'INTEGER NOT NULL DEFAULT 0'),
                                    ('weighted_forecast', 'REAL NOT NULL DEFAULT 0'), ('target_price', 'REAL')):
            if column not in client_columns:
                connection.execute(f'ALTER TABLE clients ADD COLUMN {column} {declaration}')
        for column, declaration in (('capture_step', 'INTEGER NOT NULL DEFAULT 3'),
                                    ('capture_complete', 'INTEGER NOT NULL DEFAULT 1')):
            if column not in client_columns:
                connection.execute(f'ALTER TABLE clients ADD COLUMN {column} {declaration}')
        if 'pieces_per_kg' not in client_columns:
            connection.execute('ALTER TABLE clients ADD COLUMN pieces_per_kg REAL')
        for column in ('lost_reason', 'pinned_note'):
            if column not in client_columns:
                connection.execute(f'ALTER TABLE clients ADD COLUMN {column} TEXT')
        history_columns = table_columns(connection, 'client_history')
        if 'note' not in history_columns:
            connection.execute('ALTER TABLE client_history ADD COLUMN note TEXT')
        for column in ('activity_type', 'outcome', 'next_action'):
            if column not in history_columns:
                connection.execute(f'ALTER TABLE client_history ADD COLUMN {column} TEXT')
        appointment_columns = table_columns(connection, 'appointments')
        for column in ('result_note', 'next_action', 'follow_up_date', 'follow_up_time', 'result_stage'):
            if column not in appointment_columns:
                connection.execute(f'ALTER TABLE appointments ADD COLUMN {column} TEXT')
        connection.execute('''INSERT INTO appointment_history(appointment_id, user_id, event_type, result,
            appointment_date, appointment_time, previous_stage, current_stage, note, created_at)
            SELECT appointments.id, appointments.user_id, 'scheduled', 'pending', appointments.appointment_date,
                appointments.appointment_time, appointments.stage, appointments.stage, appointments.note,
                COALESCE(appointments.created_at, CURRENT_TIMESTAMP)
            FROM appointments WHERE NOT EXISTS (
                SELECT 1 FROM appointment_history WHERE appointment_id = appointments.id AND event_type = 'scheduled'
            )''')
        connection.execute('''INSERT INTO appointment_history(appointment_id, user_id, event_type, result,
            appointment_date, appointment_time, previous_stage, current_stage, note, created_at)
            SELECT appointments.id, appointments.user_id, 'result', appointments.result, appointments.appointment_date,
                appointments.appointment_time, appointments.stage, appointments.stage, appointments.result_note,
                COALESCE(appointments.created_at, CURRENT_TIMESTAMP)
            FROM appointments WHERE appointments.result != 'pending' AND NOT EXISTS (
                SELECT 1 FROM appointment_history WHERE appointment_id = appointments.id AND event_type = 'result'
            )''')
        connection.execute('''INSERT INTO location_history(user_id, latitude, longitude, accuracy, recorded_at)
            SELECT current.user_id, current.latitude, current.longitude, current.accuracy, current.updated_at
            FROM seller_locations AS current
            WHERE current.sharing = 1 AND NOT EXISTS (
                SELECT 1 FROM location_history AS history
                WHERE history.user_id = current.user_id AND history.recorded_at = current.updated_at
            )''')
        if connection.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 0:
            if IS_PRODUCTION:
                username = os.environ.get('BOOTSTRAP_ADMIN_USERNAME', '').strip().lower()
                password = os.environ.get('BOOTSTRAP_ADMIN_PASSWORD', '')
                if not username or len(password) < 16:
                    raise RuntimeError('Configura BOOTSTRAP_ADMIN_USERNAME y una BOOTSTRAP_ADMIN_PASSWORD de al menos 16 caracteres')
                name = os.environ.get('BOOTSTRAP_ADMIN_NAME', 'Administrador').strip() or 'Administrador'
                connection.execute('INSERT INTO users(username, name, role, password_hash) VALUES (?, ?, ?, ?)', (username, name, 'admin', password_hash(password)))
            else:
                connection.execute('INSERT INTO users(username, name, role, password_hash) VALUES (?, ?, ?, ?)', ('admin', 'M. Brito', 'admin', password_hash('admin123')))
                connection.execute('INSERT INTO users(username, name, role, password_hash) VALUES (?, ?, ?, ?)', ('ana', 'Ana Torres', 'seller', password_hash('ana123')))
        if not IS_PRODUCTION and connection.execute('SELECT COUNT(*) FROM clients').fetchone()[0] == 0:
            seller_id = connection.execute("SELECT id FROM users WHERE username = 'ana'").fetchone()[0]
            connection.executemany('INSERT INTO clients(company, contact, value, next_action, stage, owner_id) VALUES (?, ?, ?, ?, ?, ?)', [
                ('Comercializadora del Centro', 'Iván Castillo', 41000, 'Llamada: vencida hace 1 día', 'negotiation', seller_id),
                ('Empacadora del Valle', 'Roberto Salas', 68000, 'Cotización: mañana', 'quoted', seller_id),
                ('Muebles y Embalajes SA', 'Ricardo Nava', 61000, 'Llamada: en 15 días', 'won', seller_id),
            ])


def user_from_request(handler):
    """Obtiene la sesión de la cookie y descarta sesiones vencidas."""
    token = handler.headers.get('Cookie', '').replace('grubox_session=', '').split(';')[0]
    session = SESSIONS.get(token)
    if not session or session['expires'] < time.time():
        SESSIONS.pop(token, None)
        return None
    return session['user']


def audit(user, action, detail):
    """Deja un registro sencillo de acciones relevantes del sistema."""
    with db() as connection:
        connection.execute('INSERT INTO audit_log(user_id, action, detail) VALUES (?, ?, ?)', (user['id'], action, detail))
    clear_response_cache()


def create_local_certificate(addresses):
    """Genera un certificado de desarrollo válido para la laptop y su LAN."""
    CERT_DIR.mkdir(exist_ok=True)
    key_path = CERT_DIR / 'server-key.pem'
    cert_path = CERT_DIR / 'server-cert.pem'
    names = [x509.DNSName('localhost'), x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]
    names.extend(x509.IPAddress(ipaddress.ip_address(address)) for address in addresses)
    names.append(x509.DNSName(socket.gethostname()))
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Grubox CRM local')])
    now = datetime.now(timezone.utc)
    certificate = x509.CertificateBuilder().subject_name(subject).issuer_name(issuer).public_key(private_key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1)).not_valid_after(now + timedelta(days=365)).add_extension(x509.SubjectAlternativeName(names), critical=False).sign(private_key, hashes.SHA256())
    key_path.write_bytes(private_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    return cert_path, key_path


def parse_date_range(query_values):
    """Lee y valida los parámetros from/to (AAAA-MM-DD) de una consulta."""
    date_from = query_values.get('from', [''])[0]
    date_to = query_values.get('to', [''])[0]
    for value in (date_from, date_to):
        if value:
            datetime.strptime(value, '%Y-%m-%d')
    return date_from, date_to


class Handler(BaseHTTPRequestHandler):
    """Pequeño servidor HTTP: API JSON y archivos estáticos del CRM."""

    def log_message(self, format, *args):
        # El servidor estándar imprime cada petición; lo silenciamos para que
        # la ventana de operación muestre solo información útil.
        return

    def send_json(self, payload, status=200, headers=None):
        """Responde con el mismo formato JSON en todas las rutas de la API."""
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        """Lee el cuerpo JSON enviado por el navegador."""
        size = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(size) or '{}')

    def require_user(self, admin=False):
        """Protege una ruta y, si hace falta, exige el rol administrador."""
        user = user_from_request(self)
        if not user:
            self.send_json({'error': 'Sesión no válida'}, 401)
            return None
        if admin and user['role'] != 'admin':
            self.send_json({'error': 'No tienes permisos para esta sección'}, 403)
            return None
        return user

    def do_GET(self):
        # Las rutas /api requieren sesión; los demás GET sirven la interfaz.
        path = urlparse(self.path).path
        if path == '/healthz':
            try:
                with db() as connection:
                    connection.execute('SELECT 1').fetchone()
                return self.send_json({'status': 'ok'})
            except Exception:
                return self.send_json({'status': 'unavailable'}, 503)
        if path == '/api/session':
            user = user_from_request(self)
            return self.send_json({'user': user})
        user = self.require_user() if path.startswith('/api/') else None
        if path.startswith('/api/') and not user:
            return
        if path == '/api/clients':
            query_values = parse_qs(urlparse(self.path).query)
            try:
                page = max(1, int(query_values.get('page', ['1'])[0]))
                page_size = min(100, max(10, int(query_values.get('page_size', ['50'])[0])))
            except ValueError:
                return self.send_json({'error': 'La página solicitada no es válida'}, 400)
            search_text = query_values.get('q', [''])[0].strip()[:100]
            stage = query_values.get('stage', ['all'])[0]
            owner_filter_value = query_values.get('owner_id', ['all'])[0]
            follow_filter_value = query_values.get('follow', ['all'])[0]
            sort_value = query_values.get('sort', ['default'])[0]
            if stage not in {'all', 'new', 'negotiation', 'quoted', 'won', 'lost'}:
                return self.send_json({'error': 'La etapa solicitada no es válida'}, 400)
            if follow_filter_value not in {'all', 'overdue', 'today', 'unscheduled', 'stale'}:
                return self.send_json({'error': 'El filtro de seguimiento no es válido'}, 400)
            if sort_value not in {'default', 'value', 'company', 'call'}:
                return self.send_json({'error': 'El orden solicitado no es válido'}, 400)
            scope_filters, scope_params = [], []
            if user['role'] != 'admin':
                scope_filters.append('clients.owner_id = ?')
                scope_params.append(user['id'])
            filters, params = list(scope_filters), list(scope_params)
            if user['role'] == 'admin' and owner_filter_value != 'all':
                try:
                    filters.append('clients.owner_id = ?')
                    params.append(int(owner_filter_value))
                except ValueError:
                    return self.send_json({'error': 'El vendedor solicitado no es válido'}, 400)
            if stage != 'all':
                filters.append('clients.stage = ?')
                params.append(stage)
            if follow_filter_value == 'overdue':
                filters.extend(["clients.stage NOT IN ('won', 'lost')", 'clients.call_date < ?'])
                params.append(datetime.now(APP_TIMEZONE).date().strftime('%Y-%m-%d'))
            elif follow_filter_value == 'today':
                filters.extend(["clients.stage NOT IN ('won', 'lost')", 'clients.call_date = ?'])
                params.append(datetime.now(APP_TIMEZONE).date().strftime('%Y-%m-%d'))
            elif follow_filter_value == 'unscheduled':
                filters.extend(["clients.stage NOT IN ('won', 'lost')", 'clients.call_date IS NULL'])
            elif follow_filter_value == 'stale':
                filters.append("clients.stage NOT IN ('won', 'lost')")
                filters.append("COALESCE((SELECT created_at FROM client_history WHERE client_id = clients.id AND outcome IS NOT NULL ORDER BY id DESC LIMIT 1), clients.created_at) <= ?")
                params.append((datetime.now(APP_TIMEZONE) - timedelta(days=7)).strftime('%Y-%m-%d %H:%M:%S'))
            if search_text:
                columns = ('company', 'contact', 'internal_code', 'email', 'contact_phone', 'company_phone',
                           'company_location', 'box_type', 'next_action', 'plant', 'material_code', 'purchase_order',
                           'supplier', 'planned_requirement', 'opportunity_type', 'industry', 'product_measure',
                           'delivery_address', 'quote_specifications')
                if IS_POSTGRES:
                    search_clauses = [f'clients.{column} ILIKE ?' for column in columns]
                else:
                    search_clauses = [f'LOWER(clients.{column}) LIKE LOWER(?)' for column in columns]
                filters.append('(' + ' OR '.join(search_clauses) + ')')
                params.extend([f'%{search_text}%'] * len(columns))
            where = f"WHERE {' AND '.join(filters)}" if filters else ''
            scope_where = f"WHERE {' AND '.join(scope_filters)}" if scope_filters else ''
            order_by = {
                'default': 'clients.created_at DESC, clients.id DESC',
                'value': 'clients.value DESC, clients.id DESC',
                'company': 'clients.company COLLATE NOCASE, clients.id DESC' if not IS_POSTGRES else 'LOWER(clients.company), clients.id DESC',
                'call': 'CASE WHEN clients.call_date IS NULL THEN 1 ELSE 0 END, clients.call_date, clients.call_time, clients.id DESC',
            }[sort_value]
            with db() as connection:
                total = connection.execute(f'SELECT COUNT(*) FROM clients {where}', params).fetchone()[0]
                page_count = max(1, math.ceil(total / page_size))
                page = min(page, page_count)
                offset = (page - 1) * page_size
                summary = connection.execute(f'''SELECT COUNT(*) AS total,
                    COALESCE(SUM(CASE WHEN stage = 'won' THEN COALESCE(won_value, value) ELSE 0 END), 0) AS won_value,
                    COALESCE(SUM(CASE WHEN stage IN ('new', 'negotiation', 'quoted') THEN value ELSE 0 END), 0) AS active_value,
                    COALESCE(SUM(CASE WHEN stage = 'lost' THEN value ELSE 0 END), 0) AS lost_value,
                    COALESCE(SUM(CASE stage WHEN 'new' THEN value * 0.1 WHEN 'negotiation' THEN value * 0.4 WHEN 'quoted' THEN value * 0.6 ELSE 0 END), 0) AS forecast,
                    SUM(CASE WHEN stage = 'won' THEN 1 ELSE 0 END) AS won_count,
                    SUM(CASE WHEN stage = 'lost' THEN 1 ELSE 0 END) AS lost_count
                    FROM clients {scope_where}''', scope_params).fetchone()
                today = datetime.now(APP_TIMEZONE).date().strftime('%Y-%m-%d')
                stale_before = (datetime.now(APP_TIMEZONE) - timedelta(days=7)).strftime('%Y-%m-%d %H:%M:%S')
                followup_counts = connection.execute(f'''SELECT
                    COALESCE(SUM(CASE WHEN stage NOT IN ('won', 'lost') AND call_date < ? THEN 1 ELSE 0 END), 0) AS overdue,
                    COALESCE(SUM(CASE WHEN stage NOT IN ('won', 'lost') AND call_date = ? THEN 1 ELSE 0 END), 0) AS today,
                    COALESCE(SUM(CASE WHEN stage NOT IN ('won', 'lost') AND call_date IS NULL THEN 1 ELSE 0 END), 0) AS unscheduled,
                    COALESCE(SUM(CASE WHEN stage NOT IN ('won', 'lost') AND
                        COALESCE((SELECT created_at FROM client_history WHERE client_id = clients.id AND outcome IS NOT NULL ORDER BY id DESC LIMIT 1), clients.created_at) <= ?
                        THEN 1 ELSE 0 END), 0) AS stale
                    FROM clients {scope_where}''', [today, today, stale_before, *scope_params]).fetchone()
                stage_rows = connection.execute(f'''SELECT stage, COUNT(*) AS count,
                    COALESCE(SUM(CASE WHEN stage = 'won' THEN COALESCE(won_value, value) ELSE value END), 0) AS amount
                    FROM clients {where} GROUP BY stage''', params).fetchall()
                query = '''SELECT clients.*, users.name AS owner_name,
                    (SELECT from_stage FROM client_history WHERE client_id = clients.id ORDER BY id DESC LIMIT 1) AS last_from_stage,
                    (SELECT to_stage FROM client_history WHERE client_id = clients.id ORDER BY id DESC LIMIT 1) AS last_to_stage,
                    (SELECT call_date FROM client_history WHERE client_id = clients.id ORDER BY id DESC LIMIT 1) AS last_call_date,
                    (SELECT call_time FROM client_history WHERE client_id = clients.id ORDER BY id DESC LIMIT 1) AS last_call_time,
                    (SELECT note FROM client_history WHERE client_id = clients.id ORDER BY id DESC LIMIT 1) AS last_note,
                    (SELECT created_at FROM client_history WHERE client_id = clients.id ORDER BY id DESC LIMIT 1) AS last_movement_at,
                    (SELECT created_at FROM client_history WHERE client_id = clients.id AND outcome IS NOT NULL ORDER BY id DESC LIMIT 1) AS last_contact_at
                    FROM clients JOIN users ON users.id = clients.owner_id'''
                rows = connection.execute(f'{query} {where} ORDER BY {order_by} LIMIT ? OFFSET ?', [*params, page_size, offset]).fetchall()
                owners = connection.execute("SELECT id, name FROM users WHERE role = 'seller' AND active = 1 ORDER BY name").fetchall() if user['role'] == 'admin' else []
            summary_data = dict(summary)
            summary_data['forecast'] = float(summary_data['forecast'] or 0)
            return self.send_json({'clients': [dict(row) for row in rows], 'total': total, 'page': page,
                'page_size': page_size, 'page_count': page_count, 'summary': summary_data,
                'followup_counts': dict(followup_counts),
                'stage_summary': {row['stage']: {'count': row['count'], 'amount': row['amount']} for row in stage_rows},
                'owners': [dict(row) for row in owners]})
        if path == '/api/reminders':
            now = datetime.now(APP_TIMEZONE)
            today = now.date().strftime('%Y-%m-%d')
            start_time = (now - timedelta(minutes=60)).strftime('%H:%M')
            end_time = (now + timedelta(minutes=10)).strftime('%H:%M')
            time_filter = 'call_time BETWEEN ? AND ?' if start_time <= end_time else '(call_time >= ? OR call_time <= ?)'
            scope = ' AND owner_id = ?' if user['role'] != 'admin' else ''
            params = [today, start_time, end_time]
            if user['role'] != 'admin':
                params.append(user['id'])
            with db() as connection:
                rows = connection.execute(f'''SELECT id, company, call_date, call_time FROM clients
                    WHERE stage NOT IN ('won', 'lost') AND call_date = ? AND {time_filter}{scope}
                    ORDER BY call_time LIMIT 100''', params).fetchall()
            return self.send_json({'reminders': [dict(row) for row in rows]})
        if path == '/api/appointments':
            query = '''SELECT appointments.*, clients.company, clients.contact, clients.stage AS current_stage,
                clients.won_value AS current_won_value, clients.lost_reason AS current_lost_reason, users.name AS executive
                FROM appointments JOIN clients ON clients.id = appointments.client_id
                JOIN users ON users.id = appointments.user_id'''
            params = ()
            if user['role'] != 'admin':
                query += ' WHERE clients.owner_id = ?'
                params = (user['id'],)
            with db() as connection:
                rows = connection.execute(query + ' ORDER BY appointment_date DESC, appointment_time DESC LIMIT 500', params).fetchall()
            return self.send_json({'appointments': [dict(row) for row in rows]})
        if path == '/api/analysis':
            try:
                date_from, date_to = parse_date_range(parse_qs(urlparse(self.path).query))
            except ValueError:
                return self.send_json({'error': 'Revisa el rango de fechas'}, 400)
            date_from = date_from or datetime.now(APP_TIMEZONE).strftime('%Y-%m-01')
            date_to = date_to or datetime.now(APP_TIMEZONE).strftime('%Y-%m-%d')
            if date_from > date_to:
                return self.send_json({'error': 'La fecha inicial debe ser anterior a la fecha final'}, 400)
            cache_key = ('analysis', user['id'], date_from, date_to)
            cached = cached_response(cache_key)
            if cached is not None:
                return self.send_json(cached)
            filters = ['appointment_history.created_at >= ?', 'appointment_history.created_at <= ?']
            params = [f'{date_from} 00:00:00', f'{date_to} 23:59:59']
            if user['role'] != 'admin':
                filters.append('clients.owner_id = ?')
                params.append(user['id'])
            where = 'WHERE ' + ' AND '.join(filters)
            with db() as connection:
                summary = connection.execute(f'''WITH scoped_events AS (
                    SELECT appointment_history.* FROM appointment_history
                    JOIN appointments ON appointments.id = appointment_history.appointment_id
                    JOIN clients ON clients.id = appointments.client_id {where}
                ), latest_results AS (
                    SELECT *, ROW_NUMBER() OVER (PARTITION BY appointment_id ORDER BY id DESC) AS result_rank
                    FROM scoped_events WHERE event_type = 'result'
                ), stage_progress AS (
                    SELECT appointment_id,
                        MAX(CASE WHEN result = 'completed' AND previous_stage != current_stage
                            AND CASE current_stage WHEN 'new' THEN 0 WHEN 'negotiation' THEN 1 WHEN 'quoted' THEN 2 WHEN 'won' THEN 3 WHEN 'lost' THEN -1 ELSE -2 END >
                            CASE previous_stage WHEN 'new' THEN 0 WHEN 'negotiation' THEN 1 WHEN 'quoted' THEN 2 WHEN 'won' THEN 3 WHEN 'lost' THEN -1 ELSE -2 END THEN 1 ELSE 0 END) AS advanced
                    FROM scoped_events WHERE event_type = 'result' GROUP BY appointment_id
                )
                SELECT
                    (SELECT COUNT(DISTINCT appointment_id) FROM scoped_events WHERE event_type = 'scheduled') AS scheduled,
                    SUM(CASE WHEN result_rank = 1 AND result = 'completed' THEN 1 ELSE 0 END) AS completed,
                    SUM(CASE WHEN result_rank = 1 AND result = 'rescheduled' THEN 1 ELSE 0 END) AS rescheduled,
                    SUM(CASE WHEN result_rank = 1 AND result = 'canceled' THEN 1 ELSE 0 END) AS canceled,
                    SUM(CASE WHEN latest_results.result_rank = 1 AND latest_results.result = 'completed'
                        AND stage_progress.advanced = 1 THEN 1 ELSE 0 END) AS advanced,
                    SUM(CASE WHEN latest_results.result_rank = 1 AND latest_results.result = 'completed'
                        AND stage_progress.advanced = 0 AND latest_results.previous_stage = latest_results.current_stage
                        THEN 1 ELSE 0 END) AS stayed
                FROM latest_results LEFT JOIN stage_progress USING (appointment_id)''', params).fetchone()
                rows = connection.execute(f'''SELECT appointment_history.*, appointments.appointment_date,
                    appointments.appointment_time, appointments.appointment_type, appointments.estimated_sale,
                    clients.company, clients.stage AS current_client_stage, users.name AS user_name
                    FROM appointment_history JOIN appointments ON appointments.id = appointment_history.appointment_id
                    JOIN clients ON clients.id = appointments.client_id
                    JOIN users ON users.id = appointment_history.user_id
                    {where} ORDER BY appointment_history.created_at DESC, appointment_history.id DESC LIMIT 300''', params).fetchall()
                stage_query = '''SELECT clients.stage, COUNT(*) AS count,
                    COALESCE(SUM(CASE WHEN clients.stage = 'won' THEN COALESCE(clients.won_value, clients.value)
                        ELSE clients.value END), 0) AS amount
                    FROM clients'''
                stage_params = []
                if user['role'] != 'admin':
                    stage_query += ' WHERE clients.owner_id = ?'
                    stage_params.append(user['id'])
                stage_query += ' GROUP BY clients.stage'
                stages = connection.execute(stage_query, stage_params).fetchall()
            payload = {'from': date_from, 'to': date_to, 'summary': {key: int(summary[key] or 0) for key in ('scheduled', 'completed', 'rescheduled', 'canceled', 'advanced', 'stayed')}, 'stages': [dict(row) for row in stages], 'events': [dict(row) for row in rows]}
            cache_response(cache_key, payload)
            return self.send_json(payload)
        if path == '/api/kpis':
            requested_week = parse_qs(urlparse(self.path).query).get('week', [datetime.now(APP_TIMEZONE).strftime('%G-W%V')])[0]
            try:
                week_start = datetime.strptime(f'{requested_week}-1', '%G-W%V-%u')
            except ValueError:
                return self.send_json({'error': 'La semana solicitada no es válida'}, 400)
            cache_key = ('kpis', user['id'], requested_week)
            cached = cached_response(cache_key)
            if cached is not None:
                return self.send_json(cached)
            week_end = week_start + timedelta(days=7)
            with db() as connection:
                query = '''SELECT activity_type, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
                    FROM sales_activities WHERE created_at >= ? AND created_at < ?'''
                params = [week_start.strftime('%Y-%m-%d'), week_end.strftime('%Y-%m-%d')]
                if user['role'] != 'admin':
                    query += ' AND user_id = ?'
                    params.append(user['id'])
                rows = connection.execute(query + ' GROUP BY activity_type', params).fetchall()
                appointment_query = 'SELECT COUNT(*) FROM appointments WHERE appointment_date >= ? AND appointment_date < ?'
                appointment_params = [week_start.strftime('%Y-%m-%d'), week_end.strftime('%Y-%m-%d')]
                if user['role'] != 'admin':
                    appointment_query += ' AND user_id = ?'
                    appointment_params.append(user['id'])
                appointment_count = connection.execute(appointment_query, appointment_params).fetchone()[0]
                quote_query = '''SELECT COUNT(DISTINCT sales_activities.client_id) AS quoted_clients,
                    COUNT(DISTINCT CASE WHEN clients.stage = 'won' THEN clients.id END) AS converted_clients,
                    COALESCE(SUM(sales_activities.amount), 0) AS quoted_amount
                    FROM sales_activities JOIN clients ON clients.id = sales_activities.client_id
                    WHERE sales_activities.activity_type = 'quote_sent'
                    AND sales_activities.created_at >= ? AND sales_activities.created_at < ?'''
                quote_params = [week_start.strftime('%Y-%m-%d'), week_end.strftime('%Y-%m-%d')]
                if user['role'] != 'admin':
                    quote_query += ' AND sales_activities.user_id = ?'
                    quote_params.append(user['id'])
                quote_stats = dict(connection.execute(quote_query, quote_params).fetchone())
            payload = {'week_start': week_start.strftime('%Y-%m-%d'), 'activities': [dict(row) for row in rows], 'appointments': appointment_count, 'quote_stats': quote_stats}
            cache_response(cache_key, payload)
            return self.send_json(payload)
        if path.startswith('/api/clients/') and path.endswith('/history'):
            client_id = path.split('/')[3]
            with db() as connection:
                client = connection.execute('SELECT id, owner_id FROM clients WHERE id = ?', (client_id,)).fetchone()
                if not client or (user['role'] != 'admin' and client['owner_id'] != user['id']):
                    return self.send_json({'error': 'Prospecto no encontrado'}, 404)
                rows = connection.execute('''SELECT client_history.*, users.name AS user_name
                    FROM client_history JOIN users ON users.id = client_history.user_id
                    WHERE client_id = ? ORDER BY client_history.id DESC''', (client_id,)).fetchall()
            return self.send_json({'history': [dict(row) for row in rows]})
        if path.startswith('/api/clients/'):
            client_id = path.rsplit('/', 1)[-1]
            with db() as connection:
                client = connection.execute('''SELECT clients.*, users.name AS owner_name
                    FROM clients JOIN users ON users.id = clients.owner_id WHERE clients.id = ?''', (client_id,)).fetchone()
                if not client or (user['role'] != 'admin' and client['owner_id'] != user['id']):
                    return self.send_json({'error': 'Prospecto no encontrado'}, 404)
            return self.send_json({'client': dict(client)})
        if path == '/api/movements':
            try:
                date_from, date_to = parse_date_range(parse_qs(urlparse(self.path).query))
            except ValueError:
                return self.send_json({'error': 'Revisa el rango de fechas'}, 400)
            filters, params = [], []
            if user['role'] != 'admin':
                filters.append('client_history.user_id = ?')
                params.append(user['id'])
            if date_from:
                filters.append('client_history.created_at >= ?')
                params.append(f'{date_from} 00:00:00')
            if date_to:
                filters.append('client_history.created_at <= ?')
                params.append(f'{date_to} 23:59:59')
            where = f"WHERE {' AND '.join(filters)}" if filters else ''
            with db() as connection:
                rows = connection.execute(f'''SELECT client_history.*, clients.company, users.name AS user_name
                    FROM client_history
                    JOIN clients ON clients.id = client_history.client_id
                    JOIN users ON users.id = client_history.user_id
                    {where} ORDER BY client_history.id DESC LIMIT 200''', params).fetchall()
            return self.send_json({'movements': [dict(row) for row in rows]})
        if path == '/api/admin/dashboard':
            if user['role'] != 'admin':
                return self.send_json({'error': 'No autorizado'}, 403)
            requested_year = parse_qs(urlparse(self.path).query).get('year', [str(datetime.now(APP_TIMEZONE).year)])[0]
            try:
                year = int(requested_year)
                if year < 2000 or year > 2100:
                    raise ValueError
            except ValueError:
                return self.send_json({'error': 'El año solicitado no es válido'}, 400)
            year_start = f'{year:04d}-01-01'
            year_end = f'{year + 1:04d}-01-01'
            with db() as connection:
                goal_row = connection.execute('SELECT value FROM app_settings WHERE key = ?', (f'annual_goal_{year}',)).fetchone()
                annual_goal = float(goal_row['value']) if goal_row else 0
                month_rows = connection.execute('''SELECT substr(clients.estimated_close_date, 6, 2) AS month,
                        SUM(CASE WHEN clients.probability >= 70 THEN clients.value ELSE 0 END) AS committed,
                        SUM(CASE WHEN clients.probability >= 40 AND clients.probability < 70 THEN clients.value ELSE 0 END) AS probable,
                        SUM(CASE WHEN clients.probability < 40 THEN clients.value ELSE 0 END) AS possible,
                        SUM(clients.weighted_forecast) AS weighted_forecast
                    FROM clients
                    WHERE clients.stage IN ('new', 'negotiation', 'quoted')
                        AND clients.estimated_close_date >= ? AND clients.estimated_close_date < ?
                    GROUP BY substr(clients.estimated_close_date, 6, 2)''', (year_start, year_end)).fetchall()
                actual = connection.execute('''WITH ranked_history AS (
                        SELECT client_id, to_stage, created_at,
                            ROW_NUMBER() OVER (PARTITION BY client_id ORDER BY created_at DESC, id DESC) AS rank
                        FROM client_history
                    )
                    SELECT COALESCE(SUM(COALESCE(clients.won_value, clients.value)), 0) AS amount
                    FROM ranked_history JOIN clients ON clients.id = ranked_history.client_id
                    WHERE ranked_history.rank = 1 AND ranked_history.to_stage = 'won'
                        AND ranked_history.created_at >= ? AND ranked_history.created_at < ?''',
                    (year_start, year_end)).fetchone()['amount']
                pipeline_total = connection.execute("SELECT COALESCE(SUM(value), 0) AS amount FROM clients WHERE stage IN ('new', 'negotiation', 'quoted')").fetchone()['amount']
                annual_forecast = connection.execute('''SELECT COALESCE(SUM(weighted_forecast), 0) AS amount
                    FROM clients WHERE stage IN ('new', 'negotiation', 'quoted')
                        AND estimated_close_date >= ? AND estimated_close_date < ?''', (year_start, year_end)).fetchone()['amount']
                new_clients = connection.execute('SELECT COUNT(*) AS count FROM clients WHERE created_at >= ? AND created_at < ?', (year_start, year_end)).fetchone()['count']
                recovered_accounts = connection.execute('''SELECT COUNT(DISTINCT client_id) AS count FROM client_history
                    WHERE from_stage = 'lost' AND to_stage IN ('new', 'negotiation', 'quoted', 'won')
                        AND created_at >= ? AND created_at < ?''', (year_start, year_end)).fetchone()['count']
            monthly_data = {int(row['month']): dict(row) for row in month_rows}
            months = [{
                'month': month,
                'goal': annual_goal / 12,
                'committed': float(monthly_data.get(month, {}).get('committed') or 0),
                'probable': float(monthly_data.get(month, {}).get('probable') or 0),
                'possible': float(monthly_data.get(month, {}).get('possible') or 0),
                'weighted_forecast': float(monthly_data.get(month, {}).get('weighted_forecast') or 0)
            } for month in range(1, 13)]
            actual = float(actual or 0)
            pipeline_total = float(pipeline_total or 0)
            annual_forecast = float(annual_forecast or 0)
            return self.send_json({
                'year': year, 'annual_goal': annual_goal, 'weighted_forecast': annual_forecast,
                'actual_sales': actual, 'compliance': actual / annual_goal * 100 if annual_goal else 0,
                'gap': annual_goal - actual, 'pipeline_total': pipeline_total,
                'pipeline_to_goal': pipeline_total / annual_goal * 100 if annual_goal else 0,
                'recovered_accounts': int(recovered_accounts or 0), 'new_clients': int(new_clients or 0),
                'months': months
            })
        if path == '/api/admin/summary':
            if user['role'] != 'admin':
                return self.send_json({'error': 'No autorizado'}, 403)
            cache_key = ('admin-summary', user['id'])
            cached = cached_response(cache_key)
            if cached is not None:
                return self.send_json(cached)
            with db() as connection:
                # El resumen separa dinero ganado, perdido y todavía activo.
                sellers = connection.execute('''SELECT users.name, COUNT(clients.id) AS opportunities, COALESCE(SUM(CASE WHEN clients.stage = 'won' THEN COALESCE(clients.won_value, clients.value) ELSE 0 END), 0) AS won_value, COALESCE(SUM(CASE WHEN clients.stage = 'lost' THEN clients.value ELSE 0 END), 0) AS lost_value, COALESCE(SUM(CASE WHEN clients.stage IN ('new', 'negotiation', 'quoted') THEN clients.value ELSE 0 END), 0) AS active_value FROM users LEFT JOIN clients ON clients.owner_id = users.id WHERE users.role = 'seller' AND users.active = 1 GROUP BY users.id ORDER BY won_value DESC''').fetchall()
                stages = connection.execute('SELECT stage, COUNT(*) AS count FROM clients GROUP BY stage').fetchall()
                totals = connection.execute("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN stage = 'won' THEN COALESCE(won_value, value) ELSE 0 END), 0) AS won_value, COALESCE(SUM(CASE WHEN stage = 'lost' THEN value ELSE 0 END), 0) AS lost_value, COALESCE(SUM(CASE WHEN stage IN ('new', 'negotiation', 'quoted') THEN value ELSE 0 END), 0) AS active_value, COALESCE(SUM(value), 0) AS pipeline FROM clients").fetchone()
                today = datetime.now(APP_TIMEZONE).date()
                today_text = today.strftime('%Y-%m-%d')
                two_days_text = (today + timedelta(days=2)).strftime('%Y-%m-%d')
                week_start_text = (today - timedelta(days=today.weekday())).strftime('%Y-%m-%d')
                call_stats = connection.execute("SELECT CASE WHEN call_date < ? THEN 'overdue' WHEN call_date = ? THEN 'today' WHEN call_date <= ? THEN 'soon' ELSE 'later' END AS status, COUNT(*) AS count FROM clients WHERE call_date IS NOT NULL AND stage NOT IN ('won', 'lost') GROUP BY status", (today_text, today_text, two_days_text)).fetchall()
                notifications = connection.execute("SELECT clients.id, clients.company, clients.call_date, clients.call_time, clients.stage, users.name AS owner_name, CASE WHEN clients.call_date < ? THEN 'overdue' WHEN clients.call_date = ? THEN 'today' ELSE 'soon' END AS priority FROM clients JOIN users ON users.id = clients.owner_id WHERE clients.call_date IS NOT NULL AND clients.stage NOT IN ('won', 'lost') AND clients.call_date <= ? ORDER BY CASE WHEN clients.call_date < ? THEN 0 WHEN clients.call_date = ? THEN 1 ELSE 2 END, clients.call_date, clients.call_time LIMIT 8", (today_text, today_text, two_days_text, today_text, today_text)).fetchall()
                seller_follow = connection.execute('''SELECT users.id, users.name,
                    COALESCE(SUM(CASE WHEN clients.stage NOT IN ('won', 'lost') AND clients.call_date < ? THEN 1 ELSE 0 END), 0) AS overdue,
                    COALESCE(SUM(CASE WHEN clients.stage NOT IN ('won', 'lost') AND clients.call_date = ? THEN 1 ELSE 0 END), 0) AS today,
                    COALESCE(SUM(CASE WHEN clients.stage NOT IN ('won', 'lost') AND clients.call_date IS NULL THEN 1 ELSE 0 END), 0) AS unscheduled,
                    (SELECT COUNT(*) FROM sales_activities AS sa WHERE sa.user_id = users.id AND sa.activity_type = 'follow_up'
                        AND sa.created_at >= ?) AS follow_ups_week
                    FROM users LEFT JOIN clients ON clients.owner_id = users.id
                    WHERE users.role = 'seller' AND users.active = 1 GROUP BY users.id ORDER BY overdue DESC''', (today_text, today_text, week_start_text)).fetchall()
                lost_reasons = connection.execute('''SELECT COALESCE(lost_reason, 'Sin motivo') AS reason, COUNT(*) AS count, COALESCE(SUM(value), 0) AS amount
                    FROM clients WHERE stage = 'lost' GROUP BY reason ORDER BY amount DESC LIMIT 8''').fetchall()
            payload = {'sellers': [dict(row) for row in sellers], 'stages': [dict(row) for row in stages], 'totals': dict(totals), 'call_stats': [dict(row) for row in call_stats], 'notifications': [dict(row) for row in notifications], 'seller_follow': [dict(row) for row in seller_follow], 'lost_reasons': [dict(row) for row in lost_reasons]}
            cache_response(cache_key, payload)
            return self.send_json(payload)
        if path == '/api/admin/audit':
            if user['role'] != 'admin':
                return self.send_json({'error': 'No autorizado'}, 403)
            try:
                date_from, date_to = parse_date_range(parse_qs(urlparse(self.path).query))
            except ValueError:
                return self.send_json({'error': 'Revisa el rango de fechas'}, 400)
            filters, params = [], []
            if date_from:
                filters.append('audit_log.created_at >= ?')
                params.append(f'{date_from} 00:00:00')
            if date_to:
                filters.append('audit_log.created_at <= ?')
                params.append(f'{date_to} 23:59:59')
            where = f"WHERE {' AND '.join(filters)}" if filters else ''
            with db() as connection:
                rows = connection.execute(f'SELECT audit_log.*, users.name AS user_name FROM audit_log JOIN users ON users.id = audit_log.user_id {where} ORDER BY audit_log.id DESC LIMIT 200', params).fetchall()
            return self.send_json({'audit': [dict(row) for row in rows]})
        if path == '/api/admin/location-events':
            if user['role'] != 'admin':
                return self.send_json({'error': 'No autorizado'}, 403)
            query = parse_qs(urlparse(self.path).query)
            try:
                after = int(query['after'][0]) if 'after' in query else None
                if after is not None and after < 0:
                    raise ValueError
            except (TypeError, ValueError, IndexError):
                return self.send_json({'error': 'Cursor de notificaciones no válido'}, 400)
            with db() as connection:
                cursor = connection.execute('SELECT COALESCE(MAX(id), 0) FROM audit_log').fetchone()[0]
                rows = [] if after is None else connection.execute('''SELECT audit_log.id, audit_log.created_at,
                    users.name AS user_name FROM audit_log JOIN users ON users.id = audit_log.user_id
                    WHERE audit_log.id > ? AND audit_log.id <= ? AND audit_log.action = 'Detuvo ubicación'
                    ORDER BY audit_log.id''', (after, cursor)).fetchall()
            return self.send_json({'cursor': cursor, 'events': [dict(row) for row in rows]})
        if path == '/api/admin/users':
            if user['role'] != 'admin':
                return self.send_json({'error': 'No autorizado'}, 403)
            with db() as connection:
                rows = connection.execute('SELECT id, username, name, role, active FROM users ORDER BY active DESC, role DESC, name').fetchall()
            return self.send_json({'users': [dict(row) for row in rows]})
        if path == '/api/location/history':
            query_values = parse_qs(urlparse(self.path).query)
            try:
                page = max(1, int(query_values.get('page', ['1'])[0]))
                seller_id = int(query_values['seller_id'][0]) if query_values.get('seller_id', [''])[0] else None
                date_from = query_values.get('from', [''])[0]
                date_to = query_values.get('to', [''])[0]
                for date_value in (date_from, date_to):
                    if date_value:
                        datetime.strptime(date_value, '%Y-%m-%d')
            except (TypeError, ValueError):
                return self.send_json({'error': 'Revisa la página, el vendedor y el rango de fechas'}, 400)
            page_size = 100
            filters = []
            params = []
            if user['role'] != 'admin':
                filters.append('location_history.user_id = ?')
                params.append(user['id'])
            elif seller_id is not None:
                filters.append('location_history.user_id = ?')
                params.append(seller_id)
            if date_from:
                filters.append('location_history.recorded_at >= ?')
                params.append(f'{date_from} 00:00:00')
            if date_to:
                filters.append('location_history.recorded_at <= ?')
                params.append(f'{date_to} 23:59:59')
            where = f"WHERE {' AND '.join(filters)}" if filters else ''
            with db() as connection:
                total = connection.execute(f'SELECT COUNT(*) FROM location_history {where}', params).fetchone()[0]
                rows = connection.execute(f'''SELECT location_history.*, users.name AS user_name
                    FROM location_history JOIN users ON users.id = location_history.user_id
                    {where} ORDER BY location_history.recorded_at DESC, location_history.id DESC
                    LIMIT ? OFFSET ?''', [*params, page_size, (page - 1) * page_size]).fetchall()
            return self.send_json({'records': [dict(row) for row in rows], 'page': page, 'page_size': page_size, 'total': total})
        if path == '/api/location':
            if user['role'] == 'admin':
                with db() as connection:
                    rows = connection.execute('''SELECT users.id, users.name, users.username,
                        COALESCE(seller_locations.latitude, NULL) AS latitude,
                        COALESCE(seller_locations.longitude, NULL) AS longitude,
                        seller_locations.accuracy, seller_locations.sharing,
                        seller_locations.updated_at
                        FROM users LEFT JOIN seller_locations ON seller_locations.user_id = users.id
                        WHERE users.role = 'seller' AND users.active = 1 ORDER BY users.name''').fetchall()
                return self.send_json({'locations': [dict(row) for row in rows]})
            with db() as connection:
                row = connection.execute('SELECT latitude, longitude, accuracy, sharing, updated_at FROM seller_locations WHERE user_id = ?', (user['id'],)).fetchone()
            return self.send_json({'location': dict(row) if row else None})
        if path == '/' or path == '/index.html':
            return self.serve_file('index.html', 'text/html; charset=utf-8')
        # Lista blanca: la base de datos, el código del servidor y los
        # certificados nunca se entregan al navegador.
        name = path.lstrip('/')
        if name not in PUBLIC_FILES:
            return self.send_json({'error': 'No encontrado'}, 404)
        return self.serve_file(name)

    def do_POST(self):
        # POST se usa para iniciar sesión y crear registros nuevos.
        path = urlparse(self.path).path
        if path == '/api/login':
            data = self.read_json()
            username = str(data.get('username', '')).strip()
            attempt_key = f"{self.client_address[0]}|{username.lower()}"
            if login_is_locked(attempt_key):
                return self.send_json({'error': 'Demasiados intentos fallidos. Espera 5 minutos e inténtalo de nuevo'}, 429)
            with db() as connection:
                row = connection.execute('SELECT id, username, name, role, password_hash FROM users WHERE username = ? AND active = 1', (username,)).fetchone()
            if not row or not password_matches(str(data.get('password', '')), row['password_hash']):
                login_register_failure(attempt_key)
                return self.send_json({'error': 'Usuario o contraseña incorrectos'}, 401)
            LOGIN_ATTEMPTS.pop(attempt_key, None)
            user = {'id': row['id'], 'username': row['username'], 'name': row['name'], 'role': row['role']}
            # El token no contiene datos del usuario y expira en ocho horas.
            token = secrets.token_urlsafe(32)
            SESSIONS[token] = {'user': user, 'expires': time.time() + 28800}
            audit(user, 'Inicio de sesión', 'Acceso al sistema')
            return self.send_json({'user': user}, headers={'Set-Cookie': f'grubox_session={token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800'})
        user = self.require_user()
        if not user:
            return
        if path == '/api/logout':
            token = self.headers.get('Cookie', '').replace('grubox_session=', '').split(';')[0]
            if user['role'] == 'seller':
                with db() as connection:
                    connection.execute('UPDATE seller_locations SET sharing = 0 WHERE user_id = ?', (user['id'],))
            SESSIONS.pop(token, None)
            return self.send_json({'ok': True}, headers={'Set-Cookie': 'grubox_session=; Max-Age=0; Path=/; HttpOnly; Secure'})
        if path == '/api/location':
            if user['role'] != 'seller':
                return self.send_json({'error': 'Solo los vendedores pueden compartir ubicación'}, 403)
            data = self.read_json()
            try:
                latitude = float(data.get('latitude'))
                longitude = float(data.get('longitude'))
                accuracy = float(data.get('accuracy')) if data.get('accuracy') is not None else None
            except (TypeError, ValueError):
                return self.send_json({'error': 'La ubicación recibida no es válida'}, 400)
            if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
                return self.send_json({'error': 'Las coordenadas están fuera de rango'}, 400)
            timestamp = local_timestamp()
            with db() as connection:
                connection.execute('INSERT INTO location_history(user_id, latitude, longitude, accuracy, recorded_at) VALUES (?, ?, ?, ?, ?)', (user['id'], latitude, longitude, accuracy, timestamp))
                connection.execute('''INSERT INTO seller_locations(user_id, latitude, longitude, accuracy, sharing, updated_at)
                    VALUES (?, ?, ?, ?, 1, ?)
                    ON CONFLICT(user_id) DO UPDATE SET latitude = excluded.latitude,
                    longitude = excluded.longitude, accuracy = excluded.accuracy,
                    sharing = 1, updated_at = excluded.updated_at''',
                    (user['id'], latitude, longitude, accuracy, timestamp))
            return self.send_json({'ok': True, 'updated_at': timestamp})
        if path == '/api/location/stop':
            if user['role'] != 'seller':
                return self.send_json({'error': 'Solo los vendedores pueden detener su ubicación'}, 403)
            with db() as connection:
                connection.execute('UPDATE seller_locations SET sharing = 0 WHERE user_id = ?', (user['id'],))
            audit(user, 'Detuvo ubicación', 'Dejó de compartir su ubicación')
            return self.send_json({'ok': True})
        if path == '/api/clients':
            data = self.read_json()
            try:
                capture_complete = int(data.get('capture_complete', 1))
                capture_step = int(data.get('capture_step', 3))
                if capture_complete not in {0, 1} or capture_step not in {1, 2, 3} or capture_complete and capture_step != 3:
                    raise ValueError
                capture_complete = bool(capture_complete)
            except (TypeError, ValueError):
                return self.send_json({'error': 'El avance del formulario no es válido'}, 400)
            incomplete_defaults = {'company': 'Oportunidad en captura', 'contact': 'Por definir', 'next_action': 'Continuar captura'}
            if capture_complete and any(
                not str(data.get(key, '')).strip() or str(data.get(key, '')).strip() == incomplete_defaults[key]
                for key in incomplete_defaults
            ):
                return self.send_json({'error': 'Completa empresa, contacto y próxima acción para finalizar'}, 400)
            if not capture_complete:
                has_progress = any(str(data.get(key, '')).strip() for key in (
                    'company', 'contact', 'preferred_contact', 'contact_phone', 'email', 'company_phone', 'company_location',
                    'delivery_address', 'delivery_conditions', 'quote_specifications', 'flute', 'ink_count',
                    'internal_dimensions', 'external_dimensions', 'sample_provided', 'liner_type',
                    'mikelman_treatment', 'pallet', 'estimated_quantity', 'periodicity', 'payment_terms',
                    'max_pallet_height', 'target_price', 'box_type', 'drawing_provided'
                ))
                if not has_progress:
                    return self.send_json({'error': 'Captura al menos un dato antes de guardar el avance'}, 400)
            if data['stage'] not in {'new', 'negotiation', 'quoted', 'won', 'lost'}:
                return self.send_json({'error': 'Selecciona una etapa de negociación válida'}, 400)
            initial_won_value = None
            initial_lost_reason = None
            if data['stage'] in {'won', 'lost'} and not capture_complete:
                return self.send_json({'error': 'Completa el formulario antes de cerrar una oportunidad'}, 400)
            if data['stage'] == 'won':
                try:
                    initial_won_value = int(data.get('won_value'))
                except (TypeError, ValueError):
                    return self.send_json({'error': 'Captura el importe real de la venta para crearla como ganada'}, 400)
                if initial_won_value < 0:
                    return self.send_json({'error': 'El importe real de venta no puede ser negativo'}, 400)
            if data['stage'] == 'lost':
                initial_lost_reason = str(data.get('lost_reason', '')).strip()[:100]
                if not initial_lost_reason:
                    return self.send_json({'error': 'Indica el motivo de pérdida'}, 400)
            preferred_contact = str(data.get('preferred_contact', 'call'))
            if preferred_contact and preferred_contact not in {'call', 'whatsapp', 'email', 'visit', 'facebook', 'linkedin', 'tiktok', 'instagram'}:
                return self.send_json({'error': 'Selecciona un medio de contacto válido'}, 400)
            try:
                sample_provided = int(data['sample_provided']) if data.get('sample_provided') not in (None, '') else None
                drawing_provided = int(data['drawing_provided']) if data.get('drawing_provided') not in (None, '') else None
                if sample_provided not in {None, 0, 1} or drawing_provided not in {None, 0, 1}:
                    raise ValueError
                if capture_complete and (sample_provided is None or drawing_provided is None):
                    raise ValueError
                probability = int(data.get('probability', 0))
                if probability < 0 or probability > 100:
                    raise ValueError
                opportunity_value = int(data.get('value', 0))
                estimated_quantity = int(data.get('estimated_quantity') or 0)
                if opportunity_value < 0 or estimated_quantity < 0:
                    raise ValueError
                ink_count = data.get('ink_count')
                ink_count = int(ink_count) if ink_count not in (None, '') else None
                if ink_count is not None and ink_count < 0:
                    raise ValueError
                requested_delivery_date = data.get('requested_delivery_date') or None
                expected_delivery_date = data.get('expected_delivery_date') or None
                estimated_close_date = data.get('estimated_close_date') or None
                for delivery_date in (requested_delivery_date, expected_delivery_date, estimated_close_date):
                    if delivery_date:
                        datetime.strptime(delivery_date, '%Y-%m-%d')
                mikelman_treatment = str(data.get('mikelman_treatment', '')).strip()
                if mikelman_treatment not in {'', '0', '1'}:
                    raise ValueError
            except (TypeError, ValueError):
                return self.send_json({'error': 'Revisa los montos, volumen, probabilidad, tintas, muestra, plano y fechas'}, 400)
            try:
                pieces_per_kg = data.get('pieces_per_kg')
                pieces_per_kg = float(pieces_per_kg) if pieces_per_kg not in (None, '') else None
                if pieces_per_kg is not None and (not math.isfinite(pieces_per_kg) or pieces_per_kg < 0):
                    raise ValueError
                target_price = data.get('target_price')
                target_price = float(target_price) if target_price not in (None, '') else None
                if target_price is not None and (not math.isfinite(target_price) or target_price < 0):
                    raise ValueError
            except (TypeError, ValueError):
                return self.send_json({'error': 'Precio objetivo y Piezas / Kg deben ser números válidos mayores o iguales a cero'}, 400)
            owner_id = user['id'] if user['role'] != 'admin' else int(data.get('owner_id') or user['id'])
            weighted_forecast = opportunity_value * probability / 100
            with db() as connection:
                cursor = connection.execute('''INSERT INTO clients(company, contact, value, estimated_quantity, next_action, stage,
                    owner_id, call_date, call_time, contact_phone, email, company_phone, box_type, internal_code,
                    sample_provided, preferred_contact, drawing_provided, requested_delivery_date, expected_delivery_date,
                    plant, material_code, purchase_order, pieces_per_kg, unit_of_measure, planned_requirement, supplier,
                    company_location, delivery_address, delivery_conditions, quote_specifications, flute, ink_count,
                    internal_dimensions, external_dimensions, liner_type, mikelman_treatment, pallet, periodicity,
                    payment_terms, max_pallet_height, target_price, opportunity_type, industry, product_measure,
                    probability, weighted_forecast, estimated_close_date, pinned_note, capture_step, capture_complete, lost_reason)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id''',
                    (str(data.get('company', '')).strip()[:80] or 'Oportunidad en captura', str(data.get('contact', '')).strip()[:60] or 'Por definir', opportunity_value, estimated_quantity, str(data.get('next_action', '')).strip()[:120] or 'Continuar captura', data['stage'], owner_id, data.get('call_date') or None, data.get('call_time') or None, str(data.get('contact_phone', '')).strip() or None, str(data.get('email', '')).strip().lower() or None, str(data.get('company_phone', '')).strip() or None, str(data.get('box_type', '')).strip() or None, str(data.get('internal_code', '')).strip() or None, sample_provided, preferred_contact or None, drawing_provided, requested_delivery_date, expected_delivery_date, str(data.get('plant', '')).strip() or None, str(data.get('material_code', '')).strip() or None, str(data.get('purchase_order', '')).strip() or None, pieces_per_kg, str(data.get('unit_of_measure', '')).strip() or None, str(data.get('planned_requirement', '')).strip() or None, str(data.get('supplier', '')).strip() or None, str(data.get('company_location', '')).strip() or None, str(data.get('delivery_address', '')).strip() or None, str(data.get('delivery_conditions', '')).strip() or None, str(data.get('quote_specifications', '')).strip() or None, str(data.get('flute', '')).strip() or None, ink_count, str(data.get('internal_dimensions', '')).strip() or None, str(data.get('external_dimensions', '')).strip() or None, str(data.get('liner_type', '')).strip() or None, mikelman_treatment or None, str(data.get('pallet', '')).strip() or None, str(data.get('periodicity', '')).strip() or None, str(data.get('payment_terms', '')).strip() or None, str(data.get('max_pallet_height', '')).strip() or None, target_price, str(data.get('opportunity_type', '')).strip() or None, str(data.get('industry', '')).strip() or None, str(data.get('product_measure', '')).strip() or None, probability, weighted_forecast, estimated_close_date, str(data.get('pinned_note', '')).strip()[:500] or None, capture_step, int(capture_complete), initial_lost_reason))
                client_id = cursor.fetchone()[0]
                connection.execute('INSERT INTO client_history(client_id, user_id, to_stage, call_date, call_time, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', (client_id, user['id'], data['stage'], data.get('call_date') or None, data.get('call_time') or None, None, local_timestamp()))
                connection.execute('INSERT INTO sales_activities(client_id, user_id, activity_type, created_at) VALUES (?, ?, ?, ?)', (client_id, user['id'], 'new_opportunity', local_timestamp()))
                if data['stage'] == 'won':
                    connection.execute('UPDATE clients SET won_value = ? WHERE id = ?', (initial_won_value, client_id))
                    connection.execute('INSERT INTO sales_activities(client_id, user_id, activity_type, amount, created_at) VALUES (?, ?, ?, ?, ?)', (client_id, user['id'], 'sale_closed', initial_won_value, local_timestamp()))
            audit(user, 'Creó prospecto', data['company'].strip())
            return self.send_json({'id': client_id}, 201)
        if path == '/api/activities':
            data = self.read_json()
            activity_type = str(data.get('activity_type', ''))
            allowed_types = {'prospecting_call', 'prospecting_email', 'effective_contact', 'quote_sent', 'sample_requested'}
            if activity_type not in allowed_types:
                return self.send_json({'error': 'Selecciona un tipo de actividad válido'}, 400)
            try:
                client_id = int(data.get('client_id'))
                amount = int(data.get('amount') or 0)
            except (TypeError, ValueError):
                return self.send_json({'error': 'El prospecto y el monto deben ser válidos'}, 400)
            if amount < 0 or (activity_type == 'quote_sent' and amount <= 0) or (activity_type != 'quote_sent' and amount):
                return self.send_json({'error': 'Captura un monto mayor a cero solo para una cotización'}, 400)
            with db() as connection:
                client = connection.execute('SELECT id, owner_id FROM clients WHERE id = ?', (client_id,)).fetchone()
                if not client or (user['role'] != 'admin' and client['owner_id'] != user['id']):
                    return self.send_json({'error': 'Prospecto no encontrado'}, 404)
                connection.execute('INSERT INTO sales_activities(client_id, user_id, activity_type, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?)', (client_id, user['id'], activity_type, amount, str(data.get('note', '')).strip() or None, local_timestamp()))
            audit(user, 'Registró actividad comercial', f"{activity_type}: prospecto {client_id}")
            return self.send_json({'ok': True}, 201)
        if path == '/api/appointments':
            data = self.read_json()
            try:
                client_id = int(data.get('client_id'))
                appointment_date = datetime.strptime(str(data.get('appointment_date', '')), '%Y-%m-%d').strftime('%Y-%m-%d')
                appointment_time = datetime.strptime(str(data.get('appointment_time', '')), '%H:%M').strftime('%H:%M')
                estimated_sale = int(data.get('estimated_sale') or 0)
            except (TypeError, ValueError):
                return self.send_json({'error': 'Prospecto, fecha, hora y venta estimada deben ser válidos'}, 400)
            appointment_type = str(data.get('appointment_type', '')).strip()
            stage = str(data.get('stage', ''))
            allowed_types = {'Presentación', 'Seguimiento', 'Demostración', 'Cierre'}
            allowed_stages = {'new', 'negotiation', 'quoted', 'won', 'lost'}
            if appointment_type not in allowed_types or stage not in allowed_stages or estimated_sale < 0:
                return self.send_json({'error': 'Revisa el tipo de cita, la etapa y el monto estimado'}, 400)
            with db() as connection:
                client = connection.execute('SELECT id, owner_id FROM clients WHERE id = ?', (client_id,)).fetchone()
                if not client or (user['role'] != 'admin' and client['owner_id'] != user['id']):
                    return self.send_json({'error': 'Prospecto no encontrado'}, 404)
                cursor = connection.execute('''INSERT INTO appointments(client_id, user_id, appointment_date, appointment_time,
                    appointment_type, stage, estimated_sale, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id''',
                    (client_id, user['id'], appointment_date, appointment_time, appointment_type, stage, estimated_sale, str(data.get('note', '')).strip() or None))
                appointment_id = cursor.fetchone()[0]
                connection.execute('''INSERT INTO appointment_history(appointment_id, user_id, event_type, result,
                    appointment_date, appointment_time, previous_stage, current_stage, note, created_at)
                    VALUES (?, ?, 'scheduled', 'pending', ?, ?, ?, ?, ?, ?)''',
                    (appointment_id, user['id'], appointment_date, appointment_time, stage, stage,
                     str(data.get('note', '')).strip() or None, local_timestamp()))
            audit(user, 'Programó cita', f"{appointment_type}: prospecto {client_id} · {appointment_date} {appointment_time}")
            return self.send_json({'id': appointment_id}, 201)
        if path == '/api/admin/users':
            if user['role'] != 'admin':
                return self.send_json({'error': 'No autorizado'}, 403)
            data = self.read_json()
            username = str(data.get('username', '')).strip().lower()
            name = str(data.get('name', '')).strip()
            password = str(data.get('password', ''))
            if not username or not name or len(password) < 8:
                return self.send_json({'error': 'Usuario, nombre y una contraseña de al menos 8 caracteres son obligatorios'}, 400)
            try:
                with db() as connection:
                    connection.execute('INSERT INTO users(username, name, role, password_hash) VALUES (?, ?, ?, ?)', (username, name, 'seller', password_hash(password)))
            except IntegrityError:
                return self.send_json({'error': 'Ese usuario ya existe'}, 409)
            audit(user, 'Creó usuario', f'{name} ({username})')
            return self.send_json({'ok': True}, 201)
        return self.send_json({'error': 'Ruta no encontrada'}, 404)

    def do_PATCH(self):
        # PATCH modifica datos existentes sin reemplazar el registro completo.
        path = urlparse(self.path).path
        user = self.require_user()
        if not user:
            return
        if path == '/api/admin/dashboard/goal':
            if user['role'] != 'admin':
                return self.send_json({'error': 'No autorizado'}, 403)
            data = self.read_json()
            try:
                year = int(data.get('year'))
                goal = float(data.get('annual_goal'))
                if year < 2000 or year > 2100 or not math.isfinite(goal) or goal < 0:
                    raise ValueError
            except (TypeError, ValueError):
                return self.send_json({'error': 'Captura un año y una meta anual válidos'}, 400)
            with db() as connection:
                connection.execute('''INSERT INTO app_settings(key, value) VALUES (?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value''',
                    (f'annual_goal_{year}', str(goal)))
            audit(user, 'Actualizó meta anual', f'{year}: {goal:.2f}')
            return self.send_json({'ok': True, 'year': year, 'annual_goal': goal})
        if path == '/api/account/password':
            data = self.read_json()
            current_password = str(data.get('current_password', ''))
            new_password = str(data.get('new_password', ''))
            if len(new_password) < 8:
                return self.send_json({'error': 'La nueva contraseña debe tener al menos 8 caracteres'}, 400)
            with db() as connection:
                row = connection.execute('SELECT password_hash FROM users WHERE id = ?', (user['id'],)).fetchone()
                if not row or not password_matches(current_password, row['password_hash']):
                    return self.send_json({'error': 'La contraseña actual no es correcta'}, 400)
                connection.execute('UPDATE users SET password_hash = ? WHERE id = ?', (password_hash(new_password), user['id']))
            audit(user, 'Cambió contraseña', 'Actualizó su propia contraseña')
            return self.send_json({'ok': True})
        # Las rutas /reschedule y /edit van ANTES del bloque genérico de clientes.
        if path.startswith('/api/clients/') and path.endswith('/reschedule'):
            client_id = path.split('/')[3]
            data = self.read_json()
            try:
                call_date = datetime.strptime(str(data.get('call_date', '')), '%Y-%m-%d').strftime('%Y-%m-%d')
                raw_time = str(data.get('call_time') or '')
                call_time = datetime.strptime(raw_time, '%H:%M').strftime('%H:%M') if raw_time else None
            except ValueError:
                return self.send_json({'error': 'La fecha u hora no son válidas'}, 400)
            with db() as connection:
                client = connection.execute('SELECT * FROM clients WHERE id = ?', (client_id,)).fetchone()
                if not client or (user['role'] != 'admin' and client['owner_id'] != user['id']):
                    return self.send_json({'error': 'Prospecto no encontrado'}, 404)
                if client['stage'] in ('won', 'lost'):
                    return self.send_json({'error': 'No se reprograma un prospecto cerrado'}, 400)
                connection.execute('UPDATE clients SET call_date = ?, call_time = ? WHERE id = ?', (call_date, call_time, client_id))
                connection.execute('''INSERT INTO client_history(client_id, user_id, from_stage, to_stage, call_date, call_time,
                    note, activity_type, next_action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                    (client_id, user['id'], client['stage'], client['stage'], call_date, call_time, 'Seguimiento reprogramado', 'reschedule', client['next_action'], local_timestamp()))
            audit(user, 'Reprogramó seguimiento', f"{client['company']} -> {call_date} {call_time or ''}".strip())
            return self.send_json({'ok': True})
        if path.startswith('/api/clients/') and path.endswith('/edit'):
            client_id = path.split('/')[3]
            data = self.read_json()
            with db() as connection:
                client = connection.execute('SELECT * FROM clients WHERE id = ?', (client_id,)).fetchone()
                if not client or (user['role'] != 'admin' and client['owner_id'] != user['id']):
                    return self.send_json({'error': 'Prospecto no encontrado'}, 404)
                updates = {}
                try:
                    capture_complete = int(data.get('capture_complete', client['capture_complete']))
                    capture_step = int(data.get('capture_step', client['capture_step']))
                    if capture_complete not in {0, 1} or capture_step not in {1, 2, 3} or capture_complete and capture_step != 3:
                        raise ValueError
                    incomplete_defaults = {'company': 'Oportunidad en captura', 'contact': 'Por definir', 'next_action': 'Continuar captura'}
                    if capture_complete and any(
                        not str(data.get(key, client[key]) or '').strip()
                        or str(data.get(key, client[key]) or '').strip() == incomplete_defaults[key]
                        for key in incomplete_defaults
                    ):
                        raise ValueError
                    if capture_complete and any(
                        (int(data[key]) if data.get(key) not in (None, '') else None) is None
                        if key in data else client[key] is None
                        for key in ('sample_provided', 'drawing_provided')
                    ):
                        raise ValueError
                    updates['capture_step'] = capture_step
                    updates['capture_complete'] = capture_complete
                    if 'stage' in data:
                        if data['stage'] not in {'new', 'negotiation', 'quoted'}:
                            raise ValueError
                        updates['stage'] = data['stage']
                    for key, fallback in (('company', 'Oportunidad en captura'), ('contact', 'Por definir'), ('next_action', 'Continuar captura')):
                        if key in data:
                            text = str(data[key]).strip()
                            updates[key] = text[:120] or (fallback if not capture_complete else '')
                    for key in ('contact_phone', 'company_phone', 'box_type', 'internal_code'):
                        if key in data:
                            updates[key] = str(data[key]).strip()[:120] or None
                    for key in ('plant', 'material_code', 'purchase_order', 'unit_of_measure', 'planned_requirement', 'supplier',
                                'company_location', 'delivery_address', 'delivery_conditions', 'quote_specifications',
                                'flute', 'internal_dimensions', 'external_dimensions', 'liner_type', 'pallet',
                                'periodicity', 'payment_terms', 'max_pallet_height', 'opportunity_type', 'industry',
                                'product_measure'):
                        if key in data:
                            updates[key] = str(data[key]).strip()[:1000] or None
                    if 'pieces_per_kg' in data:
                        pieces_per_kg = float(data['pieces_per_kg']) if data['pieces_per_kg'] not in (None, '') else None
                        if pieces_per_kg is not None and (not math.isfinite(pieces_per_kg) or pieces_per_kg < 0):
                            raise ValueError
                        updates['pieces_per_kg'] = pieces_per_kg
                    if 'pinned_note' in data:
                        updates['pinned_note'] = str(data['pinned_note']).strip()[:500] or None
                    if 'email' in data:
                        updates['email'] = str(data['email']).strip().lower()[:120] or None
                    for key in ('value', 'estimated_quantity'):
                        if key in data:
                            number = int(data[key] or 0)
                            if number < 0:
                                raise ValueError
                            updates[key] = number
                    if 'target_price' in data:
                        target_price = float(data['target_price']) if data['target_price'] not in (None, '') else None
                        if target_price is not None and (not math.isfinite(target_price) or target_price < 0):
                            raise ValueError
                        updates['target_price'] = target_price
                    if 'probability' in data:
                        probability = int(data['probability'])
                        if probability < 0 or probability > 100:
                            raise ValueError
                        updates['probability'] = probability
                    if 'ink_count' in data:
                        ink_count = int(data['ink_count']) if data['ink_count'] not in (None, '') else None
                        if ink_count is not None and ink_count < 0:
                            raise ValueError
                        updates['ink_count'] = ink_count
                    if 'mikelman_treatment' in data:
                        treatment = str(data['mikelman_treatment']).strip()
                        if treatment not in {'', '0', '1'}:
                            raise ValueError
                        updates['mikelman_treatment'] = treatment or None
                    if 'preferred_contact' in data:
                        if data['preferred_contact'] not in {'', 'call', 'whatsapp', 'email', 'visit', 'facebook', 'linkedin', 'tiktok', 'instagram'}:
                            raise ValueError
                        updates['preferred_contact'] = data['preferred_contact'] or None
                    for key in ('sample_provided', 'drawing_provided'):
                        if key in data:
                            flag = int(data[key]) if data[key] not in (None, '') else None
                            if flag not in {None, 0, 1} or capture_complete and flag is None:
                                raise ValueError
                            updates[key] = flag
                    for key in ('requested_delivery_date', 'expected_delivery_date', 'estimated_close_date'):
                        if key in data:
                            value = data[key] or None
                            if value:
                                datetime.strptime(value, '%Y-%m-%d')
                            updates[key] = value
                    for key, date_format in (('call_date', '%Y-%m-%d'), ('call_time', '%H:%M')):
                        if key in data:
                            value = data[key] or None
                            if value:
                                datetime.strptime(value, date_format)
                            updates[key] = value
                    if 'value' in updates or 'probability' in updates:
                        forecast_value = updates.get('value', client['value'])
                        forecast_probability = updates.get('probability', client['probability'])
                        updates['weighted_forecast'] = forecast_value * forecast_probability / 100
                    if user['role'] == 'admin' and data.get('owner_id'):
                        owner = connection.execute("SELECT id FROM users WHERE id = ? AND role = 'seller' AND active = 1", (int(data['owner_id']),)).fetchone()
                        if not owner:
                            raise ValueError
                        updates['owner_id'] = owner['id']
                except (TypeError, ValueError):
                    return self.send_json({'error': 'Revisa los datos del prospecto'}, 400)
                if not updates:
                    return self.send_json({'error': 'No hay cambios para guardar'}, 400)
                # Las columnas salen de una lista fija de arriba, nunca del cliente.
                assignments = ', '.join(f'{column} = ?' for column in updates)
                connection.execute(f'UPDATE clients SET {assignments} WHERE id = ?', [*updates.values(), client_id])
                if updates.get('stage', client['stage']) != client['stage']:
                    connection.execute('''INSERT INTO client_history(client_id, user_id, from_stage, to_stage,
                        next_action, created_at) VALUES (?, ?, ?, ?, ?, ?)''',
                        (client_id, user['id'], client['stage'], updates['stage'],
                         updates.get('next_action', client['next_action']), local_timestamp()))
            audit(user, 'Editó prospecto', f"{client['company']}: {', '.join(updates)}")
            return self.send_json({'ok': True})
        if path.startswith('/api/clients/'):
            client_id = path.rsplit('/', 1)[-1]
            data = self.read_json()
            with db() as connection:
                client = connection.execute('SELECT * FROM clients WHERE id = ?', (client_id,)).fetchone()
                if not client or (user['role'] != 'admin' and client['owner_id'] != user['id']):
                    return self.send_json({'error': 'Prospecto no encontrado'}, 404)
                stage = data.get('stage', client['stage'])
                call_date = data.get('call_date', client['call_date']) or None
                call_time = data.get('call_time', client['call_time']) or None
                note = str(data.get('note', '')).strip() or None
                activity_type = str(data.get('activity_type', '')).strip()
                outcome = str(data.get('outcome', '')).strip()
                next_action = str(data.get('next_action', client['next_action'])).strip()
                allowed_stages = {'new', 'negotiation', 'quoted', 'won', 'lost'}
                allowed_activity_types = {'call', 'whatsapp', 'email', 'visit', 'meeting', 'other'}
                allowed_outcomes = {'contacted', 'no_answer', 'quote_requested', 'quote_sent', 'sample_requested', 'awaiting_customer', 'meeting_scheduled', 'resolved'}
                if stage not in allowed_stages or not next_action:
                    return self.send_json({'error': 'La etapa y la próxima acción deben ser válidas'}, 400)
                is_follow_up = bool(activity_type or outcome or note)
                if is_follow_up and (activity_type not in allowed_activity_types or outcome not in allowed_outcomes):
                    return self.send_json({'error': 'Selecciona un tipo y resultado de seguimiento válidos'}, 400)
                lost_reason = client['lost_reason']
                if stage == 'lost' and stage != client['stage']:
                    lost_reason = str(data.get('lost_reason', '')).strip()[:100]
                    if not lost_reason:
                        return self.send_json({'error': 'Indica el motivo de la pérdida'}, 400)
                    note = note or f'Motivo de pérdida: {lost_reason}'
                elif stage != 'lost':
                    lost_reason = None
                won_value = client['won_value']
                if stage == 'won' and stage != client['stage']:
                    try:
                        won_value = int(data.get('won_value'))
                    except (TypeError, ValueError):
                        return self.send_json({'error': 'Captura el importe real de la venta para cerrar la oportunidad'}, 400)
                    if won_value < 0:
                        return self.send_json({'error': 'El importe real de venta no puede ser negativo'}, 400)
                connection.execute('UPDATE clients SET stage = ?, call_date = ?, call_time = ?, next_action = ?, won_value = ?, lost_reason = ? WHERE id = ?', (stage, call_date, call_time, next_action, won_value, lost_reason, client_id))
                if stage != client['stage'] or call_date != client['call_date'] or call_time != client['call_time'] or next_action != client['next_action'] or is_follow_up:
                    connection.execute('''INSERT INTO client_history(client_id, user_id, from_stage, to_stage, call_date, call_time,
                        note, activity_type, outcome, next_action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                        (client_id, user['id'], client['stage'], stage, call_date, call_time, note, activity_type or None, outcome or None, next_action, local_timestamp()))
                if stage == 'won' and stage != client['stage']:
                    connection.execute('INSERT INTO sales_activities(client_id, user_id, activity_type, amount, created_at) VALUES (?, ?, ?, ?, ?)', (client_id, user['id'], 'sale_closed', won_value, local_timestamp()))
                if is_follow_up:
                    connection.execute('INSERT INTO sales_activities(client_id, user_id, activity_type, note, created_at) VALUES (?, ?, ?, ?, ?)', (client_id, user['id'], 'follow_up', note, local_timestamp()))
            audit(user, 'Actualizó seguimiento', f"{client['company']} -> {stage}; llamada: {call_date or 'sin fecha'} {call_time or ''}".strip())
            return self.send_json({'ok': True})
        if path.startswith('/api/appointments/'):
            appointment_id = path.rsplit('/', 1)[-1]
            data = self.read_json()
            result = str(data.get('result', ''))
            result_note = str(data.get('result_note', '')).strip()
            next_action = str(data.get('next_action', '')).strip()
            stage = str(data.get('stage', ''))
            follow_up_date = data.get('follow_up_date') or None
            follow_up_time = data.get('follow_up_time') or None
            allowed_results = {'completed', 'rescheduled', 'canceled'}
            allowed_stages = {'new', 'negotiation', 'quoted', 'won', 'lost'}
            if result not in allowed_results or stage not in allowed_stages:
                return self.send_json({'error': 'Selecciona un resultado y una etapa comercial válidos'}, 400)
            if result == 'completed' and not result_note:
                return self.send_json({'error': 'Describe el resultado de la cita antes de guardarla'}, 400)
            if result == 'rescheduled' and not follow_up_date:
                return self.send_json({'error': 'Indica la fecha de la cita reprogramada'}, 400)
            try:
                if follow_up_date:
                    follow_up_date = datetime.strptime(str(follow_up_date), '%Y-%m-%d').strftime('%Y-%m-%d')
                if follow_up_time:
                    follow_up_time = datetime.strptime(str(follow_up_time), '%H:%M').strftime('%H:%M')
            except ValueError:
                return self.send_json({'error': 'La fecha u hora del próximo contacto no son válidas'}, 400)
            with db() as connection:
                query = '''SELECT appointments.id, appointments.client_id, appointments.user_id,
                    appointments.appointment_date, appointments.appointment_time,
                    clients.owner_id, clients.company, clients.stage AS client_stage, clients.won_value, clients.lost_reason
                    FROM appointments JOIN clients ON clients.id = appointments.client_id WHERE appointments.id = ?'''
                appointment = connection.execute(query, (appointment_id,)).fetchone()
                if not appointment or (user['role'] != 'admin' and appointment['owner_id'] != user['id']):
                    return self.send_json({'error': 'Cita no encontrada'}, 404)
                won_value = appointment['won_value']
                lost_reason = None
                if stage == 'won' and stage != appointment['client_stage']:
                    try:
                        won_value = int(data.get('won_value'))
                    except (TypeError, ValueError):
                        return self.send_json({'error': 'Captura el importe real de venta para cerrar la oportunidad'}, 400)
                    if won_value < 0:
                        return self.send_json({'error': 'El importe vendido no puede ser negativo'}, 400)
                if stage == 'lost' and stage != appointment['client_stage']:
                    lost_reason = str(data.get('lost_reason', '')).strip()[:100]
                    if not lost_reason:
                        return self.send_json({'error': 'Indica el motivo de pérdida de la oportunidad'}, 400)
                elif stage == 'lost':
                    lost_reason = str(data.get('lost_reason', appointment['lost_reason'] or '')).strip()[:100]
                    if not lost_reason:
                        return self.send_json({'error': 'Indica el motivo de pérdida de la oportunidad'}, 400)
                previous_stage = appointment['client_stage']
                appointment_date = follow_up_date if result == 'rescheduled' else appointment['appointment_date']
                appointment_time = (follow_up_time or appointment['appointment_time']) if result == 'rescheduled' else appointment['appointment_time']
                connection.execute('''UPDATE appointments SET result = ?, result_note = ?, next_action = ?,
                    follow_up_date = ?, follow_up_time = ?, result_stage = ?, appointment_date = ?, appointment_time = ? WHERE id = ?''',
                    (result, result_note or None, next_action or None, follow_up_date, follow_up_time, stage, appointment_date, appointment_time, appointment_id))
                connection.execute('''UPDATE clients SET stage = ?, won_value = ?, lost_reason = ?,
                    call_date = COALESCE(?, call_date), call_time = COALESCE(?, call_time),
                    next_action = CASE WHEN ? != '' THEN ? ELSE next_action END WHERE id = ?''',
                    (stage, won_value, lost_reason if stage == 'lost' else None, follow_up_date, follow_up_time,
                     next_action, next_action, appointment['client_id']))
                connection.execute('''INSERT INTO appointment_history(appointment_id, user_id, event_type, result,
                    appointment_date, appointment_time, previous_stage, current_stage, note, next_action,
                    follow_up_date, follow_up_time, created_at)
                    VALUES (?, ?, 'result', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                    (appointment_id, user['id'], result, appointment['appointment_date'], appointment['appointment_time'],
                     previous_stage, stage, result_note or None, next_action or None, follow_up_date, follow_up_time, local_timestamp()))
                connection.execute('''INSERT INTO client_history(client_id, user_id, from_stage, to_stage,
                    call_date, call_time, note, activity_type, outcome, next_action, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'meeting', ?, ?, ?)''',
                    (appointment['client_id'], user['id'], previous_stage, stage, follow_up_date, follow_up_time,
                     result_note or None, result, next_action or None, local_timestamp()))
                if result_note:
                    connection.execute('''INSERT INTO sales_activities(client_id, user_id, activity_type, note, created_at)
                        VALUES (?, ?, 'follow_up', ?, ?)''', (appointment['client_id'], user['id'], result_note, local_timestamp()))
                if stage == 'won' and stage != previous_stage:
                    connection.execute('INSERT INTO sales_activities(client_id, user_id, activity_type, amount, created_at) VALUES (?, ?, ?, ?, ?)', (appointment['client_id'], user['id'], 'sale_closed', won_value, local_timestamp()))
            audit(user, 'Registró resultado de cita', f"{appointment['company']}: {result}; {previous_stage} -> {stage}")
            return self.send_json({'ok': True})
        if path.startswith('/api/admin/users/'):
            if user['role'] != 'admin':
                return self.send_json({'error': 'No autorizado'}, 403)
            user_id = path.rsplit('/', 1)[-1]
            new_password = str(self.read_json().get('new_password', ''))
            if len(new_password) < 8:
                return self.send_json({'error': 'La nueva contraseña debe tener al menos 8 caracteres'}, 400)
            with db() as connection:
                target = connection.execute('SELECT name, username FROM users WHERE id = ?', (user_id,)).fetchone()
                if not target:
                    return self.send_json({'error': 'Usuario no encontrado'}, 404)
                connection.execute('UPDATE users SET password_hash = ? WHERE id = ?', (password_hash(new_password), user_id))
            audit(user, 'Restableció contraseña', f"Usuario: {target['name']} ({target['username']})")
            return self.send_json({'ok': True})
        return self.send_json({'error': 'Ruta no encontrada'}, 404)

    def do_DELETE(self):
        # Los usuarios se desactivan; los prospectos sí pueden borrarse con permiso.
        path = urlparse(self.path).path
        user = self.require_user()
        if not user:
            return
        if path.startswith('/api/clients/'):
            if user['role'] != 'admin':
                return self.send_json({'error': 'Solo el administrador puede eliminar prospectos'}, 403)
            client_id = path.rsplit('/', 1)[-1]
            with db() as connection:
                client = connection.execute('SELECT company, owner_id FROM clients WHERE id = ?', (client_id,)).fetchone()
                if not client or (user['role'] != 'admin' and client['owner_id'] != user['id']):
                    return self.send_json({'error': 'Prospecto no encontrado'}, 404)
                connection.execute('DELETE FROM clients WHERE id = ?', (client_id,))
            audit(user, 'Eliminó prospecto', client['company'])
            return self.send_json({'ok': True})
        if path.startswith('/api/admin/users/'):
            if user['role'] != 'admin':
                return self.send_json({'error': 'No autorizado'}, 403)
            user_id = path.rsplit('/', 1)[-1]
            with db() as connection:
                target = connection.execute('SELECT id, name, username, role, active FROM users WHERE id = ?', (user_id,)).fetchone()
                if not target:
                    return self.send_json({'error': 'Usuario no encontrado'}, 404)
                if target['id'] == user['id']:
                    return self.send_json({'error': 'No puedes desactivar tu propio acceso'}, 400)
                if target['role'] != 'seller':
                    return self.send_json({'error': 'Solo se pueden desactivar vendedores'}, 400)
                connection.execute('UPDATE users SET active = 0 WHERE id = ?', (user_id,))
            for token, session in list(SESSIONS.items()):
                if session['user']['id'] == target['id']:
                    SESSIONS.pop(token, None)
            audit(user, 'Desactivó vendedor', f"{target['name']} ({target['username']})")
            return self.send_json({'ok': True})
        return self.send_json({'error': 'Ruta no encontrada'}, 404)

    def serve_file(self, filename, content_type=None):
        """Sirve archivos solo dentro del proyecto y evita escapar de la carpeta."""
        safe_path = (BASE_DIR / filename).resolve()
        if BASE_DIR.resolve() not in safe_path.parents and safe_path != BASE_DIR.resolve():
            return self.send_json({'error': 'No encontrado'}, 404)
        try:
            body = safe_path.read_bytes()
        except FileNotFoundError:
            return self.send_json({'error': 'No encontrado'}, 404)
        content_type = content_type or mimetypes.guess_type(safe_path.name)[0] or 'application/octet-stream'
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    initialize_database()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    if IS_PRODUCTION:
        print(f'Grubox CRM escuchando en {HOST}:{PORT}; HTTPS lo proporciona la plataforma')
    else:
        addresses = sorted({address for address in socket.gethostbyname_ex(socket.gethostname())[2] if not address.startswith('127.')})
        cert_path, key_path = create_local_certificate(addresses)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(certfile=cert_path, keyfile=key_path)
        print(f'Grubox CRM local: https://localhost:{PORT}')
        for address in addresses:
            print(f'Grubox CRM en la red: https://{address}:{PORT}')
        server.socket = tls.wrap_socket(server.socket, server_side=True)
    server.serve_forever()