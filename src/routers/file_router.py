from fastapi import APIRouter, UploadFile, File, Form
from fastapi.responses import FileResponse
import database as db
from pathlib import Path
import hashlib
import os

from routers.auth_router import get_user_and_session, user_is_invalid, ClientRequest

# TODO: More access flexibility (i.e. user_private, server_private, peer_private, public, public_discoverable)

PUB_UPLOAD_DIR = Path("./interface/files")
PRI_UPLOAD_DIR = Path("./files")

PUB_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
PRI_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
CHUNK_SIZE = 1024 * 1024 * 4

router = APIRouter()

# Upload endpoint, pass a form containing the session key (as 'session'), is_public (if the file should be publicly accesible or not), and the file to be uploaded.
@router.post("/upload")
async def upload_stream(session: str = Form(...), is_public: bool = Form(...), file: UploadFile = File(...)):
    UPLOAD_DIR = PUB_UPLOAD_DIR if is_public else PRI_UPLOAD_DIR
    user, session = get_user_and_session(session)
    msg = user_is_invalid(user)
    if msg:
        return msg

    temp_filename = file.filename + "_upload"
    file_path = UPLOAD_DIR / temp_filename

    hash = b""
    with open(file_path, "wb") as buffer:
        while chunk := await file.read(CHUNK_SIZE):
            chunk_hash = hashlib.sha256(chunk).digest()
            hash = hashlib.sha256(hash + chunk_hash).digest()
            buffer.write(chunk)

    file_metadata = db.get_file_by_hash(hash.hex())
    if file_metadata:
        os.remove(file_path)
        return {"type": "file", "data": {"file": file_metadata}}

    os.rename(file_path, UPLOAD_DIR / hash.hex())
    id = db.add_file(hash.hex(), file.filename, file.size, is_public)
    file_metadata = db.get_file(id)
    return {"type": "file", "data": {"file": file_metadata}}


# Endpoint for downloading private files, requires a valid session token to access private files. Does not work for links since its a post request.
@router.post("/download/{id}")
async def download_stream(data: ClientRequest, id: int):
    user, _ = get_user_and_session(data.session)
    inv = user_is_invalid(user)

    file_metadata = db.get_file(id)
    if not file_metadata:
        return {
            "type": "failure",
            "data": {"notification": "Could not find file metadata."},
        }

    is_public = file_metadata["is_public"]
    if not is_public and inv:
        return {
            "type": "failure",
            "data": {
                "notification": "This is a private file, please log in to download it."
            },
        }

    UPLOAD_DIR = PUB_UPLOAD_DIR if is_public else PRI_UPLOAD_DIR
    file_path = UPLOAD_DIR / file_metadata["hash"]
    if not file_path.exists():
        return {"type": "failure", "data": {"notification": "Could not find file."}}

    return FileResponse(
        path=file_path,
        filename=file_metadata["filename"],
        media_type="application/octet-stream",
    )


# URL endpoint for public files that do not require authentication.
@router.get("/download/{id}")
async def download_link(id: int):
    file_metadata = db.get_file(id)
    if not file_metadata:
        return {
            "type": "failure",
            "data": {"notification": "Could not find file metadata."},
        }

    is_public = file_metadata["is_public"]
    if not is_public:
        return {
            "type": "failure",
            "data": {
                "notification": "This is a private file, please log in to download it."
            },
        }
    file_path = PUB_UPLOAD_DIR / file_metadata["hash"]
    if not file_path.exists():
        return {"type": "failure", "data": {"notification": "Could not find file."}}

    return FileResponse(
        path=file_path,
        filename=file_metadata["filename"],
        media_type="application/octet-stream",
    )


# Access all files their metadata to determine what can be accessed.
@router.post("/")
async def get_files_metadata(data: ClientRequest):
    user, _ = get_user_and_session(data.session)
    msg = user_is_invalid(user)
    files_metadata = db.get_files(bool(msg))
    if not files_metadata:
        return {
            "type": "failure",
            "data": {"notification": "Could not find metadata for files."},
        }
    return {"type": "files", "data": {"files": files_metadata}}

