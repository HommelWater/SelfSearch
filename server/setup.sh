#!/bin/bash
python3 -m venv venv
source ./venv/bin/activate

export TMPDIR="./temp"
mkdir -p "./temp"

pip install flask
pip3 install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/rocm6.2.4
pip install -U sentence-transformers

rm -rd "./temp"