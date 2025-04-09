import torch

cossim = lambda a, b: torch.sqrt((a.unsqueeze(0) - b) ** 2)
#torch.nn.functional.cosine_similarity(a.unsqueeze(0), b, dim=-1)

# TODO: Parallelize queries, handle storage on disk, prefetch next possible cluster means to gpu?.

class SearchNode:
    def __init__(self, dim, value, momentum=0.1):
        self.dim = dim
        self.momentum = momentum
        self.means = None
        self.children = []
        self.values = [value]
    
    def getValues(self, clusters, values=[]):
        values.extend(self.values)
        if clusters == []: return values
        return self.children[clusters[0]].getValues(clusters[1:], values)

    def update_all_means(self, d_mean):
        if self.means is None: return
        self.means += d_mean
        for child in self.children:
            child.update_all_means(d_mean)

    def update_mean(self, idx, embed):
        old_mean = self.means[idx]
        self.means[idx] = (1 - self.momentum) * self.means[idx] + self.momentum * embed
        d_mean = old_mean - self.means[idx]
        self.children[idx].update_all_means(d_mean)

    def add_child(self, embed, value):
        self.children.append(SearchNode(self.dim, value, self.momentum))
        if self.means is None:
            self.means = embed.clone().unsqueeze(0)
        else:
            self.means = torch.cat([self.means, embed.unsqueeze(0)], dim=0)

    @torch.no_grad()
    def update(self, embed, value, path=[]):
        if self.means is None:
            self.add_child(embed, value)
            path.append(0)
            return path

        similarities = cossim(embed, self.means)
        most_similar, idx = similarities.max(dim=0)
        idx = idx.item()    

        if len(self.children) > 1:
            alpha = similarities.quantile(0.9).item()
            beta = similarities.quantile(0.7).item()
        else:
            alpha = 0.9
            beta = 0.7

        if most_similar > alpha:
            path.append(idx)
            self.update_mean(idx, embed)
            self.children[idx].values.append(value)
            return path
        if most_similar > beta:
            path.append(idx)
            self.update_mean(idx, embed)
            return self.children[idx].update(embed - self.means[idx], value, path)
        
        self.add_child(embed, value)
        path.append(len(self.children) - 1)
        return path

    @torch.no_grad()
    def query(self, embed, path=[]):
        if self.means is None:
            return path

        similarities = cossim(embed, self.means)
        most_similar, idx = similarities.max(dim=0)
        idx = idx.item()

        #  Dynamically calculate the cutoffs based on similarity statistics.
        if len(self.children) > 1:
            beta = similarities.quantile(0.9).item()
        else:
            beta = 0.9

        if most_similar > beta:
            path.append(idx)
            return path

        #  If its similar enough to the most similar one, update its mean position and propagate further down.
        path.append(idx)
        return self.children[idx].query(embed - self.means[idx], path)
