from routers.auth_router import user_is_invalid, get_user_and_session
from fastapi import APIRouter, HTTPException, Form, File, UploadFile
from google import genai
from google.genai import types
from pydantic import BaseModel
import database as db
import tantivy
import json
import time
import hashlib
import os

router = APIRouter()


class TantivySearchIndex:
    def __init__(self, index_path="tantivy_index"):
        # Define schema
        schema_builder = tantivy.SchemaBuilder()
        schema_builder.add_text_field("title", stored=True)
        schema_builder.add_text_field("description", stored=True)
        schema_builder.add_text_field("direct_keywords", stored=True)
        schema_builder.add_text_field("related_keywords", stored=True)
        schema_builder.add_text_field("url", stored=True, tokenizer_name="raw")
        schema_builder.add_integer_field("timestamp", stored=True, indexed=True)
        schema_builder.add_unsigned_field("id", stored=True, indexed=False)
        schema_builder.add_unsigned_field("user_id", stored=True, indexed=False)
        schema_builder.add_text_field("image_hash", stored=True, tokenizer_name="raw")
        schema_builder.add_text_field("image_filename", stored=True, tokenizer_name="raw")
        self.schema = schema_builder.build()
        os.makedirs(index_path, exist_ok=True)
        self.index = tantivy.Index(self.schema, path=index_path)
        #self.index.tokenizers().register("en_stem", tantivy.tokenizer("en_stem"))
        self.searcher = self.index.searcher()
        self.cache_size = 15
        self.recently_indexed_cache = [None] * self.cache_size
        self.cache_ptr = 0
    
    def add_index(self, info):
        writer = self.index.writer()
        doc = tantivy.Document.from_dict(info)
        writer.add_document(doc)
        self.recently_indexed_cache[self.cache_ptr % self.cache_size] = info
        self.cache_ptr+=1
        
        writer.commit()
        writer.wait_merging_threads()
        self.index.reload()
        self.searcher = self.index.searcher()
    
    def search(self, query: str, top_k=10, offset=0):
        q = self.index.parse_query(
            query, ["title", "description", "direct_keywords", "related_keywords", "timestamp"]
        )
        
        hits = self.searcher.search(q, top_k, offset=offset).hits
        
        results = []
        for score, doc_addr in hits:
            doc = self.searcher.doc(doc_addr)
            results.append({
                'score': score,
                'doc': doc.to_dict()
            })
        return {"search_results":results}
    
    def get_recently_indexed(self):
        """Return list of recently indexed items, newest first."""
        cache = self.recently_indexed_cache
        ptr = self.cache_ptr
        size = self.cache_size
        result = []
        for i in range(size):
            idx = (ptr - 1 - i) % size   # start from most recent, go backwards
            item = cache[idx]
            if item is None:
                break                     # no older items beyond this point
            result.append(item)
        return result


client = genai.Client()
ttv = TantivySearchIndex()

def webpage_prompt(url, title):
    return f"""
    Analyze this webpage screenshot from {url}.
    
    Page Title: {title}
    
    Extract:
    1. Important keywords directly on the page.
    2. Important keywords relevant to the page.
    3. A short description of the page.
    4. A fitting title for the page.
    
    Format as structured data.
    """

def image_prompt(filename):
    return f"""
    Analyze this image with filename {filename}.
    
    Extract:
    1. Important keywords directly related to the image.
    2. Important keywords relevant to the image.
    3. A short description of the image.
    4. A fitting title for the image.
    
    Format as structured data.
    """

async def index_webpage(session_token, url, title, filename, stored, image_bytes: bytes):
    user, session = get_user_and_session(session_token)
    msg = user_is_invalid(user, True, False)
    if msg: return msg

    sender_user_id = session["user_id"]
    
    prompt = webpage_prompt(url, title) if stored else image_prompt(filename)
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash-lite", 
            contents=[
                types.Part.from_bytes(
                    data=image_bytes,
                    mime_type='image/png',
                ),
                prompt
            ],
            config=types.GenerateContentConfig(
                temperature=0.3,
                response_mime_type="application/json",
                response_schema={
                    "type": "OBJECT",
                    "properties": {
                        "title": {"type": "STRING"},
                        "direct_keywords": {"type": "ARRAY", "items": {"type": "STRING"}},
                        "related_keywords": {"type": "ARRAY", "items": {"type": "STRING"}},
                        "description": {"type": "STRING"}
                    }
                }
            )
        )
    except Exception as e:
        print(f"API Error: {e}", flush=True)
        raise HTTPException(500, f"Gemini API Error: {e}")
    
    try:
        result_data = json.loads(response.text)
    except json.JSONDecodeError as e:
        print(f"JSON Parse Error: {e}, Response: {response.text}", flush=True)
        raise HTTPException(500, f"Failed to parse Gemini response: {e}")
    
    info = {
        'title': result_data.get('title', title),
        'filename': filename,
        'description': result_data.get('description', ''),
        'direct_keywords': ' '.join(result_data.get('direct_keywords', [])),
        'related_keywords': ' '.join(result_data.get('related_keywords', [])),
        'url': url,
        'timestamp': int(time.time()),
        'user_id': sender_user_id,
        'id': int(hashlib.sha256(url.encode()).hexdigest()[:16], 16) % (2**64),
        'image_hash': ""
    }
    print(stored)
    if stored or stored is "true":
        #check if it exists already?
        hash = hashlib.sha256(image_bytes).digest().hex()
        info['image_hash'] = hash
        os.makedirs("./files", exist_ok=True)
        with open(f"./files/{hash}", "wb") as buffer:
            buffer.write(image_bytes)
    ttv.add_index(info)
    
    return {"type":"success"}
    
    
async def search(session_token, query, page=0, page_size=15):
    user, session = get_user_and_session(session_token)
    msg = user_is_invalid(user, True, False)
    if msg: return msg
    return ttv.search(query, page_size, offset=page*page_size)

async def recently_indexed(session_token):
    user, session = get_user_and_session(session_token)
    msg = user_is_invalid(user, True, False)
    if msg: return msg
    return {"recently_indexed": ttv.get_recently_indexed()}

class SearchRequest(BaseModel):
    query:str
    session_token:str

class RecentIndexRequest(BaseModel):
    session_token:str

@router.post("")
async def s(request_data: SearchRequest):
    return await search(request_data.session_token, request_data.query)

@router.post("/recent")
async def s(request_data: RecentIndexRequest):
    return await recently_indexed(request_data.session_token)

@router.post("/index")
async def index(
    session_token: str = Form(...),
    url: str = Form(...),
    title: str = Form(...),
    filename: str = Form(...),
    stored: bool = Form(...),
    image: UploadFile = File(...)
):
    image_bytes = await image.read()
    return await index_webpage(session_token, url, title, filename, stored, image_bytes)

