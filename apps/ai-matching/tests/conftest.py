import os
import sys
from pathlib import Path

# Env must be set BEFORE app modules are imported (settings are cached).
os.environ.setdefault('DATABASE_URL', 'postgresql://postgres:postgres@localhost:1/strafor_ai')
os.environ.setdefault('SERVICE_AUTH_TOKEN', 'test-token')
os.environ.setdefault('LLM_PROVIDER', 'mock')
os.environ.pop('RABBITMQ_URL', None)
os.environ.pop('OPENAI_API_KEY', None)
os.environ.pop('ANTHROPIC_API_KEY', None)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest


@pytest.fixture()
def auth_headers():
    return {'X-Service-Token': 'test-token'}
