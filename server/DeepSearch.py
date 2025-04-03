import torch

cossim = lambda a, b: torch.nn.functional.cosine_similarity(a, b, dim=0)


class SearchNode:
    def __init__(self):
        self.dim = relative_to.size(-1)
        self.offsets = torch.empty((0, self.dim))  # what if i replace it with the changing token representations from the embeddings layer??
        self.children = []
        self.offset_projection = torch.nn.Linear(self.dim, self.dim)
        self.output_projection = torch.nn.Linear(self.dim, self.dim)
    
    def update(self, embed, path=[]):
        offset = self.offset_projection(embed)
        path.append(self.output_projection(embed))
        similarities = cossim(offset, self.offsets)
        
        if torch.max(similarities) < 0.1:
            self.offsets = torch.cat([self.offsets, offset])
            self.children.append(SearchNode())  # do later if needed only?
            return path
        
        idx = similarities.argmax()  # replace with softmax with like a cutoff or something for gradients. infeasable to compute all gradients.
        self.children[idx].update(embed, path)
