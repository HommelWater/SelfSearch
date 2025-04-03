import json
import numpy
import mmap
import os
import io

vec_file = "./crawl-300d-2M-subword.vec"

def load_vocab():
    f = io.open(vec_file, 'r', encoding='utf-8', newline='\n', errors='ignore')
    n, d = map(int, f.readline().split())
    wordmap = {"<|unk|>": 0}
    vectormap = [numpy.zeros((1, 300))]
    for i, line in enumerate(f):
        tokens = line.rstrip().split(' ')
        wordmap[tokens[0]] = i + 1
        vectormap.append(numpy.array([list(map(float, tokens[1:]))]))

    vectormap = numpy.concatenate(vectormap, axis=0)
    b = numpy.astype(vectormap, numpy.float32).tobytes()
    shape = vectormap.shape
    nbytes = len(b)
    with open("./vectormap.bin", "wb") as f:
        f.write(b)
    with open("./wordmap.json", "w") as f:
        json.dump(wordmap, f)
    
load_vocab()