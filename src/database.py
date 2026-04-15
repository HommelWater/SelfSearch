import sqlite3
from datetime import datetime
from contextlib import contextmanager
import pyotp

def get_db_connection():
    conn = sqlite3.connect('data.db')
    conn.row_factory = sqlite3.Row 
    return conn

@contextmanager
def db_cursor():
    """Context manager for database connections."""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        yield cursor
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

def setup_db():
    with db_cursor() as c:
        c.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                parent_id INTEGER REFERENCES users(id),
                username TEXT UNIQUE NOT NULL,
                creation_datetime INTEGER,
                secret TEXT,
                invite_secret TEXT,
                invite_counter INTEGER
            )
        ''')

        c.execute('''
            CREATE TABLE IF NOT EXISTS sessions (
                key TEXT PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                creation_datetime INTEGER,
                expires_at_datetime INTEGER
            )
        ''')

        c.execute('''
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hash TEXT UNIQUE NOT NULL,
                filename TEXT NOT NULL,
                creation_datetime INTEGER,
                size INTEGER,
                is_public INTEGER
            )
        ''')
    #add_test_users()

def add_test_users():
    with db_cursor() as c:
        c.executemany('''
            INSERT INTO users (parent_id, username, creation_datetime, secret, invite_secret, invite_counter)
            VALUES (?, ?, 0, '', '', 0)
        ''', [
            (2, 'a'),
            (2, 'b'),
            (2, 'c'),
            (2, 'd'),
            (2, 'e'),
            (2, 'f'),
            (2, 'g'),
            (2, 'h'),
        ])

def add_file(hash, filename, size, is_public):
    with db_cursor() as c:
        creation_datetime = int(datetime.now().timestamp())
        c.execute('''
            INSERT INTO files (hash, filename, creation_datetime, size, is_public)
            VALUES (?, ?, ?, ?, ?)
        ''', (hash, filename, creation_datetime, size, is_public))
        idx = c.lastrowid
    return idx

def get_file(id):
    with db_cursor() as c:
        c.execute('SELECT * FROM files WHERE id = ?', (id,))
        file = c.fetchone()
    return dict(file) if file else None

def get_file_by_hash(hash):
    with db_cursor() as c:
        c.execute('SELECT * FROM files WHERE hash = ?', (hash,))
        file = c.fetchone()
    return dict(file) if file else None

def get_files(public_only=True):
    with db_cursor() as c:
        if public_only:
            c.execute('SELECT * FROM files WHERE is_public = ?', (1,))
        else:
            c.execute('SELECT * FROM files')
        files = c.fetchall()
    return [dict(f) for f in files] if files else []

def get_session(key):
    with db_cursor() as c:
        c.execute('SELECT * FROM sessions WHERE key = ?', (key,))
        session = c.fetchone()
        if (session and session["expires_at_datetime"] <= int(datetime.now().timestamp())):
            c.execute('DELETE FROM sessions WHERE key = ?', (key,))
            session = None
    return dict(session) if session else None

def add_session(key, user_id, expires_in=86_400):
    with db_cursor() as c:
        creation_datetime = int(datetime.now().timestamp())
        c.execute('''
            INSERT INTO sessions (key, user_id, creation_datetime, expires_at_datetime)
            VALUES (?, ?, ?, ?)
        ''', (key, user_id, creation_datetime, creation_datetime + expires_in))
        idx = c.lastrowid
    return idx

def add_user(username, secret, parent_id=None):
    with db_cursor() as c:
        creation_datetime = int(datetime.now().timestamp())
        invite_secret = pyotp.random_base32()
        c.execute('''
            INSERT INTO users (parent_id, username, creation_datetime, secret, invite_secret, invite_counter)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (parent_id, username, creation_datetime, secret, invite_secret, 0))

def get_user(identifier):
    with db_cursor() as c:
        if isinstance(identifier, int) or (isinstance(identifier, str) and identifier.isdigit()):
            c.execute('SELECT * FROM users WHERE id = ?', (int(identifier),))
        else:
            c.execute('SELECT * FROM users WHERE username = ?', (identifier,))

        user = c.fetchone()
        return dict(user) if user else None

def get_users():
    with db_cursor() as c:
        c.execute('SELECT username, id, parent_id, creation_datetime FROM users')
        users = c.fetchall()
        return [dict(user) for user in users] if users else []

def delete_user(id, delete_children=False):
    ids = [id] if not delete_children else gather_user_and_children(id)
    with db_cursor() as c:
        if not delete_children: 
            c.execute('UPDATE users SET parent_id = NULL WHERE parent_id = ?', (id,))
        
        query = f'DELETE FROM sessions WHERE user_id IN ({",".join("?"*len(ids))})'
        c.execute(query, ids) 
        
        query = f'DELETE FROM users WHERE id IN ({",".join("?"*len(ids))})'
        c.execute(query, ids)
        rcount = c.rowcount
    return rcount

def gather_user_and_children(id):
    user_ids = [id]
    last_children = [id]
    with db_cursor() as c:
        while len(last_children) > 0:
            placeholders = ', '.join('?' * len(last_children))
            c.execute(f'SELECT id FROM users WHERE parent_id IN ({placeholders})', tuple(last_children))
            rows = c.fetchall()
            last_children = [row[0] for row in rows]
            user_ids.extend(last_children)
    return user_ids

def delete_user_and_children(id):
    user_ids = gather_user_and_children(id)
    with db_cursor() as c:
        placeholders = ', '.join('?' * len(user_ids))
        c.execute(f'DELETE FROM sessions WHERE user_id IN {placeholders}', user_ids)
        c.execute(f'DELETE FROM users WHERE id IN {placeholders}', user_ids)
        rcount = c.rowcount
    return rcount

def increment_invite_counter(identifier):
    with db_cursor() as c:
        if isinstance(identifier, int) or (isinstance(identifier, str) and identifier.isdigit()):
            field, value = 'id', int(identifier)
        else:
            field, value = 'username', identifier
        c.execute(f'''
            UPDATE users 
            SET invite_counter = COALESCE(invite_counter, 0) + 1 
            WHERE {field} = ?
        ''', (value,))