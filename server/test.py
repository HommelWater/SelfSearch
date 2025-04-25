from transformers import pipeline
from collections import defaultdict
import torch


summary_model = pipeline(
    "image-text-to-text",
    model="google/gemma-3-4b-it",
    device="cuda",
    torch_dtype=torch.bfloat16
)

def index(title, text, image_url):
    global summary_model
    prompt = [
        {"role": "system",  "content": [{"type": "text", "text": "You are a bot that helps index webpages."}]},
        {"role": "user",    "content": [
            {"type": "image",   "url":  image_url},
            {"type": "text",    "text": text},
            {"type": "text",    "text": "Give keywords based on the screenshot and site data. Answer in keywords only!"}
    ]}]

    output = summary_model(text=prompt, max_new_tokens=100)
    keywords = output[0]['generated_text'][-1]['content']
    keywords = keywords.lower().replace(".", "").split(", ")
    print(f"{title}: {keywords}")

def search(query):
    global summary_model
    prompt = [
        {"role": "system",   "content": [{"type": "text", "text": "You are a bot that helps index webpages."},]}, 
        {"role": "user",     "content": [
            {"type": "image",   "url":  "https://images.shopcdn.co.uk/88/2e/882e9bb7c40983eef4359e03012f279c/512x512/webp/resize"},
            {"type": "text", "text": "Give keywords for the following query:\n" + query + "\nAnswer in keywords only!"}

    ]}]
    
    output = summary_model(text=prompt, max_new_tokens=100)
    keywords = output[0]['generated_text'][-1]['content'].lower().replace(".", "").split(", ")
    print(f"{title}: {keywords}")

index("test page", "this is a test page to see how well the search engine works.", "https://media.4-paws.org/f/8/0/5/f8055215b5cdc5dee5494c255ca891d7b7d33cd1/Molly_006-2829x1886-2726x1886.jpg")
search("that one creature that people have as a pet at home")