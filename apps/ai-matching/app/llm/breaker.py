"""In-memory circuit breaker: opens after N consecutive failures, then
half-opens after a cooldown to probe recovery."""
from __future__ import annotations

import time


class CircuitBreaker:
    CLOSED, OPEN, HALF_OPEN = 'closed', 'open', 'half_open'

    def __init__(self, failure_threshold: int = 5, half_open_after_s: float = 30.0):
        self.failure_threshold = failure_threshold
        self.half_open_after_s = half_open_after_s
        self._failures = 0
        self._opened_at: float | None = None
        self.state = self.CLOSED

    def allow(self) -> bool:
        if self.state == self.CLOSED:
            return True
        if self.state == self.OPEN:
            if time.monotonic() - (self._opened_at or 0) >= self.half_open_after_s:
                self.state = self.HALF_OPEN
                return True
            return False
        return True  # half-open: single probe allowed

    def record_success(self) -> None:
        self._failures = 0
        self._opened_at = None
        self.state = self.CLOSED

    def record_failure(self) -> None:
        self._failures += 1
        if self.state == self.HALF_OPEN or self._failures >= self.failure_threshold:
            self.state = self.OPEN
            self._opened_at = time.monotonic()
