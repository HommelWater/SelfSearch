from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse

from routers.auth_router import router as auth_router
from routers.auth_router import CONTYPE, PEERS, ClientRequest, get_user_and_session, user_is_invalid, get_invite_code
from routers.user_router import router as user_router
from routers.search_router import router as search_router
from routers.mcp_router import router as mcp_router

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"{CONTYPE}{p}" for p in PEERS],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"]
)

app.include_router(auth_router, prefix="/auth")
app.include_router(user_router, prefix="/users")
app.include_router(search_router, prefix="/search")
app.include_router(mcp_router, prefix="/mcp")
app.mount("/interface/", StaticFiles(directory="./interface/"), name="interface")

@app.post("/me")
async def server_data_example(data: ClientRequest):
    user, session = get_user_and_session(data.session)
    msg = user_is_invalid(user)
    if msg: return msg
    invite_code = get_invite_code(user)
    if not invite_code:
        invite_code = {"type":"failure", "data":{"notification":"Error getting invite code."}}
    return {"username":user["username"], "invite_code": invite_code}

@app.get("/{full_path:path}")
async def spa(full_path: str):
    if full_path == "auth":
        return FileResponse("interface/auth/index.html")
    if full_path == "users":
        return FileResponse("interface/users/index.html")
    if full_path == "search":
        return FileResponse("interface/search/index.html")
    if full_path == "settings":
        return FileResponse("interface/settings/index.html")
    return RedirectResponse("/search")