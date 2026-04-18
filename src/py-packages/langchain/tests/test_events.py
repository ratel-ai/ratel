"""Observer-hook tests on the LangChain adapter pass-through."""
from unittest.mock import AsyncMock, MagicMock

from agentified.events import ObserverEmitter, StepEvent
from agentified_langchain.agentified import LangchainAgentified, LangchainInstance


class TestLangchainAgentifiedOn:
    def test_on_delegates_to_underlying_agentified(self):
        fake_ag = MagicMock()
        fake_ag.on.return_value = lambda: None
        lc = LangchainAgentified(fake_ag)

        cb = lambda e: None
        lc.on("context_assembled", cb)
        fake_ag.on.assert_called_once_with("context_assembled", cb)


class TestLangchainInstanceSteps:
    def test_on_step_finish_forwards_event(self):
        emitter = ObserverEmitter()
        events: list[StepEvent] = []
        emitter.on("step", lambda e: events.append(e))

        # Fake underlying Instance so we don't need a real ApiClient
        fake_inst = MagicMock()
        fake_inst.discover_tool.definition.name = "agentified_discover"
        fake_inst.discover_tool.definition.description = ""
        fake_inst.discover_tool.definition.parameters = {}

        def on_wrapper(name, cb):
            return emitter.on(name, cb)

        fake_inst.on = on_wrapper

        def on_step_wrapper(data):
            emitter.emit("step", StepEvent(
                step_index=0,
                tool_calls=data.get("tool_calls", []),
                tool_results=data.get("tool_results", []),
                usage=data.get("usage"),
                finish_reason=data.get("finish_reason"),
            ))

        fake_inst.on_step_finish = on_step_wrapper

        lc_inst = LangchainInstance(fake_inst, [])
        lc_inst.on("step", lambda e: None)  # smoke: disposer type
        lc_inst.on_step_finish({
            "tool_calls": [{"name": "x"}],
            "tool_results": [{"result": 1}],
            "finish_reason": "stop",
        })

        assert len(events) == 1
        assert events[0].tool_calls == [{"name": "x"}]
        assert events[0].finish_reason == "stop"
