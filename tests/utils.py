from datetime import datetime, timedelta

async def bulk_insert_messages(dm, user_id: str, count: int, start_index: int = 1) -> None:
    """Insert `count` messages for `user_id` with sequential timestamps.

    Each message will have a `wa_message_id` of the form ``wa_<n>`` and a
    `message` body ``msg <n>`` where ``n`` starts at ``start_index``.
    ``timestamp`` values begin at 2000-01-01 and increment by one second per
    message to ensure chronological ordering.
    """
    base_time = datetime(2000, 1, 1)
    for i in range(count):
        idx = start_index + i
        await dm.upsert_message({
            "wa_message_id": f"wa_{idx}",
            "user_id": user_id,
            "message": f"msg {idx}",
            "from_me": 0,
            "status": "received",
            "timestamp": (base_time + timedelta(seconds=idx)).isoformat(),
        })
