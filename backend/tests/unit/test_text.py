import pytest

from app.domain.text import months_text


@pytest.mark.parametrize(
    ("months", "nominative", "genitive"),
    [
        (6, "6 мес.", "6 мес."),
        (12, "1 год", "1 года"),
        (18, "1 год 6 мес.", "1 года 6 мес."),
        (24, "2 года", "2 лет"),
        (60, "5 лет", "5 лет"),
        (252, "21 год", "21 года"),
    ],
)
def test_months_text_cases(months, nominative, genitive):
    assert months_text(months) == nominative
    assert months_text(months, genitive=True) == genitive
