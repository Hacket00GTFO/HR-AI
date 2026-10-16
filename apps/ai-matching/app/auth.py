"""Service-to-service auth for /v1 routes.

Accepts either:
  - X-Service-Token equal to SERVICE_AUTH_TOKEN (other services / monolith), or
  - X-User-Id (+ optional X-User-Role) headers set by an upstream gateway that
    already authenticated the end user.

If SERVICE_AUTH_TOKEN is unset the dependency is a no-op (dev mode).
/health and /ready are always public.
"""
import hmac
import logging

from fastapi import Header, HTTPException

from .config import get_settings

logger = logging.getLogger(__name__)


async def service_auth(
    x_service_token: str | None = Header(default=None),
    x_user_id: str | None = Header(default=None),
) -> None:
    settings = get_settings()
    if not settings.service_auth_token:
        return  # dev mode — no token configured
    if x_service_token and hmac.compare_digest(x_service_token, settings.service_auth_token):
        return
    if x_user_id:
        return  # upstream gateway already authenticated the caller
    raise HTTPException(status_code=401, detail='Invalid or missing service credentials')
