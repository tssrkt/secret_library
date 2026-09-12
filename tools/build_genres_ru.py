#!/usr/bin/env python3
"""Build a Russian FB2 genre dictionary safely.

The output is intentionally broader than FictionBookGenres.xsd because real
FB2 libraries contain historical/de-facto genre codes.

Priority, from lowest to highest:
  1. local seed (data/genres-seed.json);
  2. existing output file, for already discovered extended codes;
  3. public mapping sources, in configured order (first source wins);
  4. manual overrides (data/genres-overrides.json).

Important safety property:
A temporary failure of an external source must never shrink a previously good
dictionary. Existing local mappings are kept when a source cannot be read.

Outputs:
  data/genres-ru.json
  data/genres-unmapped.txt
  data/genres-report.json

Uses only the Python standard library.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from html.parser import HTMLParser
from pathlib import Path

XSD_URL = "https://raw.githubusercontent.com/gribuser/fb2/master/FictionBookGenres.xsd"

RU_SOURCES = (
    "https://sysadminmosaic.ru/fictionbook/fictionbook",
    "https://lib.rus.ec/g",
)

USER_AGENT = "SecretLibraryGenreBuilder/3.1 (+FB2 metadata dictionary)"
XSD_NS = "http://www.w3.org/2001/XMLSchema"
CODE_RE = r"[a-z][a-z0-9_]*"
CODE_FULL_RE = re.compile(rf"^{CODE_RE}$")
MAX_MAPPING_CODE_LENGTH = 128


def is_valid_mapping_code(code: str) -> bool:
    """Accept real-world genre keys while rejecting empty/control-character junk.

    Canonical/source parsing still uses CODE_FULL_RE. Mapping files (seed, existing
    output, overrides) may also contain historical aliases, hyphenated tags, spaces
    and non-Latin labels observed in real FB2 collections.
    """
    if not code or len(code) > MAX_MAPPING_CODE_LENGTH:
        return False
    return not any(ord(ch) < 32 or ord(ch) == 127 for ch in code)


@dataclass(frozen=True)
class Conflict:
    code: str
    kept: str
    rejected: str
    source: str


class TextExtractor(HTMLParser):
    BLOCK_TAGS = {
        "address", "article", "aside", "blockquote", "br", "dd", "div", "dl",
        "dt", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4",
        "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
        "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def text(self) -> str:
        return "".join(self.parts)


def fetch(url: str) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xml,text/xml;q=0.9,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return response.read()


def decode_html(raw: bytes) -> str:
    for encoding in ("utf-8", "cp1251"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            pass
    return raw.decode("utf-8", errors="replace")


def parse_xsd_codes(raw: bytes) -> set[str]:
    root = ET.fromstring(raw)
    codes = {
        node.attrib["value"].strip()
        for node in root.findall(f".//{{{XSD_NS}}}enumeration")
        if node.attrib.get("value", "").strip()
    }
    if not codes:
        raise RuntimeError("No genre codes found in FictionBookGenres.xsd")
    return codes


def normalize_label(value: str) -> str:
    value = html.unescape(value)
    value = re.sub(r"\s+", " ", value).strip(" \t\r\n-–—")
    return value


def html_to_text(source: str) -> str:
    parser = TextExtractor()
    parser.feed(source)
    text = parser.text().replace("\xa0", " ")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line)


def parse_mapping_page(raw: bytes) -> dict[str, str]:
    """Extract code -> label pairs from several common genre-list layouts."""
    text = html_to_text(decode_html(raw))
    result: dict[str, str] = {}

    # sf_history - Альтернативная история
    p1 = re.compile(rf"^({CODE_RE})\s*[-–—]\s*(.+?)$", re.MULTILINE)
    for match in p1.finditer(text):
        code = match.group(1).strip()
        label = normalize_label(match.group(2))
        if CODE_FULL_RE.fullmatch(code) and label:
            result.setdefault(code, label)

    # Психология (sci_psychology) - 11231
    p2 = re.compile(
        rf"^(.+?)\s+\(({CODE_RE})\)(?:\s*[-–—]\s*[\d\s]+)?$",
        re.MULTILINE,
    )
    for match in p2.finditer(text):
        label = normalize_label(match.group(1))
        code = match.group(2).strip()
        if CODE_FULL_RE.fullmatch(code) and label:
            result.setdefault(code, label)

    # 0.12.9 popular_business;О бизнесе популярно
    p3 = re.compile(
        rf"^(?:\d+\.)+\d+\s+({CODE_RE})\s*;\s*(.+?)$",
        re.MULTILINE,
    )
    for match in p3.finditer(text):
        code = match.group(1).strip()
        label = normalize_label(match.group(2))
        if CODE_FULL_RE.fullmatch(code) and label:
            result.setdefault(code, label)

    return result


def load_mapping_file(path: Path, *, validate_codes: bool = True) -> dict[str, str]:
    if not path.exists():
        return {}

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")

    result: dict[str, str] = {}
    for raw_code, raw_label in data.items():
        code = str(raw_code).strip()
        label = normalize_label(str(raw_label))
        if not code or not label:
            continue
        if validate_codes and not is_valid_mapping_code(code):
            raise ValueError(f"Invalid genre code in {path}: {code!r}")
        result[code] = label
    return result


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def build(args: argparse.Namespace) -> int:
    print("Downloading canonical genre codes...")
    xsd_codes = parse_xsd_codes(fetch(args.xsd_url))
    print(f"XSD codes: {len(xsd_codes)}")

    seed = load_mapping_file(args.seed)
    existing = load_mapping_file(args.out) if args.out.exists() else {}
    overrides = load_mapping_file(args.overrides)

    # Local baseline. Existing output only supplements the seed so previously
    # discovered extended codes survive temporary source failures.
    local_baseline = dict(seed)
    for code, label in existing.items():
        local_baseline.setdefault(code, label)

    merged = dict(local_baseline)

    source_stats: dict[str, dict[str, int]] = {}
    source_errors: dict[str, str] = {}
    conflicts: list[Conflict] = []
    source_mapping: dict[str, str] = {}

    # Source priority: first successful source wins against later sources.
    # Sources are allowed to refresh local baseline labels.
    for url in args.source:
        try:
            page_mapping = parse_mapping_page(fetch(url))
        except Exception as exc:
            source_errors[url] = f"{type(exc).__name__}: {exc}"
            print(f"WARNING: failed to read {url}: {exc}", file=sys.stderr)
            continue

        canonical_here = set(page_mapping) & xsd_codes
        extended_here = set(page_mapping) - xsd_codes
        source_stats[url] = {
            "total": len(page_mapping),
            "canonical": len(canonical_here),
            "noncanonical": len(extended_here),
        }
        print(
            f"Mappings from {url}: {len(page_mapping)} "
            f"({len(canonical_here)} canonical, {len(extended_here)} extended)"
        )

        for code, label in page_mapping.items():
            if code not in source_mapping:
                source_mapping[code] = label
            elif source_mapping[code] != label:
                conflicts.append(
                    Conflict(code, source_mapping[code], label, url)
                )

    # Refresh/add anything learned from sources.
    merged.update(source_mapping)

    # Highest priority.
    merged.update(overrides)

    final_mapping = dict(sorted(merged.items()))

    missing_canonical = sorted(xsd_codes - final_mapping.keys())
    noncanonical_codes = sorted(set(final_mapping) - xsd_codes)
    source_extended = sorted(set(source_mapping) - xsd_codes)
    cached_extended = sorted(
        (set(existing) - xsd_codes) - set(source_mapping)
    )

    # Safety check: never silently shrink a pre-existing dictionary.
    if existing and len(final_mapping) < len(existing):
        raise RuntimeError(
            f"Refusing to shrink dictionary from {len(existing)} "
            f"to {len(final_mapping)} entries"
        )

    write_json(args.out, final_mapping)

    args.unmapped.parent.mkdir(parents=True, exist_ok=True)
    args.unmapped.write_text(
        "\n".join(missing_canonical) + ("\n" if missing_canonical else ""),
        encoding="utf-8",
    )

    report = {
        "canonical_codes": len(xsd_codes),
        "seed_codes": len(seed),
        "existing_codes_loaded": len(existing),
        "source_codes": len(source_mapping),
        "source_extended_codes": len(source_extended),
        "cached_extended_codes": len(cached_extended),
        "overrides_loaded": len(overrides),
        "mapped_codes": len(final_mapping),
        "unmapped_canonical_codes": missing_canonical,
        "noncanonical_mapped_codes": len(noncanonical_codes),
        "noncanonical_codes": noncanonical_codes,
        "source_stats": source_stats,
        "source_errors": source_errors,
        "conflicts": [asdict(c) for c in conflicts],
    }
    write_json(args.report, report)

    print()
    print(f"Seed: {len(seed)}")
    print(f"Existing dictionary loaded: {len(existing)}")
    print(f"Source mappings: {len(source_mapping)}")
    print(f"Overrides: {len(overrides)}")
    print(f"Mapped total: {len(final_mapping)}")
    print(f"Unmapped canonical: {len(missing_canonical)}")
    print(f"Noncanonical mapped: {len(noncanonical_codes)}")
    print(f"Source errors: {len(source_errors)}")
    print(f"Dictionary: {args.out}")
    print(f"Unmapped:   {args.unmapped}")
    print(f"Report:     {args.report}")

    if missing_canonical:
        print("\nCanonical codes still needing Russian labels:")
        for code in missing_canonical:
            print(f"  {code}")

    if source_errors:
        print(
            "\nNOTE: one or more sources were unavailable, "
            "but local seed/cache mappings were preserved."
        )

    if args.strict and missing_canonical:
        return 2

    if args.require_sources and source_errors:
        return 3

    return 0


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build Russian labels for canonical and extended FB2 genre codes safely"
    )
    parser.add_argument("--xsd-url", default=XSD_URL)
    parser.add_argument(
        "--source",
        action="append",
        default=None,
        help="Russian mapping page URL; may be repeated; first source has priority",
    )
    parser.add_argument(
        "--seed",
        type=Path,
        default=Path("data/genres-seed.json"),
        help="Local baseline dictionary; protects against external source outages",
    )
    parser.add_argument("--out", type=Path, default=Path("data/genres-ru.json"))
    parser.add_argument(
        "--unmapped",
        type=Path,
        default=Path("data/genres-unmapped.txt"),
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=Path("data/genres-report.json"),
    )
    parser.add_argument(
        "--overrides",
        type=Path,
        default=Path("data/genres-overrides.json"),
        help="Manual code -> Russian label JSON; highest priority",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit with code 2 only if canonical XSD codes remain unmapped",
    )
    parser.add_argument(
        "--require-sources",
        action="store_true",
        help="Also fail if any configured public source is unavailable",
    )
    return parser


def main() -> int:
    parser = make_parser()
    args = parser.parse_args()
    if args.source is None:
        args.source = list(RU_SOURCES)
    try:
        return build(args)
    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
