import torch

cossim = lambda a, b: torch.nn.functional.cosine_similarity(a.unsqueeze(0), b, dim=-1)

# TODO: Parallelize queries, handle storage on disk, prefetch next possible cluster means to gpu?.

class SearchNode:
    def __init__(self, dim, value, momentum=0.1):
        self.dim = dim
        self.momentum = momentum
        self.means = None
        self.children = []
        self.values = []
    
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
        similarities = cossim(embed, self.means)
        most_similar, idx = similarities.max(dim=0)
        idx = idx.item()

        #  Dynamically calculate the cutoffs based on similarity statistics.
        alpha_dyn = similarities.quantile(0.9).item()
        beta_dyn = similarities.quantile(0.7).item()

        #  If the most similar is not that similar, update the mean and return the path. If it's completely out there add a new node.
        if most_similar < alpha_dyn:  # might need to modify to do top k or something!
            if most_similar < beta_dyn:
                self.add_child(embed, value)
                path.append(len(self.children) - 1)
                return path
            path.append(idx)
            self.update_mean(idx, embed)
            self.values.append(value)
            return path

        #  If its similar enough to the most similar one, update its mean position and propagate further down.
        path.append(idx)
        self.update_mean(idx, embed)
        return self.children[idx].update(embed - self.means[idx], value, path)

    @torch.no_grad()
    def query(self, embed, values=[], path=[]):
        values.extend(self.values)
        if self.means is None:
            return path

        similarities = cossim(embed, self.means)
        most_similar, idx = similarities.max(dim=0)
        idx = idx.item()

        #  Dynamically calculate the cutoffs based on similarity statistics.
        alpha_dyn = similarities.quantile(0.9).item()
        if most_similar < alpha_dyn:
            path.append(idx)
            return path

        #  If its similar enough to the most similar one, update its mean position and propagate further down.
        path.append(idx)
        return self.children[idx].query(embed - self.means[idx], values, path)
