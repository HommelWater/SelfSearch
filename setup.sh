VENV_DIR="$(pwd)/venv"
cd "$(dirname "$0")"
python3 -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"
pip install -q fastapi pyotp uvicorn[standard] python-multipart requests websockets google-genai tantivy

# Load .env if it exists
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Check if GOOGLE_API_KEY is empty/unset
if [ -z "$GOOGLE_API_KEY" ]; then
    read -p "Enter your Google API key: " api_key
    echo "GOOGLE_API_KEY=$api_key" > .env
    export GOOGLE_API_KEY="$api_key"
    echo "API key saved to .env"
else
    echo "Using existing GOOGLE_API_KEY from .env"
fi

cd ./src
uvicorn main:app --host "127.0.0.1" --port 80 --reload