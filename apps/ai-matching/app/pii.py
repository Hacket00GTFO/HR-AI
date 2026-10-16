"""PII minimization: strip identifying fields before anything reaches an LLM.

Recursively removes keys that typically carry direct identifiers
(name/email/phone/photo/address/…) and also redacts email addresses, phone
numbers and URLs embedded in free-text values.
"""
from __future__ import annotations

import re
from typing import Any

# Keys dropped entirely (case-insensitive, '_'/'-' normalized).
PII_KEYS = {
    'name', 'first_name', 'firstname', 'last_name', 'lastname', 'full_name',
    'middle_name', 'email', 'e_mail', 'phone', 'phone_number', 'mobile',
    'telephone', 'photo', 'avatar', 'picture', 'image', 'portrait',
    'address', 'street', 'zip', 'zipcode', 'postal_code', 'city',
    'linkedin', 'github_profile', 'twitter', 'facebook', 'instagram',
    'website', 'url', 'portfolio', 'resume', 'resume_url', 'cv_url',
    'ssn', 'national_id', 'passport', 'dob', 'date_of_birth', 'birthdate',
    'gender', 'pronouns', 'nationality', 'marital_status',
}

EMAIL_RE = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
PHONE_RE = re.compile(r'(?<!\d)(?:\+?\d[\d\s().-]{6,}\d)(?!\d)')
URL_RE = re.compile(r'https?://\S+|www\.\S+', re.IGNORECASE)

REDACTED = '[redacted]'


def _norm_key(key: str) -> str:
    return key.lower().replace('-', '_').replace(' ', '_')


def strip_pii(value: Any, *, scrub_text: bool = True) -> Any:
    """Return a deep copy of `value` with PII keys removed and PII patterns
    inside remaining strings redacted."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if _norm_key(str(k)) in PII_KEYS:
                continue
            out[k] = strip_pii(v, scrub_text=scrub_text)
        return out
    if isinstance(value, (list, tuple)):
        return [strip_pii(v, scrub_text=scrub_text) for v in value]
    if isinstance(value, str) and scrub_text:
        text = EMAIL_RE.sub(REDACTED, value)
        text = URL_RE.sub(REDACTED, text)
        text = PHONE_RE.sub(REDACTED, text)
        return text
    return value


def contains_pii(value: Any) -> bool:
    """True if any PII key or in-text PII pattern survives — used by tests
    to assert sanitization actually ran."""
    if isinstance(value, dict):
        return any(_norm_key(str(k)) in PII_KEYS or contains_pii(v) for k, v in value.items())
    if isinstance(value, (list, tuple)):
        return any(contains_pii(v) for v in value)
    if isinstance(value, str):
        return bool(EMAIL_RE.search(value) or PHONE_RE.search(value) or URL_RE.search(value))
    return False
