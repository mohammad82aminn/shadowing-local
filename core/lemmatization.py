"""Offline English lemma suggestions using compact rules and hand-maintained lists."""

from __future__ import annotations

import itertools
import re
from dataclasses import dataclass


MAX_FORM_LENGTH = 120
MAX_PHRASE_WORDS = 8
TOKEN_PATTERN = re.compile(r"^[A-Za-z]+(?:['-][A-Za-z]+)*$")

# Small, source-code lexicons keep the feature dependency-free and easy to review.
IRREGULAR_VERBS = {
    "am": ("be",), "are": ("be",), "is": ("be",), "was": ("be",), "were": ("be",),
    "been": ("be",), "being": ("be",), "went": ("go",), "gone": ("go",),
    "did": ("do",), "done": ("do",), "does": ("do",), "had": ("have",),
    "has": ("have",), "having": ("have",), "saw": ("see",), "seen": ("see",),
    "took": ("take",), "taken": ("take",), "came": ("come",), "ran": ("run",),
    "ate": ("eat",), "eaten": ("eat",), "wrote": ("write",), "written": ("write",),
    "spoke": ("speak",), "spoken": ("speak",), "drove": ("drive",), "driven": ("drive",),
    "knew": ("know",), "known": ("know",), "thought": ("think",), "bought": ("buy",),
    "brought": ("bring",), "left": ("leave",), "found": ("find",), "felt": ("feel",),
    "kept": ("keep",), "held": ("hold",), "told": ("tell",), "said": ("say",),
    "paid": ("pay",), "met": ("meet",), "made": ("make",), "got": ("get",),
    "gave": ("give",), "given": ("give",), "sang": ("sing",), "sung": ("sing",),
    "slept": ("sleep",), "stood": ("stand",), "understood": ("understand",),
    "won": ("win",), "lost": ("lose",), "read": ("read",), "cut": ("cut",),
    "put": ("put",), "hit": ("hit",), "let": ("let",), "set": ("set",),
}
IRREGULAR_NOUNS = {
    "children": ("child",), "people": ("person",), "men": ("man",), "women": ("woman",),
    "feet": ("foot",), "teeth": ("tooth",), "mice": ("mouse",), "geese": ("goose",),
    "oxen": ("ox",), "indices": ("index",), "leaves": ("leaf", "leave"),
    "lives": ("life", "live"), "wives": ("wife",), "knives": ("knife",),
}
IRREGULAR_ADJECTIVES = {
    "better": ("good", "well"), "best": ("good", "well"), "worse": ("bad",),
    "worst": ("bad",), "farther": ("far",), "farthest": ("far",),
}
SILENT_E_STEMS = {
    "bak": "bake", "believ": "believe", "chang": "change", "clos": "close",
    "com": "come", "danc": "dance", "driv": "drive", "fac": "face",
    "giv": "give", "hav": "have", "hop": "hope", "lik": "like", "liv": "live",
    "lov": "love", "mak": "make", "mov": "move", "rac": "race",
    "sav": "save", "smil": "smile", "tak": "take", "us": "use", "wav": "wave", "writ": "write",
}


@dataclass(frozen=True)
class LemmaCandidate:
    form: str
    part_of_speech: str
    confidence: str


def validate_selected_form(value: object) -> str:
    """Accept one lexical word or phrase; reject sentences and unexpected text."""
    if not isinstance(value, str):
        raise ValueError("invalid_selected_form")
    if any(ord(char) < 32 for char in value):
        raise ValueError("invalid_selected_form")
    form = " ".join(value.split())
    if not form or len(form) > MAX_FORM_LENGTH:
        raise ValueError("invalid_selected_form")
    tokens = form.split(" ")
    if len(tokens) > MAX_PHRASE_WORDS or not all(TOKEN_PATTERN.fullmatch(token) for token in tokens):
        raise ValueError("invalid_selected_form")
    lowered = [token.lower() for token in tokens]
    sentence_starters = {"i", "you", "we", "they", "he", "she", "it", "this", "that", "these", "those"}
    finite_verbs = {
        "am", "is", "are", "was", "were", "do", "does", "did", "have", "has", "had",
        "can", "could", "will", "would", "should", "must", "saw", "went", "looked",
        "likes", "works", "tastes", "seems", "says", "asked", "said", "knows", "wants",
        "needs", "gets", "makes", "takes", "comes", "leaves", "found", "thought", "ran",
    }
    if len(tokens) >= 3 and lowered[0] in sentence_starters:
        raise ValueError("selected_form_must_be_a_word_or_phrase")
    if len(tokens) >= 3 and any(word in finite_verbs for word in lowered):
        raise ValueError("selected_form_must_be_a_word_or_phrase")
    return form


def _unique(values: list[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(value.lower() for value in values if value))


def _token_candidates(token: str) -> tuple[LemmaCandidate, ...]:
    word = token.lower()
    found: list[LemmaCandidate] = []

    def add(forms: tuple[str, ...] | list[str], pos: str, confidence: str) -> None:
        for form in forms:
            if form != word:
                found.append(LemmaCandidate(form, pos, confidence))

    if word in IRREGULAR_VERBS:
        add(IRREGULAR_VERBS[word], "verb", "dictionary")
    if word in IRREGULAR_NOUNS:
        add(IRREGULAR_NOUNS[word], "noun", "dictionary")
    if word in IRREGULAR_ADJECTIVES:
        add(IRREGULAR_ADJECTIVES[word], "adjective", "dictionary")

    if word.endswith("ies") and len(word) > 4:
        add((word[:-3] + "y",), "verb", "rule")
        add((word[:-3] + "y",), "noun", "rule")
    if word.endswith("ied") and len(word) > 4:
        add((word[:-3] + "y",), "verb", "rule")
    if word.endswith("ves") and len(word) > 4 and word not in IRREGULAR_NOUNS:
        add((word[:-3] + "f", word[:-3] + "fe"), "noun", "uncertain")
    if word.endswith("ing") and len(word) > 5:
        stem = word[:-3]
        forms = [SILENT_E_STEMS[stem]] if stem in SILENT_E_STEMS else [stem]
        if stem.endswith("i"):
            forms.append(stem[:-1] + "y")
        if stem not in SILENT_E_STEMS and len(stem) > 2 and stem[-1] == stem[-2] and stem[-1] not in "aeiou":
            forms.append(stem[:-1])
        add(list(_unique(forms)), "verb", "rule")
    if word.endswith("ed") and len(word) > 4:
        stem = word[:-2]
        forms = [SILENT_E_STEMS[stem]] if stem in SILENT_E_STEMS else [stem]
        if stem.endswith("i"):
            forms.append(stem[:-1] + "y")
        if stem not in SILENT_E_STEMS and len(stem) > 2 and stem[-1] == stem[-2] and stem[-1] not in "aeiou":
            forms.append(stem[:-1])
        add(list(_unique(forms)), "verb", "rule")
    if word.endswith("es") and len(word) > 4:
        if word.endswith(("sses", "ches", "shes", "xes", "zes", "oes")):
            base = word[:-2]
        else:
            base = word[:-1]
        add((base,), "verb", "rule")
        add((base,), "noun", "rule")
    elif word.endswith("s") and len(word) > 3 and not word.endswith(("ss", "us", "is")):
        add((word[:-1],), "verb", "rule")
        add((word[:-1],), "noun", "rule")
    if word.endswith("iest") and len(word) > 5:
        add((word[:-4] + "y",), "adjective", "rule")
    elif word.endswith("ier") and len(word) > 4:
        add((word[:-3] + "y",), "adjective", "rule")
    if word.endswith("est") and len(word) > 5:
        stem = word[:-3]
        add((stem, stem[:-1]) if len(stem) > 2 and stem[-1] == stem[-2] else (stem,), "adjective", "rule")
    elif word.endswith("er") and len(word) > 4:
        stem = word[:-2]
        add((stem, stem[:-1]) if len(stem) > 2 and stem[-1] == stem[-2] else (stem,), "adjective", "rule")

    if word == "saw":
        found.append(LemmaCandidate("saw", "noun", "ambiguous"))
    if word == "read":
        found.append(LemmaCandidate("read", "verb", "ambiguous"))

    unique: dict[tuple[str, str], LemmaCandidate] = {}
    for candidate in found:
        unique.setdefault((candidate.form, candidate.part_of_speech), candidate)
    return tuple(unique.values())


def suggest_lemmas(selected_form: str) -> list[dict[str, str]]:
    """Return conservative base-form candidates without contextual text."""
    form = validate_selected_form(selected_form)
    tokens = form.lower().split(" ")
    per_token = [_token_candidates(token) for token in tokens]
    if len(tokens) == 1:
        candidates = per_token[0]
        return [
            {
                "form": candidate.form,
                "partOfSpeech": candidate.part_of_speech,
                "confidence": candidate.confidence,
            }
            for candidate in candidates[:8]
        ]

    options = [
        [(token, "phrase", "unchanged"), *((item.form, item.part_of_speech, item.confidence) for item in choices)]
        for token, choices in zip(tokens, per_token)
    ]
    results: dict[str, dict[str, str]] = {}
    for combination in itertools.product(*options):
        candidate_form = " ".join(item[0] for item in combination)
        if candidate_form == " ".join(tokens):
            continue
        changed = [item for item in combination if item[2] != "unchanged"]
        confidence = "uncertain" if any(item[2] == "uncertain" for item in changed) else "rule"
        pos = ", ".join(dict.fromkeys(item[1] for item in changed)) or "phrase"
        results.setdefault(candidate_form, {"form": candidate_form, "partOfSpeech": pos, "confidence": confidence})
        if len(results) >= 8:
            break
    return list(results.values())
