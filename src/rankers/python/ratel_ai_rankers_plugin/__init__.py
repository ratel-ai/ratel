"""Decision-model rankers as retrieve/rerank plugins for ``ratel-ai`` (ADR-0027, ADR-0028).

The SDK owns the plugin contract; this package re-exports it so a plugin author
imports from one place::

    from ratel_ai_rankers_plugin import define_plugin, ratel_jev_plugin
"""

from ratel_ai import (
    RankCandidate,
    RankCandidateKind,
    RankedId,
    RankFn,
    RetrieverError,
    RetrieverPlugin,
    define_plugin,
)

from ._adapter import ChoiceRanker, choice_ranker_plugin
from .jev import ratel_jev_plugin
from .openai_decision import ratel_openai_decision_plugin

__all__ = [
    "ChoiceRanker",
    "RankCandidate",
    "RankCandidateKind",
    "RankedId",
    "RankFn",
    "RetrieverError",
    "RetrieverPlugin",
    "choice_ranker_plugin",
    "define_plugin",
    "ratel_jev_plugin",
    "ratel_openai_decision_plugin",
]
