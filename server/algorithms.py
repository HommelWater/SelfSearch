import torch

cossim = lambda a, b: torch.nn.functional.cosine_similarity(a.unsqueeze(0), b, dim=-1)

# TODO: Parallelize queries, handle storage on disk.

class SearchNode:
    def __init__(self, dim, momentum=0.1):
        self.dim = dim
        self.momentum = momentum
        self.means = None
        self.children = []
    
    def update_all_means(self, d_mean):
        self.means += d_mean
        for child in self.children:
            child.update_all_means(d_mean)

    def update_mean(self, idx, embed):
        old_mean = self.means[idx]
        self.means[idx] = (1 - self.momentum) * self.means[idx] + self.momentum * embed
        d_mean = old_mean - self.means[idx]
        self.children[idx].update_all_means(d_mean)

    def add_child(self, embed):
        self.children.append(SearchNode(self.dim, self.momentum))
        if self.means is None:
            self.means = embed.clone().unsqueeze(0)
        else:
            self.means = torch.cat([self.means, embed.unsqueeze(0)], dim=0)

    @torch.no_grad()
    def query(self, embed, path=[]):
        if embed.abs().sum().item() == 0.0:
            return path

        #  Initialize if there's no clusters yet.
        if self.means is None:
            self.add_child(self, embed)
            path.append(0)
            return path

        similarities = cossim(embed, self.means)
        most_similar, idx = similarities.max(dim=0)
        idx = idx.item()

        #  Dynamically calculate the cutoffs based on similarity statistics.
        alpha_dyn = similarities.quantile(0.9).item()
        beta_dyn = similarities.quantile(0.7).item()

        #  If the most similar is not that similar, update the mean and return the path. If it's completely out there add a new node.
        if most_similar < self.alpha_dyn:
            if most_similar < self.beta_dyn:
                self.add_child(self, embed)
                path.append(len(self.children) - 1)
                return path
            path.append(idx)
            update_mean(idx, embed)
            return path

        #  If its similar enough to the most similar one, update its mean position and propagate further down.
        path.append(idx)
        update_mean(idx, embed)
        return self.children[idx].query(embed - self.means[idx], path)

    def store(self):
        #  Implement storing the network later. Is a fancy database really needed? Can I just store binaries for each node on the disk instead?
        pass