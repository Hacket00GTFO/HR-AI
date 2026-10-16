"""CV/document sanitization before LLM or lexical processing.

- Strips zero-width / invisible unicode (used to hide prompt-injection text).
- Detects hidden-text tricks (display:none, white-on-white, HTML comments,
  font-size:0) → flag `hidden_text`.
- Flags `injection_suspected` when instruction-like phrases appear INSIDE the
  CV content (they have no business in a resume).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

ZERO_WIDTH_RE = re.compile(
    '[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff\u00ad\u034f\u180e]'
)

HIDDEN_PATTERNS = [
    re.compile(r'display\s*:\s*none', re.IGNORECASE),
    re.compile(r'visibility\s*:\s*hidden', re.IGNORECASE),
    re.compile(r'font-size\s*:\s*0', re.IGNORECASE),
    re.compile(r'color\s*:\s*(white|#fff\b|#ffffff|rgb\(\s*255)', re.IGNORECASE),
    re.compile(r'<!--.*?-->', re.DOTALL),
    re.compile(r'<\s*(span|div|font)[^>]*opacity\s*:\s*0', re.IGNORECASE),
]

INJECTION_PATTERNS = [
    re.compile(r'ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|context)', re.IGNORECASE),
    re.compile(r'\bdisregard\s+(all\s+)?(previous|prior|above|the)\b', re.IGNORECASE),
    re.compile(r'\bforget\s+(everything|all|your)\b', re.IGNORECASE),
    re.compile(r'\byou\s+are\s+(now\s+)?(a|an|the)?\s*\w*\s*(assistant|ai|model|chatbot|system)\b', re.IGNORECASE),
    re.compile(r'^\s*system\s*:', re.IGNORECASE | re.MULTILINE),
    re.compile(r'\bact\s+as\s+(a|an|if)\b', re.IGNORECASE),
    re.compile(r'\bnew\s+instructions?\s*:', re.IGNORECASE),
    re.compile(r'\bdo\s+not\s+follow\s+(the\s+)?(previous|prior|above)\b', re.IGNORECASE),
    re.compile(r'\boverride\s+(your\s+)?(instructions?|programming|directives?)\b', re.IGNORECASE),
    re.compile(r'<\s*/?\s*(system|assistant|instruction)\s*>', re.IGNORECASE),
]

_WHITESPACE_RUN = re.compile(r'[ \t]{2,}')


@dataclass
class SanitizedText:
    text: str
    flags: list[str] = field(default_factory=list)

    @property
    def injection_suspected(self) -> bool:
        return 'injection_suspected' in self.flags


def sanitize_document(raw: str | None) -> SanitizedText:
    flags: list[str] = []
    text = raw or ''

    stripped = ZERO_WIDTH_RE.sub('', text)
    if stripped != text:
        flags.append('zero_width_chars_removed')
    text = stripped

    # Scan for injection phrases BEFORE stripping hidden carriers — an
    # instruction smuggled inside an HTML comment still counts.
    if any(p.search(text) for p in INJECTION_PATTERNS):
        flags.append('injection_suspected')

    if any(p.search(text) for p in HIDDEN_PATTERNS):
        flags.append('hidden_text')
        # Drop HTML comments entirely — classic hidden-instruction carrier.
        text = re.sub(r'<!--.*?-->', ' ', text, flags=re.DOTALL)

    text = _WHITESPACE_RUN.sub(' ', text).strip()
    return SanitizedText(text=text, flags=flags)
