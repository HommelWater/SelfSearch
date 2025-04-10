from flask import Flask, request, jsonify, render_template
from sentence_transformers import SentenceTransformer
from algorithms import SearchNode, create_page_embed
from transformers import pipeline
import torch

model_string = 'all-mpnet-base-v2'
model = SentenceTransformer('all-mpnet-base-v2').to("cuda")
summary_model = pipeline("text-generation", model="google/gemma-3-1b-it", device="cuda", torch_dtype=torch.bfloat16)
search_engine = None
app = Flask(__name__)

@app.route('/index', methods=['POST'])
def index():
    global search_engine
    data = request.get_json()
    text = data["text"]
    title = data["title"]
    text.append("Page Title: " + title)
    prompt = [
        [
            {
                "role": "system",
                "content": [{"type": "text", "text": "You turn snippets of webpages into a short paragraph used to index them into a search engine. Start with a basic description of what site the text is from, add more specifics if needed. ONLY WRITE THE DESCRIPTION."},]
            },
            {
                "role": "user",
                "content": [{"type": "text", "text": " ".join(text)},]
            }
        ]
    ]
    summary = summary_model(prompt, max_new_tokens=125)
    print(summary[0][0]['generated_text'][-1]['content'])
    summary = summary[0][0]['generated_text'][-1]['content']
    embedding = model.encode(summary, convert_to_tensor=True)
    embedding = embedding.reshape(-1, model.get_sentence_embedding_dimension())

    if search_engine is None:
        search_engine = SearchNode(model.get_sentence_embedding_dimension(), momentum=0.1)

    clusters = search_engine.update(embedding, title)
    return jsonify({"status": "index_success"})

@app.route('/search', methods=['POST'])
def query():
    if search_engine is None:
        return jsonify({"error":"uninitialized"})
    data = request.get_json()
    query = data["query"]
    embed = model.encode(query, convert_to_tensor=True)
    path = search_engine.query(embed)
    values = search_engine.getValues(path)
    return jsonify({"results":values})

@app.route('/')
def home():
    return render_template('homepage.html')

# Run the server
if __name__ == '__main__':
    app.run(debug=True)