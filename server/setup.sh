#!/bin/bash
python3 -m venv venv
source ./venv/bin/activate

export TMPDIR="./temp"
mkdir -p "./temp"

pip3 install flask
pip3 install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
pip3 install -U sentence-transformers

rm -rd "./temp"