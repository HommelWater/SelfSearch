from flask import Flask
from sentence_transformers import SentenceTransformer
import os

model_string = 'all-mpnet-base-v2'
model = SentenceTransformer('all-mpnet-base-v2').to("cuda")

app = Flask(__name__)
@app.route('/index', methods=['POST'])
def home():
    data = request.get_json()

    texts = [text.split(".") for text in data.text]
    sentence_embeddings = torch.cat([model(sentences).unsqueeze(0) for sentences in texts], dim=0)

    # Do some better processing here later for improved quality.
    text_embeddings = sentence_embeddings.mean(dim=-1)
    page_embedding = text_embeddings.mean(dim=-1)
    page_embedding = page_embedding.cpu().unsqueeze(0)
    # recompute site embeddings lol.

    site = data.site
    page = data.page
    time = data.time

    if isinstance(site_embeds, int):
        site_embeds = page_embedding
    else:
        site_embeds = torch.cat([site_embeds, page_embedding], dim=0)
    sitesmap[site] = len(sites)
    sites.append(site)
    
    pages.append([page])

    return ""

# Run the server
if __name__ == '__main__':
    os.mkdir("./storage")
    app.run(debug=True)