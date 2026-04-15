from routers.auth_router import user_is_invalid, get_user_and_session
from fastapi import WebSocket, WebSocketDisconnect, APIRouter
import asyncio

router = APIRouter()

functions = {}  # type : function
connections = {}  # SESSION_KEY : WebSocketConnection
state_lock = asyncio.Lock()

# Use this function as decorator to make it persistently callable by the client.
def persistent(f):
    name = f.__name__
    if name in functions:
        print(f"Functions with name {name} are defined multiple times as persistent!", flush=True)
        return
    functions[name] = f
    return f

# Simple send function that sends data to a given session, meant to call the 'function' function on the client side.
async def send(session, function, data):
    async with state_lock:
        ws = connections.get(session["key"], False)
        if not ws: return
        data["function"] = function
        await ws.send_json(data)

# Simple broadcast function that sends data to a all sessions, meant to call the 'function' function on the client side.
async def broadcast(function, data):
    async with state_lock:
        for ws in connections.values():
            data["function"] = function
            await ws.send_json(data)

# Initiates a websocket connection, and automatically calls functions decorated with '@persistent' with data from the client.
@router.websocket("/ws")
async def endpoint(websocket: WebSocket):
    await websocket.accept()    
    session_key = False
    while not session_key:
        data = await websocket.receive_json()
        session_key = data.get("session", False)
    async with state_lock: connections[session_key] = websocket

    try:
        while True:
            data = await websocket.receive_json()
            print(data, flush=True)
            function = data.get("function", False)
            if not function: return

            user, session = get_user_and_session(session_key)
            msg = user_is_invalid(user)
            if msg: 
                print(msg, flush=True)
                async with state_lock: del connections[session_key]
                return
            
            f = functions.get(function, False)
            if not f:
                print(f"Could not find function {function}", flush=True)
                continue
            del data["function"]
            await f(user, session, **data)
    except WebSocketDisconnect:
        async with state_lock: del connections[session_key]
    except Exception as e:
        print(f"WebSocket error: {e}")

# Example usage of @persistent. The function gets called with the user dict, session dict and other data sent by the client. Ensure the client function calls match the server side.
@persistent
async def message(user, session, message):
    await broadcast("message", {"username":user["username"], "message":message})
    await send(session, "toast", {"status":"success", "notification":"Message was received."})
