from __future__ import annotations

import threading
import time
import uuid
from dataclasses import asdict, dataclass
from typing import Any, Mapping

from app.agent_engine.events import AppendOnlyEventStore, EventType


@dataclass(frozen=True)
class MailboxMessage:
    message_id: str
    sender_id: str
    recipient_id: str
    message_type: str
    payload: Mapping[str, Any]
    created_at: float

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class AgentMailbox:
    def __init__(self, run_id: str, events: AppendOnlyEventStore) -> None:
        self.run_id = run_id
        self.events = events
        self._condition = threading.Condition()
        self._messages: dict[str, list[MailboxMessage]] = {}

    def send(
        self,
        sender_id: str,
        recipient_id: str,
        message_type: str,
        payload: Mapping[str, Any],
    ) -> MailboxMessage:
        message = MailboxMessage(
            message_id=f"msg_{uuid.uuid4().hex}",
            sender_id=sender_id,
            recipient_id=recipient_id,
            message_type=message_type,
            payload=dict(payload),
            created_at=time.time(),
        )
        with self._condition:
            self._messages.setdefault(recipient_id, []).append(message)
            self._condition.notify_all()
        self.events.append(
            self.run_id,
            EventType.MAILBOX_MESSAGE,
            actor=sender_id,
            agent_id=recipient_id,
            payload={"message": message.to_dict()},
        )
        return message

    def receive(
        self,
        recipient_id: str,
        *,
        after_message_id: str | None = None,
        timeout: float = 0,
    ) -> tuple[MailboxMessage, ...]:
        deadline = time.monotonic() + max(0, timeout)
        with self._condition:
            while timeout > 0 and not self._after(recipient_id, after_message_id):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._condition.wait(remaining)
            return tuple(self._after(recipient_id, after_message_id))

    def _after(self, recipient_id: str, after_message_id: str | None) -> list[MailboxMessage]:
        messages = self._messages.get(recipient_id, [])
        if after_message_id is None:
            return list(messages)
        for index, item in enumerate(messages):
            if item.message_id == after_message_id:
                return list(messages[index + 1:])
        return list(messages)
