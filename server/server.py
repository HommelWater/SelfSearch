from flask import Flask
from flask import render_template
from sentence_transformers import SentenceTransformer
from algorithms import SearchNode

model_string = 'all-mpnet-base-v2'
model = SentenceTransformer('all-mpnet-base-v2').to("cuda")
search_engine = SearchNode(model.get_sentence_embedding_dimension(), momentum=0.1)
app = Flask(__name__)

@app.route('/index', methods=['POST'])
def index():
    data = request.get_json()
    embeddings = model(data["text"])
    page_embedding = embeddings.mean(dim=0)
    clusters = search_engine.update(page_embedding)
    test_storage
    return ""

@app.route('/search')
def query(query):
    data = request.get_json()
    query = data["query"]
    embed = model(query)
    clusters = search_engine.query(embed)
    #  Get data from the clusters and return links and title pages based on that.
    return clusters

@app.route('/')
def home():
    return render_template('homepage.html')

# Run the server
if __name__ == '__main__':
    app.run(debug=True)