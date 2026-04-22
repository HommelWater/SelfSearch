from fastapi import APIRouter
import pyotp
import uuid
import database as db
import re, os
from pydantic import BaseModel
import requests
from datetime import datetime

CONTYPE = os.getenv("CONTYPE", "http://")  # Switch to "http://" for local testing.
HOSTNAME = os.getenv("HOSTNAME", "127.0.0.1:80")
  # Hostname of this instance.
PEERS = [
    HOSTNAME
]  # Examples for testing, switch these out with domain names in production.


class AuthRequest(BaseModel):
    code: str
    username: str


class ClientRequest(BaseModel):
    session: str


router = APIRouter()
username_pattern = r"^[a-zA-Z0-9]+$"
peer_cache = {
    p: {} for p in PEERS
}  # This cache holds peer sessions that get validated, they get removed after they expire or when the server restarts.

db.setup_db()


@router.post("/")
async def auth(data: AuthRequest):
    # Filter out usernames that do not fit the requirements.
    if not re.match(username_pattern, data.username):
        return {"type": "failure", "data": {"notification": "Invalid username."}}

    # Login codes are always 6 characters, use this to determine if the user is logging in or signing up.
    # Client JS code determines where the user is logging in or signing up.
    # We can assume the login attempt is directed at this server. (security risk?)
    islogin = len(data.code) == 6
    if islogin:
        user = db.get_user(data.username)
        if user is None or not pyotp.TOTP(user["secret"]).verify(data.code):
            return {
                "type": "failure",
                "data": {"notification": "Could not create new session."},
            }
        session_token = str(uuid.uuid4())
        idx = db.add_session(session_token, user["id"])
        if idx is None:
            return {
                "type": "failure",
                "data": {"notification": "Could not create new session."},
            }
        return {"type": "login", "data": {"session_key": f"{session_token}@{HOSTNAME}"}}
    else:
        t = data.code.split("_", 1)
        invitee_username = t[0]
        data.code = t[1] if len(t) > 1 else ""

        # Special case for the admin, every server has an admin account.
        if data.username == "admin":
            user = db.get_user("admin")
            if user:
                return {
                    "type": "failure",
                    "data": {"notification": "Cannot login as admin."},
                }
            secret = pyotp.random_base32()
            db.add_user(data.username, secret, 0)
            return {"type": "signup", "data": {"secret": secret}}
        invitee = db.get_user(invitee_username)
        if not invitee:
            return {
                "type": "failure",
                "data": {"notification": "Invalid invitee username."},
            }
        secret = invitee["invite_secret"]
        at = invitee["invite_counter"]
        i_htop_code = pyotp.HOTP(secret).at(at)
        if i_htop_code == data.code:
            secret = pyotp.random_base32()
            db.add_user(data.username, secret, invitee["id"])
            db.increment_invite_counter(invitee["id"])
            return {"type": "signup", "data": {"secret": secret}}
        return {
            "type": "failure",
            "data": {"notification": "Invalid or expired invite code."},
        }


# Get user locally or from their foreign (friendly) peer server.
def get_user_and_session(session_key) -> tuple:
    t = session_key.split("@", 1)
    if len(t) != 2:
        return (None, None)
    session_token = t[0]
    host = t[1]
    if host == HOSTNAME:
        session = db.get_session(session_token)
        if not session:
            return (None, None)
        user = db.get_user(session["user_id"])
        return (user, session)
    if host in PEERS:
        (user, session) = peer_cache[host].get(session_token, (None, None))
        if user:
            if session["expires_at_datetime"] <= int(datetime.now().timestamp()):
                del peer_cache[host][session_token]
            else:
                return (user, session)
        res = requests.post(
            f"{CONTYPE}{host}/auth/verify_session", json={"session": session_key}
        )
        jres = res.json()
        if not jres or jres.get("type", "") != "user_session":
            return (None, None)
        user = jres["data"]["user"]
        session = jres["data"]["session"]
        user["host"] = host
        peer_cache[host][session_token] = (user, session)
        return (user, session)
    print(f"Attempt to join server from non-peer host: {host}", flush=True)
    return (None, None)


# Returns an error message based on user permissions, expand this however you like.
def user_is_invalid(user, allow_foreign=True, admin_only=False):
    if not user:
        return {
            "type": "failure",
            "data": {
                "notification": "Could not find user for your session token.",
                "href": "/auth",
            },
        }
    if not allow_foreign and user.get("host", HOSTNAME) != HOSTNAME:
        return {
            "type": "failure",
            "data": {"notification": "Invalid action for foreign user."},
        }
    if admin_only and not user["username"] == "admin":
        return {
            "type": "failure",
            "data": {"notification": "You do not have permission to do this."},
        }
    return False


# API endpoint for other friendly peer servers to authenticate user' session tokens and get the user information.
# Only username in this case is passed, along with any aditional fields your application might add.
# It is necessary to remove any server-client private information here that peer servers shouldn't see!
# Adding fields for permissions etc. in the database will pass these fields along to any peer servers.
@router.post("/verify_session")
async def verify_session(data: ClientRequest):
    user, session = get_user_and_session(data.session)
    if not user:
        return {
            "type": "failure",
            "data": {
                "notification": "Error getting user and session.",
                "href": "/auth",
            },
        }
    del user["secret"]
    del user["invite_secret"]
    del user["invite_counter"]
    del user["id"]
    del user["parent_id"]
    return {"type": "user_session", "data": {"user": user, "session": session}}


# Get an invite code from a user, if no user id field is present, return None (likely in case of foreign users)!
# Only one code is valid at a time.
# The invite code gets refreshed and the old one invalidated on use and when new codes get generated using this function.
def get_invite_code(invitee_user):
    if invitee_user.get("id", ""):
        code = pyotp.HOTP(invitee_user["invite_secret"]).at(
            invitee_user["invite_counter"] + 1
        )
        return f"{invitee_user['username']}_{code}"
    return None
