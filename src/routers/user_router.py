from fastapi import APIRouter
from routers.auth_router import ClientRequest, get_user_and_session, user_is_invalid
from pydantic import BaseModel
import database as db

router = APIRouter()

class DeleteUserRequest(BaseModel):
    session:str
    user_id:int
    recursive:bool

# Adding users is done in src/routers/auth_router.py.

# Returns all users, their id, parent_id and creation_datetime of the server.
@router.post("/")
async def get_users(data:ClientRequest):
    user, session = get_user_and_session(data.session)
    msg = user_is_invalid(user)
    if msg: return msg
    return {"type":"users", "data":{"users":db.get_users()}}

# Deletes a user, optionally recursively all its children too.
@router.post("/delete")
async def get_users(data:DeleteUserRequest):
    user, session = get_user_and_session(data.session)
    msg = user_is_invalid(user, allow_foreign=False, admin_only=True)
    if msg: return msg
    rows_changed = db.delete_user(data.user_id, data.recursive)
    if not rows_changed:
        return {"type":"failure", "data":{"notification":"Failed to delete user(s)."}}
    return {"type":"success", "data":{"notification":f"Deleted user(s) successfully, {rows_changed} rows changed."}}