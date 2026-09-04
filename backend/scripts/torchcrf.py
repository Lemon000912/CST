# Vendored for offline use. This file reconstructs the public API of
# `torchcrf` 0.7.2 (https://github.com/kmkurn/torchcrf, MIT License):
#
#   MIT License
#   Copyright (c) 2019 The GitHub Authors of torchcrf
#   Permission is hereby granted, free of charge, to any person obtaining a copy
#   of this software and associated documentation files (the "Software"), to
#   deal in the Software without restriction, including without limitation the
#   rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
#   sell copies of the Software, and to permit persons to whom the Software is
#   furnished to do so, subject to the following conditions:
#   ...
#
# The trained MatSciBERT NER checkpoint stores CRF parameters under the exact
# names/shapes used here (start_transitions/end_transitions/transitions with
# num_tags entries), and the demo inference code expects
# `CRF(num_tags, batch_first=True)` plus `forward(emissions, tags, mask,
# reduction)` and `decode(emissions, mask)`. This module keeps that contract.
"""CRF module compatible with the original torchcrf 0.7.2 API (MIT)."""

from typing import List, Optional

import torch
import torch.nn as nn


def log_sum_exp(tensor: torch.Tensor, dim: int = -1, keepdim: bool = False) -> torch.Tensor:
    """Numerically stable log-sum-exp along one dimension."""
    maximum, _ = tensor.max(dim=dim, keepdim=True)
    result = maximum + torch.log(torch.sum(torch.exp(tensor - maximum), dim=dim, keepdim=True))
    return result if keepdim else result.squeeze(dim)


class CRF(nn.Module):
    """Linear-chain CRF with the torchcrf 0.7.2 parameter layout.

    emissions: (batch, seq_len, num_tags) when batch_first=True, otherwise
               (seq_len, batch, num_tags). tags/mask follow the same first two
               dimensions.
    """

    def __init__(self, num_tags: int, batch_first: bool = False) -> None:
        if num_tags <= 0:
            raise ValueError(f"invalid number of tags: {num_tags}")
        super().__init__()
        self.num_tags = num_tags
        self.batch_first = batch_first
        self.start_transitions = nn.Parameter(torch.empty(num_tags))
        self.end_transitions = nn.Parameter(torch.empty(num_tags))
        self.transitions = nn.Parameter(torch.empty(num_tags, num_tags))
        self.reset_parameters()

    def reset_parameters(self) -> None:
        nn.init.uniform_(self.start_transitions, -0.1, 0.1)
        nn.init.uniform_(self.end_transitions, -0.1, 0.1)
        nn.init.uniform_(self.transitions, -0.1, 0.1)

    def _validate(
        self,
        emissions: torch.Tensor,
        tags: Optional[torch.Tensor] = None,
        mask: Optional[torch.Tensor] = None,
    ) -> None:
        if emissions.dim() != 3:
            raise ValueError(f"emissions must have dimension of 3, got {emissions.dim()}")
        if emissions.size(2) != self.num_tags:
            raise ValueError(
                f"expected last dimension of emissions is {self.num_tags}, "
                f"got {emissions.size(2)}"
            )
        if tags is not None and emissions.shape[:2] != tags.shape:
            raise ValueError(
                "the first two dimensions of emissions and tags must match, "
                f"got {tuple(emissions.shape[:2])} and {tuple(tags.shape)}"
            )
        if mask is not None and emissions.shape[:2] != mask.shape:
            raise ValueError(
                "the first two dimensions of emissions and mask must match, "
                f"got {tuple(emissions.shape[:2])} and {tuple(mask.shape)}"
            )

    def forward(
        self,
        emissions: torch.Tensor,
        tags: torch.Tensor,
        mask: Optional[torch.Tensor] = None,
        reduction: str = "sum",
    ) -> torch.Tensor:
        """Return the (positive) log-likelihood of `tags`, reduced as requested."""
        self._validate(emissions, tags=tags, mask=mask)
        if reduction not in ("none", "sum", "mean", "token_mean"):
            raise ValueError(f"invalid reduction: {reduction}")
        if mask is None:
            mask = torch.ones_like(tags, dtype=torch.uint8)
        if self.batch_first:
            emissions = emissions.transpose(0, 1)
            tags = tags.transpose(0, 1)
            mask = mask.transpose(0, 1)
        log_likelihood = self._compute_score(emissions, tags, mask) - self._compute_normalizer(
            emissions, mask
        )
        if reduction == "none":
            return log_likelihood
        if reduction == "sum":
            return log_likelihood.sum()
        if reduction == "mean":
            return log_likelihood.mean()
        return log_likelihood.sum() / mask.float().sum()

    def _compute_score(
        self, emissions: torch.Tensor, tags: torch.Tensor, mask: torch.Tensor
    ) -> torch.Tensor:
        seq_length, batch_size = tags.shape
        mask = mask.float()
        arange_batch = torch.arange(batch_size, device=emissions.device)
        score = self.start_transitions[tags[0]]
        score = score + emissions[0, arange_batch, tags[0]]
        for i in range(1, seq_length):
            score = score + self.transitions[tags[i - 1], tags[i]] * mask[i]
            score = score + emissions[i, arange_batch, tags[i]] * mask[i]
        seq_ends = mask.long().sum(dim=0) - 1
        last_tags = tags[seq_ends, arange_batch]
        score = score + self.end_transitions[last_tags]
        return score

    def _compute_normalizer(self, emissions: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        seq_length, batch_size = emissions.shape[:2]
        mask = mask.float()
        start_transitions = self.start_transitions[: self.num_tags]
        transitions = self.transitions[: self.num_tags, : self.num_tags]
        score = start_transitions.view(1, self.num_tags) + emissions[0]
        for i in range(1, seq_length):
            broadcast_score = score.unsqueeze(2)  # (batch, tags, 1)
            broadcast_emissions = emissions[i].unsqueeze(1)  # (batch, 1, tags)
            next_score = broadcast_score + transitions + broadcast_emissions
            next_score = log_sum_exp(next_score, dim=1)
            if mask[i].any():
                score = torch.where(mask[i].unsqueeze(1) > 0, next_score, score)
        end_transitions = self.end_transitions[: self.num_tags]
        score = score + end_transitions.view(1, self.num_tags)
        return log_sum_exp(score, dim=1)

    def decode(
        self,
        emissions: torch.Tensor,
        mask: Optional[torch.Tensor] = None,
        nbest: int = 1,
        pad_tag: Optional[int] = None,
    ) -> List[List[int]]:
        """Viterbi-decode the best tag sequence per example (nbest=1 only)."""
        del pad_tag  # kept for signature compatibility; unused with nbest=1
        if nbest != 1:
            raise ValueError("vendored CRF supports only nbest=1")
        if mask is None:
            mask = torch.ones_like(emissions[:, :, 0], dtype=torch.uint8)
        self._validate(emissions, mask=mask)
        if self.batch_first:
            emissions = emissions.transpose(0, 1)
            mask = mask.transpose(0, 1)
        return self._viterbi_decode(emissions, mask)

    def _viterbi_decode(
        self, emissions: torch.Tensor, mask: torch.Tensor
    ) -> List[List[int]]:
        seq_length, batch_size = mask.shape
        mask_f = mask.float()
        start_transitions = self.start_transitions[: self.num_tags]
        transitions = self.transitions[: self.num_tags, : self.num_tags]
        end_transitions = self.end_transitions[: self.num_tags]

        score = start_transitions.view(1, self.num_tags) + emissions[0]  # (batch, tags)
        history: List[torch.Tensor] = []
        for i in range(1, seq_length):
            broadcast_score = score.unsqueeze(2)  # (batch, tags, 1)
            broadcast_emissions = emissions[i].unsqueeze(1)  # (batch, 1, tags)
            next_score = broadcast_score + transitions + broadcast_emissions
            next_score, prev_tags = next_score.max(dim=1)
            active = mask_f[i] > 0
            if active.any():
                score = torch.where(active.unsqueeze(1), next_score, score)
            history.append(prev_tags)

        final_score = score + end_transitions.view(1, self.num_tags)
        seq_ends = mask_f.long().sum(dim=0) - 1
        best_tags_list: List[List[int]] = []
        for idx in range(batch_size):
            seq_len = int(seq_ends[idx].item())
            last_tag = int(final_score[idx].argmax().item())
            path = [last_tag]
            prev = last_tag
            for t in range(seq_len, 0, -1):
                prev = int(history[t - 1][idx][prev].item())
                path.append(prev)
            path.reverse()
            best_tags_list.append(path)
        return best_tags_list
