"""Validation helpers for the local vocabulary notebook."""

import re


_WHITESPACE = re.compile(r"\s+")


def normalize_vocabulary_form(value: str) -> str:
    """Normalize spacing and case without stemming or altering apostrophes."""
    return _WHITESPACE.sub(" ", value).strip().casefold()


def normalize_meanings(values):
    """Validate and trim a list of manually entered meanings."""
    if not isinstance(values, list) or len(values) > 100:
        raise ValueError("invalid_meanings")
    result = []
    for value in values:
        if not isinstance(value, str):
            raise ValueError("invalid_meanings")
        meaning = value.strip()
        if not meaning or len(meaning) > 500:
            raise ValueError("invalid_meanings")
        result.append(meaning)
    return result
