from __future__ import annotations

import json
from typing import Any

from .models import ServerTool, ServerToolFields


def tool(
    *,
    name: str,
    description: str,
    parameters: dict[str, Any],
    metadata: dict[str, Any] | None = None,
    always_include: bool | None = None,
) -> ServerTool:
    return ServerTool(
        name=name,
        description=description,
        parameters=parameters,
        **({"metadata": metadata} if metadata else {}),
        **({"always_include": always_include} if always_include is not None else {}),
        fields=ServerToolFields(
            name=name,
            description=description,
            input_schema=json.dumps(parameters),
        ),
    )
