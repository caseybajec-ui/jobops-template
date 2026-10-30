#!/usr/bin/env python3
"""One line that stops Windows from mangling or killing console output.

    from console import utf8_stdout
    utf8_stdout()

Python on Windows encodes stdout with the locale codepage (cp1252 here), not
UTF-8. Two things follow, and only the second one is loud:

  * An em-dash survives as the single byte 0x97. It looks right in a cp1252
    console and turns into a replacement character everywhere else — piped into
    a file, read back by another tool, or shown in a UTF-8 terminal. `DUE —`
    printing as `DUE ?` was this.
  * A character with NO cp1252 equivalent raises UnicodeEncodeError and takes
    the whole script down. Nothing in the source triggers it; the data does. A
    contact named Lukasz spelled with the Polish barred L, a posting titled with
    a CJK office name, an arrow in a scraped description — any of those crash
    `contacts.py list` at the print, after the work is already done.

The second failure is the reason this exists. It is invisible until the first
row of real data happens to contain the wrong character, and then it reads as a
crash in whatever code produced the string rather than in the print.

errors="replace" so a genuinely unencodable character still prints something
rather than aborting a run that had otherwise succeeded.
"""
import io
import sys


def utf8_stdout():
    """Make stdout (and stderr) UTF-8. Safe to call more than once."""
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name)
        if getattr(stream, "encoding", "").lower().replace("-", "") == "utf8":
            continue
        buf = getattr(stream, "buffer", None)
        if buf is None:          # already wrapped, or redirected to something
            continue             # without a byte buffer — leave it alone
        setattr(sys, name, io.TextIOWrapper(buf, encoding="utf-8",
                                            errors="replace", line_buffering=True))
