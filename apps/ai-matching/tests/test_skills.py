import pytest

from app.skills import SkillsTaxonomy, get_taxonomy, set_taxonomy


@pytest.fixture(scope='module')
def taxonomy():
    return SkillsTaxonomy.from_seed()


def test_seed_loads_sufficient_taxonomy(taxonomy):
    assert len(taxonomy) >= 150


def test_no_substring_false_positives(taxonomy):
    # The old bug: 'r' matched 'ruby', 'java' matched 'javascript'.
    assert taxonomy.resolve('r') == 'r'
    assert taxonomy.resolve('r') != 'ruby'
    assert taxonomy.resolve('java') == 'java'
    assert taxonomy.resolve('java') != 'javascript'


def test_alias_resolution(taxonomy):
    assert taxonomy.resolve('js') == 'javascript'
    assert taxonomy.resolve('React.js') == 'react'
    assert taxonomy.resolve('reactjs') == 'react'
    assert taxonomy.resolve('Golang') == 'go'
    assert taxonomy.resolve('k8s') == 'kubernetes'
    assert taxonomy.resolve('Postgres') == 'postgresql'
    assert taxonomy.resolve('C#') == 'csharp'


def test_unknown_skill_resolves_none(taxonomy):
    assert taxonomy.resolve('underwater-basket-weaving') is None
    assert taxonomy.resolve('') is None


@pytest.mark.asyncio
async def test_normalize_many_dedupes(taxonomy):
    set_taxonomy(taxonomy)
    canonical, unresolved = await taxonomy.normalize_many(['JS', 'javascript', 'react.js', 'nonsense'])
    assert canonical == ['javascript', 'react']
    assert unresolved == ['nonsense']
    set_taxonomy(None)


def test_search_autocomplete(taxonomy):
    hits = taxonomy.search('jav')
    names = {e['name'] for e in hits}
    assert 'java' in names and 'javascript' in names
