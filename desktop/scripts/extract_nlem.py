#!/usr/bin/env python3
"""Extract NLEM 2022 generic names into a checked-in TypeScript seed module.

Source: National List of Essential Medicines 2022 (MoHFW, via CDSCO/WHO
mirror). The alphabetical list (384 numbered entries) carries generic
names only -- strengths and forms live in the therapeutic sections and are
NOT parsed here; curated catalog rows keep that detail.

Reproducible:
    1. Download the NLEM 2022 PDF (see URL below).
    2. pip install pypdf
    3. python3 desktop/scripts/extract_nlem.py /path/to/nlem2022.pdf

Output: desktop/src/main/catalog/nlem2022.seeds.ts (overwritten).
Verify: entry count must be 384 and numbering 1..384 sequential.
"""
import re
import sys

NLEM_2022_URL = (
    "https://cdn.who.int/media/docs/default-source/essential-medicines/"
    "national-essential-medicines-lists-(neml)/searo_neml/india-2022.pdf"
    "?download=true&sfvrsn=a557cb1d_3"
)
EXPECTED_COUNT = 384
OUT_PATH = "desktop/src/main/catalog/nlem2022.seeds.ts"


def main(pdf_path: str) -> None:
    from pypdf import PdfReader
    reader = PdfReader(pdf_path)
    names: list[tuple[int, str]] = []
    for page in reader.pages:
        text = page.extract_text() or ""
        if "Alphabetical List of Medicines in NLEM 2022" not in text:
            continue
        for match in re.finditer(r"^(\d+)\.\s+(.+?)$", text, re.M):
            names.append((int(match.group(1)), match.group(2).strip()))
    numbers = [n for n, _ in names]
    assert len(names) == EXPECTED_COUNT, f"expected {EXPECTED_COUNT}, got {len(names)}"
    assert numbers == list(range(1, EXPECTED_COUNT + 1)), "numbering is not sequential"
    lines = [
        "/**",
        " * NLEM 2022 generic names (384), extracted from the MoHFW alphabetical",
        " * list -- see desktop/scripts/extract_nlem.py for the reproducible",
        " * extractor. Generic spellings follow the NLEM document verbatim.",
        " */",
        "export const NLEM_2022_GENERICS: string[] = [",
    ]
    for _, name in names:
        escaped = name.replace("\\", "\\\\").replace("'", "\\'")
        lines.append(f"    '{escaped}',")
    lines.append("];")
    lines.append("")
    with open(OUT_PATH, "w") as handle:
        handle.write("\n".join(lines))
    print(f"wrote {len(names)} generics to {OUT_PATH}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"usage: extract_nlem.py /path/to/nlem2022.pdf\nsource: {NLEM_2022_URL}")
        sys.exit(1)
    main(sys.argv[1])
