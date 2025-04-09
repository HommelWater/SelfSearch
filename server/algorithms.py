import torch

cossim = lambda a, b: torch.nn.functional.cosine_similarity(a.unsqueeze(0), b, dim=-1)

# TODO: Parallelize queries, handle storage on disk, prefetch next possible cluster means to gpu?.

class SearchNode:
    def __init__(self, dim, momentum=0.1):
        self.dim = dim
        self.momentum = momentum
        self.means = None
        self.children = []
        self.values = []

    def getValues(self, clusters, values=None):
        """
        If clusters is a list of ints, traverse one branch.
        If clusters is a list of branch lists, traverse each and return a list of result lists.
        """
        if values is None:
            values = []
        # Append the current node's values
        values.extend(self.values)
        
        if not clusters:
            return values
        
        # If clusters is a single branch (list of ints), continue recursion:
        if all(isinstance(item, int) for item in clusters):
            return self.children[clusters[0]].getValues(clusters[1:], values)
        
        # Otherwise, clusters is a list of branch lists.
        all_results = []
        for branch in clusters:
            # We use values.copy() to avoid sharing the same accumulation between branches.
            result = self.getValues(branch, values.copy())
            all_results.append(result)
        return all_results

    def update_all_means(self, d_mean):
        if self.means is None:
            return
        self.means += d_mean
        for child in self.children:
            child.update_all_means(d_mean)

    def update_mean(self, idx, embed):
        old_mean = self.means[idx]
        self.means[idx] = (1 - self.momentum) * self.means[idx] + self.momentum * embed
        d_mean = old_mean - self.means[idx]
        self.children[idx].update_all_means(d_mean)

    def add_child(self, embed, value):
        self.children.append(SearchNode(self.dim, self.momentum))
        self.children[-1].values.append(value)
        if self.means is None:
            self.means = embed.clone().unsqueeze(0)
        else:
            self.means = torch.cat([self.means, embed.unsqueeze(0)], dim=0)

    @torch.no_grad()
    def update(self, embed, value, path=None):
        #embed = torch.norm(embed, dim=-1)
        """Return all candidate update paths that exceed thresholds."""
        if path is None:
            path = []
        if self.means is None:
            self.add_child(embed, value)
            return [path + [0]]
        
        similarities = cossim(embed, self.means)
        print("Similarities:", similarities)
        
        # Define thresholds (adjust as needed)
        alpha = 0.6
        beta = 0.4
        print(f"alpha: {alpha}, beta: {beta}")
        
        candidate_paths = []
        # Check for indices with high similarity (> alpha)
        high_sim_idxs = torch.nonzero(similarities > alpha).view(-1)
        if high_sim_idxs.numel() > 0:
            for idx in high_sim_idxs.tolist():
                new_path = path + [idx]
                self.update_mean(idx, embed)
                self.children[idx].values.append(value)
                candidate_paths.append(new_path)
            return candidate_paths
        
        # Check for indices that exceed beta
        mid_sim_idxs = torch.nonzero(similarities > beta).view(-1)
        if mid_sim_idxs.numel() > 0:
            for idx in mid_sim_idxs.tolist():
                new_path = path + [idx]
                self.update_mean(idx, embed)
                child_paths = self.children[idx].update(embed - self.means[idx], value, new_path)
                # Assume child_paths is a list
                candidate_paths.extend(child_paths)
            return candidate_paths

        # If no similarities exceed thresholds, add a new child.
        self.add_child(embed, value)
        return [path + [len(self.children) - 1]]

    @torch.no_grad()
    def query(self, embed, path=None):
        #embed = torch.norm(embed, dim=-1)
        """Return all candidate query paths that meet the beta threshold."""
        if path is None:
            path = []
        if self.means is None:
            return [path]

        similarities = cossim(embed, self.means)
        beta = 0.4
        candidate_paths = []
        candidate_idxs = torch.nonzero(similarities > beta).view(-1)
        if candidate_idxs.numel() > 0:
            for idx in candidate_idxs.tolist():
                new_path = path + [idx]
                child_paths = self.children[idx].query(embed - self.means[idx], new_path)
                candidate_paths.extend(child_paths)
            return candidate_paths
        
        # If no index meets beta, use the best match.
        best_idx = similarities.argmax().item()
        new_path = path + [best_idx]
        return self.children[best_idx].query(embed - self.means[best_idx], new_path)
