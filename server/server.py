from flask import Flask, request, jsonify, render_template
from search import SearchEngine

search_engine = SearchEngine()
app = Flask(__name__)

@app.route('/index', methods=['POST'])
def index():
    global search_engine
    data = request.get_json()
    search_engine.index(data["text"], data["url"], data["title"])
    return jsonify({"status": "index_success"})

@app.route('/search', methods=['POST'])
def query():
    data = request.get_json()
    results = search_engine.search(data["query"])
    return jsonify({"results":results})

@app.route('/')
def home():
    return render_template('homepage.html')

# Run the server
if __name__ == '__main__':
    app.run(debug=True)