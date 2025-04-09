from flask import Flask, request, jsonify, render_template
from sentence_transformers import SentenceTransformer
from algorithms import SearchNode

model_string = 'all-mpnet-base-v2'
model = SentenceTransformer('all-mpnet-base-v2').to("cuda")
search_engine = None
app = Flask(__name__)

@app.route('/index', methods=['POST'])
def index():
    global search_engine
    data = request.get_json()
    text = data["text"]
    title = data["title"]
    embeddings = model.encode(text, convert_to_tensor=True)
    print(embeddings.shape)
    embeddings = embeddings.reshape(-1, model.get_sentence_embedding_dimension())
    page_embedding = embeddings.mean(dim=0)
    print(page_embedding.shape)
    if search_engine is None:
        search_engine = SearchNode(model.get_sentence_embedding_dimension(), momentum=0.1)
    clusters = search_engine.update(page_embedding, title)
    return jsonify({"status": "index_success"})

@app.route('/search', methods=['POST'])
def query():
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