from transformers import pipeline
from collections import defaultdict
import torch

class Storage:
    def __init__(self):
        self.idx_to_keyword = []
        self.keyword_to_idx = {}
        # Maps document index to list of keyword indices
        self.sparse_vectors = []  
        # Maps keyword index to list of document indices containing it
        self.idx_to_sparse_vectors = []  
        self.values = []

    def get_idx(self, keyword, add_new=True):
        if keyword not in self.keyword_to_idx:
            if not add_new:
                return -1
            idx = len(self.idx_to_keyword)
            self.keyword_to_idx[keyword] = idx
            self.idx_to_keyword.append(keyword)
            self.idx_to_sparse_vectors.append([])
        return self.keyword_to_idx[keyword]

    def get_keyword(self, idx):
        if idx < len(self.idx_to_keyword):
            return self.idx_to_keyword[idx]
        return "<unknown>"

    def to_sparse_vector(self, keywords, add_new=True):
        sparse_vector = []
        for keyword in keywords:
            idx = self.get_idx(keyword, add_new)
            if idx != -1:
                sparse_vector.append(idx)
        return sparse_vector

    def search(self, keywords, k=10):
        query_sparse = self.to_sparse_vector(keywords, add_new=False)
        if not query_sparse:
            return []
        
        # Find all documents containing at least one query keyword
        candidate_docs = set()
        for keyword_idx in query_sparse:
            candidate_docs.update(self.idx_to_sparse_vectors[keyword_idx])
        
        # Score documents by number of overlapping keywords
        doc_counts = {}
        query_keywords_set = set(query_sparse)
        for doc_idx in candidate_docs:
            doc_keywords = self.sparse_vectors[doc_idx]
            overlap = len(set(doc_keywords) & query_keywords_set)
            doc_counts[doc_idx] = overlap
        
        # Sort by score (descending), then by insertion order (ascending index)
        sorted_docs = sorted(doc_counts.items(), key=lambda x: (-x[1], x[0]))
        top_k_indices = [doc_idx for doc_idx, _ in sorted_docs[:k]]
        return [self.values[doc_idx] for doc_idx in top_k_indices]

    def store(self, keywords, value):
        sparse_vector = self.to_sparse_vector(keywords, add_new=True)
        self.sparse_vectors.append(sparse_vector)
        self.values.append(value)
        sparse_vector_idx = len(self.sparse_vectors) - 1
        for keyword_idx in sparse_vector:
            self.idx_to_sparse_vectors[keyword_idx].append(sparse_vector_idx)


class SearchEngine:
    def __init__(self):
        self.summary_model = pipeline(
            "image-text-to-text",
            model="google/gemma-3-4b-it",
            device="cuda",
            torch_dtype=torch.bfloat16
        )# TODO: replace with better model over API, maybe deepseek v3
        self.storage = Storage()

    def index(self, title, text, image_url, page_url):
        prompt = [
            {"role": "system",  "content": [{"type": "text", "text": "You are a bot that helps index webpages."}]},
            {"role": "user",    "content": [
                {"type": "image",   "url":  image_url},
                {"type": "text",    "text": text},
                {"type": "text",    "text": "Give keywords based on the screenshot and site data. Answer in keywords only!"}
        ]}]

        output = self.summary_model(text=prompt, max_new_tokens=100)
        keywords = output[0]['generated_text'][-1]['content']
        keywords = keywords.lower().replace(".", "").split(", ")
        print(f"{title}: {keywords}")
        self.storage.store(set(keywords), (title, page_url))

    def search(self, query):
        prompt = [
            {"role": "system",   "content": [{"type": "text", "text": "You are a bot that helps index webpages."},]}, 
            {"role": "user",     "content": [
                {"type": "image",   "url":  "https://images.shopcdn.co.uk/88/2e/882e9bb7c40983eef4359e03012f279c/512x512/webp/resize"},
                {"type": "text", "text": "Give keywords for the following query:\n" + query + "\nAnswer in keywords only!"}

        ]}]
        
        output = self.summary_model(text=prompt, max_new_tokens=100)
        keywords = output[0]['generated_text'][-1]['content'].lower().replace(".", "").split(", ")
        print(keywords)
        results = self.storage.search(set(keywords))
        return results

