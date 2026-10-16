from app.pii import strip_pii, contains_pii


def test_strips_direct_identifier_keys_recursively():
    payload = {
        'first_name': 'John', 'last_name': 'Doe', 'email': 'john@x.com',
        'phone': '555-1234', 'photo': 'http://x/me.jpg',
        'skills': ['python'],
        'nested': {'linkedin': 'https://linkedin.com/in/j', 'experience': 5},
    }
    clean = strip_pii(payload)
    assert clean == {'skills': ['python'], 'nested': {'experience': 5}}
    assert not contains_pii(clean)


def test_redacts_pii_inside_free_text():
    clean = strip_pii({'summary': 'Reach me at john@x.com or 555-123-4567, see https://me.dev'})
    assert 'john@x.com' not in clean['summary']
    assert '555-123-4567' not in clean['summary']
    assert 'https://me.dev' not in clean['summary']


def test_provider_payload_is_sanitized():
    """The assertion the spec demands: a candidate payload containing email/
    phone must reach the provider sanitized."""
    candidate = {
        'id': 7, 'name': 'John X', 'email': 'john@x.com', 'phone': '555-1234',
        'skills': 'python, fastapi', 'experience': 4,
        'description': 'Contact john@x.com',
    }
    sanitized = strip_pii(candidate)
    assert 'email' not in sanitized and 'phone' not in sanitized and 'name' not in sanitized
    assert 'john@x.com' not in str(sanitized)
    assert '555-1234' not in str(sanitized)
    assert sanitized['skills'] == 'python, fastapi'


def test_contains_pii_detects_leftovers():
    assert contains_pii({'email': 'a@b.co'})
    assert contains_pii({'bio': 'call 555-123-4567'})
    assert not contains_pii({'skills': ['go'], 'experience': 3})
