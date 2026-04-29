from fastapi import APIRouter, Request, HTTPException
import json
import logging
import base64

from routers.auth_router import user_is_invalid, get_user_and_session
from routers.search_router import search, recently_indexed, index_webpage

router = APIRouter()

TOOLS = [
    {
        "name": "PersonalKeywordSearch",
        "description": "Personal keyword based search engine, with user-indexed webpages.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "page": {"type": "integer", "description": "Page number (0-indexed)", "default": 0},
                "page_size": {"type": "integer", "description": "Results per page", "default": 5}
            },
            "required": ["query"]
        }
    }
]

def extract_bearer_token(request: Request) -> str:
    """Extract Bearer token from Authorization header."""
    auth_header = request.headers.get("Authorization")
    if not auth_header:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    
    parts = auth_header.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Invalid Authorization header format. Expected 'Bearer <token>'")
    
    return parts[1]

def jsonrpc_error(req_id, code: int, message: str):
    """Create a JSON‑RPC 2.0 error response."""
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}

@router.post("")
async def mcp_endpoint(request: Request):
    """MCP JSON‑RPC endpoint with Bearer token authentication."""
    # Parse JSON body
    try:
        body = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    req_id = body.get("id")
    method = body.get("method")
    params = body.get("params", {})

    # Public methods (no authentication required)
    if method == "initialize":
        result = {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "Search Index Server", "version": "1.0.0"}
        }
        return {"jsonrpc": "2.0", "id": req_id, "result": result}

    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}

    # Authenticated methods
    if method == "tools/call":
        # 1. Extract session token from header
        try:
            session_token = extract_bearer_token(request)
        except HTTPException as e:
            return jsonrpc_error(req_id, -32000, f"Authentication failed: {e.detail}")

        # 2. Validate token using your existing auth functions
        user, session = get_user_and_session(session_token)
        msg = user_is_invalid(user, True, False)  # adjust flags as needed
        if msg:
            return jsonrpc_error(req_id, -32000, f"Authentication failed: {msg}")

        # 3. Execute the requested tool
        tool_name = params.get("name")
        arguments = params.get("arguments", {})

        try:
            if tool_name == "PersonalKeywordSearch":
                result = await search(
                    session_token=session_token,
                    query=arguments["query"],
                    page=arguments.get("page", 0),
                    page_size=arguments.get("page_size", 15)
                )
            if tool_name == "PersonalSearchIndex":
                result = await index_webpage(session_token, )
            else:
                return jsonrpc_error(req_id, -32601, f"Unknown tool: {tool_name}")

            # Return successful result as MCP content
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(result, indent=2)
                        }
                    ]
                }
            }
        except Exception as e:
            logging.exception(f"Tool execution error: {tool_name}")
            return jsonrpc_error(req_id, -32000, f"Tool execution failed: {str(e)}")

    # Unknown method
    return jsonrpc_error(req_id, -32601, f"Method not found: {method}")