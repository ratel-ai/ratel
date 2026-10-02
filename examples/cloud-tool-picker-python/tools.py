"""A payments-support catalog where BM25 is confidently wrong: a customer who
was "charged twice" wants a refund, but the lexical match is on "charge"."""

from __future__ import annotations

from ratel_ai import ExecutableTool, SearchHit

_TOOLS = [
    ("stripe_create_charge", "Charge a customer's card for a new payment"),
    ("stripe_list_charges", "List the charges on a customer's account"),
    ("stripe_refund_payment", "Return funds for a payment to the customer's original card"),
    ("stripe_create_customer", "Create a new customer record"),
    ("email_send", "Send an email to a customer"),
    ("crm_log_note", "Log a note on a customer's CRM record"),
    ("calendar_create_event", "Create a calendar event"),
]

QUERY = "the customer was charged twice, give them their money back"

TOOLS = [
    ExecutableTool(id=tool_id, name=tool_id, description=desc, execute=lambda _a: "ok")
    for tool_id, desc in _TOOLS
]


def ids(hits: list[SearchHit]) -> str:
    return " > ".join(f"{h.tool_id} ({h.score:.2f})" for h in hits)
