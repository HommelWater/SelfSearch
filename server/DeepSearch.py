import torch

cossim = lambda a, b: torch.nn.functional.cosine_similarity(a, b, dim=0)


class SearchNode:
    def __init__(self, relative_to):
        self.relative_to = relative_to
        self.offsets = torch.empty((0, relative_to.size(-1)))
        self.children = []
    
    def update(self, offsets, embed):
        if len(offsets) == 0:
            return relative_to

        offset = offsets[0]
        similarities = cossim(offset, self.offsets)
        
        if torch.max(similarities) < 0.1:
            self.offsets = torch.cat([self.offsets, embed.unsqueeze(0)])
            self.children.append(SearchNode(embed.size(-1), embed))  # do later if needed only
            return relative_to
        
        idx = similarities.argmax()
        self.children[idx].update(offsets[1:], embed)

    def query(self, embed, path=[]):
        path.append(self.name)
        similarities = cossim(embed, self.offsets) 
        idx = similarities.argmax()
        return self.children[idx].query(embed, path)