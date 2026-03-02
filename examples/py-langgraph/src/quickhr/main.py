from __future__ import annotations

import asyncio
import os
import sys

from quickhr.agent import create_hr_agent


async def main() -> None:
    agentified_url = os.environ.get("AGENTIFIED_URL", "http://localhost:9119")
    google_api_key = os.environ.get("GOOGLE_API_KEY")
    if not google_api_key:
        print("Error: GOOGLE_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    print("Connecting to Agentified core...")
    agent = await create_hr_agent(agentified_url, google_api_key=google_api_key)
    print(f"QuickHR agent ready (142 tools registered, 15 prefetched per turn)")
    print("Type 'quit' to exit.\n")

    messages: list[dict[str, str]] = []

    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nGoodbye!")
            break

        if not user_input:
            continue
        if user_input.lower() in ("quit", "exit"):
            print("Goodbye!")
            break

        messages.append({"role": "user", "content": user_input})

        try:
            result = await agent.run_turn(messages)
            response_messages = result.get("messages", [])
            for msg in reversed(response_messages):
                content = getattr(msg, "content", None) or msg.get("content", "")
                role = getattr(msg, "type", None) or msg.get("role", "")
                if role in ("ai", "assistant") and content:
                    print(f"\nAssistant: {content}\n")
                    messages.append({"role": "assistant", "content": content})
                    break
            else:
                print("\nAssistant: (no response)\n")
        except Exception as e:
            print(f"\nError: {e}\n", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
