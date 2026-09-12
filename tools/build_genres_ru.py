#!/usr/bin/env python3
"""Build a Russian FB2 genre dictionary from the canonical XSD + public mappings.

Outputs:
  genres-ru.json       code -> Russian label
  genres-unmapped.txt  canonical XSD codes with no Russian label
  genres-report.json   source/conflict statistics

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
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path

XSD_URL = "https://raw.githubusercontent.com/gribuser/fb2/master/FictionBookGenres.xsd"
RU_SOURCES = (
    # Mirror of the old FictionBook 2.1 genre page; preserves code -> Russian label.
    "https://sysadminmosaic.ru/fictionbook/fictionbook",
    # Broader list useful for codes that appeared after the old FB 2.1 page.
    "https://lib.rus.ec/g",
)

USER_AGENT = "SecretLibraryGenreBuilder/1.0 (+FB2 metadata dictionary)"
XSD_NS = "http://www.w3.org/2001/XMLSchema"
CODE_RE = r"[a-z][a-z0-9_]*"


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
    # The sources we use are normally UTF-8, but keep a cp1251 fallback for old sites.
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
    # Preserve real lines but collapse horizontal whitespace.
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line)


def parse_mapping_page(raw: bytes) -> dict[str, str]:
    text = html_to_text(decode_html(raw))
    result: dict[str, str] = {}

    # FictionBook-style: sf_history - Альтернативная история
    p1 = re.compile(rf"^({CODE_RE})\s*[-–—]\s*(.+?)$", re.MULTILINE)
    for match in p1.finditer(text):
        code = match.group(1)
        label = normalize_label(match.group(2))
        if label:
            result.setdefault(code, label)

    # Librusec-style: О бизнесе популярно (popular_business) - 2627
    p2 = re.compile(
        rf"^(.+?)\s+\(({CODE_RE})\)(?:\s*[-–—]\s*[\d\s]+)?$",
        re.MULTILINE,
    )
    for match in p2.finditer(text):
        label = normalize_label(match.group(1))
        code = match.group(2)
        if label:
            result.setdefault(code, label)

    return result


def load_overrides(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return {
        str(code).strip(): normalize_label(str(label))
        for code, label in data.items()
        if str(code).strip() and normalize_label(str(label))
    }


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

    merged: dict[str, str] = {}
    source_stats: dict[str, int] = {}
    conflicts: list[Conflict] = []
    source_errors: dict[str, str] = {}

    for url in args.source:
        try:
            page_mapping = parse_mapping_page(fetch(url))
        except Exception as exc:  # keep building from remaining sources
            source_errors[url] = f"{type(exc).__name__}: {exc}"
            print(f"WARNING: failed to read {url}: {exc}", file=sys.stderr)
            continue

        # Only canonical XSD codes are allowed into the generated dictionary.
        page_mapping = {k: v for k, v in page_mapping.items() if k in xsd_codes}
        source_stats[url] = len(page_mapping)
        print(f"Mappings from {url}: {len(page_mapping)}")

        for code, label in page_mapping.items():
            if code not in merged:
                merged[code] = label
            elif merged[code] != label:
                conflicts.append(Conflict(code, merged[code], label, url))

    overrides = load_overrides(args.overrides)
    unknown_override_codes = sorted(set(overrides) - xsd_codes)
    for code, label in overrides.items():
        if code in xsd_codes:
            merged[code] = label

    final_mapping = {code: merged[code] for code in sorted(xsd_codes) if code in merged}
    missing = sorted(xsd_codes - final_mapping.keys())

    write_json(args.out, final_mapping)
    args.unmapped.parent.mkdir(parents=True, exist_ok=True)
    args.unmapped.write_text("\n".join(missing) + ("\n" if missing else ""), encoding="utf-8")

    report = {
        "canonical_codes": len(xsd_codes),
        "mapped_codes": len(final_mapping),
        "unmapped_codes": missing,
        "source_stats": source_stats,
        "source_errors": source_errors,
        "conflicts": [c.__dict__ for c in conflicts],
        "overrides_loaded": len(overrides),
        "unknown_override_codes": unknown_override_codes,
    }
    write_json(args.report, report)

    print()
    print(f"Mapped:   {len(final_mapping)} / {len(xsd_codes)}")
    print(f"Unmapped: {len(missing)}")
    print(f"Conflicts: {len(conflicts)}")
    print(f"Dictionary: {args.out}")
    print(f"Unmapped:   {args.unmapped}")
    print(f"Report:     {args.report}")

    if missing:
        print("\nCodes still needing Russian labels:")
        for code in missing:
            print(f"  {code}")

    if args.strict and (missing or source_errors):
        return 2
    return 0


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build Russian labels for FB2 genre codes")
    parser.add_argument("--xsd-url", default=XSD_URL, help="Canonical FictionBookGenres.xsd URL")
    parser.add_argument(
        "--source",
        action="append",
        default=None,
        help="Russian mapping page URL; may be repeated",
    )
    parser.add_argument("--out", type=Path, default=Path("data/genres-ru.json"))
    parser.add_argument("--unmapped", type=Path, default=Path("data/genres-unmapped.txt"))
    parser.add_argument("--report", type=Path, default=Path("data/genres-report.json"))
    parser.add_argument(
        "--overrides",
        type=Path,
        default=Path("data/genres-overrides.json"),
        help="Optional manual code -> Russian label JSON",
    )
    parser.add_argument("--strict", action="store_true", help="Exit with code 2 if anything is unmapped")
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
