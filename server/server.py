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
    print(data)
    embeddings = model.encode(text, convert_to_tensor=True)
    embeddings = embeddings.reshape(1, -1)
    print(embeddings.shape)
    page_embedding = embeddings.mean(dim=0)
    print(page_embedding.shape)

    if search_engine is None:
        search_engine = SearchNode(model.get_sentence_embedding_dimension(), page_embedding, momentum=0.1)

    clusters = search_engine.update(page_embedding, title)
    print(clusters)
    return jsonify({"status": "index_success"})

@app.route('/search', methods=['POST'])
def query():
    data = request.get_json()
    print(data)
    query = data["query"]
    print("")
    print(query)
    embed = model.encode(query, convert_to_tensor=True)
    print(embed.shape)
    path = search_engine.query(embed)
    print(path)
    values = search_engine.getValues(path)
    print(values)
    #  Get data from the clusters and return links and title pages based on that.
    return jsonify({"results":values})

@app.route('/')
def home():
    return render_template('homepage.html')

# Run the server
if __name__ == '__main__':
    app.run(debug=True)