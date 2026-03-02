"""Python baseline agent stub.

Returns hardcoded responses to verify the cross-language protocol works.
Replace with real LLM integration (e.g., openai pip package) for actual benchmarking.
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scaffolding", "py"))
from scaffolding import start_agent

tools = []
config = {}


def setup(tool_defs, cfg):
    global tools, config
    tools = tool_defs
    config = cfg


def send_message(body):
    return {
        "content": "(Python stub) No LLM integration yet.",
        "toolCalls": [],
        "usage": {"totalTokens": 0, "inputTokens": 0, "outputTokens": 0},
        "durationMs": 0,
    }


if __name__ == "__main__":
    start_agent(setup=setup, send_message=send_message)

