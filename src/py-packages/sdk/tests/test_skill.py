import json

import httpx
import respx

from agentified.api_client import ApiClient
from agentified.models import (
    ApiClientConfig,
    Skill,
    SkillEdge,
)

TEST_URL = "http://localhost:9119"
DATASET = "test-dataset"


def test_skill_edge_serializes_from_alias():
    edge = SkillEdge(from_="a", to="b", source="developer")
    payload = edge.model_dump(by_alias=True, exclude_none=True)
    assert payload == {"from": "a", "to": "b", "source": "developer"}


def test_skill_edge_accepts_from_keyword_via_alias():
    edge = SkillEdge.model_validate({"from": "a", "to": "b"})
    assert edge.from_ == "a"
    assert edge.to == "b"
    assert edge.source is None


def test_skill_round_trips_with_optional_fields():
    skill = Skill(
        name="anomaly_memo",
        description="Investigate",
        intent="When CFO asks",
        atoms=["a", "b"],
        edges=[SkillEdge(from_="a", to="b", source="developer")],
        metadata={"team": "finance"},
    )
    payload = skill.model_dump(by_alias=True, exclude_none=True)
    assert payload["name"] == "anomaly_memo"
    assert payload["intent"] == "When CFO asks"
    assert payload["atoms"] == ["a", "b"]
    assert payload["edges"] == [{"from": "a", "to": "b", "source": "developer"}]
    assert payload["metadata"] == {"team": "finance"}


class TestRegisterSkills:
    @respx.mock
    async def test_posts_skills_to_dataset_endpoint(self):
        route = respx.post(f"{TEST_URL}/api/v1/datasets/{DATASET}/skills").mock(
            return_value=httpx.Response(201, json={"registered": 1})
        )
        client = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        result = await client.register_skills(
            DATASET,
            [
                Skill(
                    name="anomaly_memo",
                    description="Investigate",
                    intent="When CFO asks about anomalies",
                    atoms=["list_transactions", "draft_memo"],
                    edges=[
                        SkillEdge(from_="list_transactions", to="draft_memo", source="developer")
                    ],
                )
            ],
        )

        assert result.registered == 1
        assert route.called
        body = json.loads(route.calls[0].request.content)
        assert body["skills"][0]["name"] == "anomaly_memo"
        assert body["skills"][0]["atoms"] == ["list_transactions", "draft_memo"]
        assert body["skills"][0]["edges"] == [
            {"from": "list_transactions", "to": "draft_memo", "source": "developer"}
        ]

    @respx.mock
    async def test_omits_optional_fields(self):
        route = respx.post(f"{TEST_URL}/api/v1/datasets/{DATASET}/skills").mock(
            return_value=httpx.Response(201, json={"registered": 1})
        )
        client = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        await client.register_skills(
            DATASET, [Skill(name="x", description="y", atoms=["a"])]
        )

        body = json.loads(route.calls[0].request.content)
        assert body["skills"][0] == {"name": "x", "description": "y", "atoms": ["a"]}


class TestListSkills:
    @respx.mock
    async def test_returns_skills_from_dataset_endpoint(self):
        respx.get(f"{TEST_URL}/api/v1/datasets/{DATASET}/skills").mock(
            return_value=httpx.Response(
                200,
                json={
                    "skills": [
                        {
                            "name": "anomaly_memo",
                            "description": "Investigate",
                            "atoms": ["a", "b"],
                            "edges": [],
                        }
                    ]
                },
            )
        )
        client = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        result = await client.list_skills(DATASET)

        assert len(result) == 1
        assert result[0].name == "anomaly_memo"
        assert result[0].atoms == ["a", "b"]

    @respx.mock
    async def test_returns_empty_when_no_skills(self):
        respx.get(f"{TEST_URL}/api/v1/datasets/{DATASET}/skills").mock(
            return_value=httpx.Response(200, json={"skills": []})
        )
        client = ApiClient(ApiClientConfig(server_url=TEST_URL, tools=[]))
        result = await client.list_skills(DATASET)
        assert result == []
