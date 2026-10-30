#!/usr/bin/env python3
"""The deterministic half of setup, so the model only does the judgment half.

    python setup/apply_inputs.py            # reads setup/inputs.yaml
    python setup/apply_inputs.py --check    # validate inputs.yaml, write nothing

From setup/inputs.yaml it writes:

- config.yaml        cap_reset (now), monthly_cap, every preferences key, the
                     notifications sender if given
- profile.json       the skeleton: name, graduation, school, owner block,
                     location_preferences, target_start, targets, hard_no,
                     citizenship, clearance -- and an EMPTY evidence list with
                     a `_todo` marker the model must replace from the resume
- resume PDFs        setup/resume.pdf (or resume-tech/-finance.pdf) copied into
                     web/public/resume/ and converted to resume_*.md
- cover_letter_example.md  from setup/cover_letter_example.{md,txt}

It never invents anything: every value is copied from inputs.yaml or the files
the person supplied. What it leaves for Claude Code (SETUP.md) is the part that
needs reading: evidence items from the resume, projects.md, companies.yaml,
deadlines, daily.yaml.
"""
from __future__ import annotations

import datetime as dt
import io
import json
import os
import re
import shutil
import subprocess
import sys

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

CHECK = "--check" in sys.argv
REQUIRED = ["name", "email", "school", "school_short", "school_search_terms", "degree",
            "graduation", "preferred_metros", "home_metro", "job_types", "industries",
            "excluded", "work_authorization", "clearance", "start"]


def die(msg: str) -> None:
    print("apply_inputs: " + msg)
    sys.exit(1)


def read(path: str) -> str:
    with io.open(path, encoding="utf-8") as f:
        return f.read()


def write(path: str, text: str) -> None:
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


# ------------------------------------------------------------------ inputs
if not os.path.exists("setup/inputs.yaml"):
    die("setup/inputs.yaml is missing. Copy setup/inputs.example.yaml and fill it in.")
inputs = yaml.safe_load(read("setup/inputs.yaml")) or {}
missing = [k for k in REQUIRED if inputs.get(k) in (None, "", [])]
if missing:
    die("setup/inputs.yaml is missing: " + ", ".join(missing))
if not re.match(r"^[A-Za-z]+ \d{4}$", str(inputs["graduation"])):
    die("graduation must look like 'May 2027'.")
if not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", str(inputs["email"])):
    die("email is not an address.")
if re.search(r"\b(cleared|eligible for|clearance-eligible)\b", str(inputs["clearance"]), re.I):
    die("clearance wording claims eligibility; say what is true: none held, willing to undergo the process.")
grad_year = int(re.search(r"\d{4}", str(inputs["graduation"])).group())

geo = read("web/lib/geo.js")
known_metros = set(re.findall(r'^\s*\["([a-z_]+)",', geo, re.M))
for code in list(inputs["preferred_metros"]) + [inputs["home_metro"]]:
    if code not in known_metros:
        die(f"metro {code!r} is not in web/lib/geo.js METROS (known: {', '.join(sorted(known_metros))}). "
            "Add a row there first.")

salary = inputs.get("salary_min")
if salary not in (None, "", "null"):
    try:
        salary = int(str(salary).replace(",", "").replace("$", ""))
    except ValueError:
        die("salary_min must be a number or null.")
else:
    salary = None

if CHECK:
    print("inputs.yaml is complete.")
    sys.exit(0)

# ------------------------------------------------------------- config.yaml
cfg = read("config.yaml")
now = dt.datetime.now(dt.timezone.utc).astimezone().replace(microsecond=0).isoformat()
cfg = re.sub(r"^(\s*cap_reset:\s*)'[^']*'", rf"\g<1>'{now}'", cfg, count=1, flags=re.M)
if inputs.get("monthly_cap"):
    cfg = re.sub(r"^(\s*monthly_cap:\s*)[0-9.]+", rf"\g<1>{float(inputs['monthly_cap']):.2f}", cfg, count=1, flags=re.M)
cfg = re.sub(r"^(\s+graduation_year:\s*)\d{4}", rf"\g<1>{grad_year}", cfg, count=1, flags=re.M)
cfg = re.sub(r"^(\s+preferred_metros:\s*)\[.*?\]",
             rf"\g<1>[{', '.join(inputs['preferred_metros'])}]", cfg, count=1, flags=re.M)
cfg = re.sub(r"^(\s+home_metro:\s*)\S+", rf"\g<1>{inputs['home_metro']}", cfg, count=1, flags=re.M)
cfg = re.sub(r"^(\s+remote_acceptable:\s*)\S+",
             rf"\g<1>{'true' if inputs.get('remote_acceptable', True) else 'false'}", cfg, count=1, flags=re.M)
cfg = re.sub(r"^(\s+salary_min:\s*)\S+", rf"\g<1>{salary if salary else 'null'}", cfg, count=1, flags=re.M)
if inputs.get("notifications_from"):
    cfg = re.sub(r"^(\s+from:\s*).+$", rf"\g<1>{inputs['notifications_from']}", cfg, count=1, flags=re.M)
else:
    # No verified sender yet: turn the digest off rather than let it 403 nightly.
    cfg = re.sub(r"^(\s+enabled:\s*)true", r"\g<1>false", cfg, count=1, flags=re.M)
write("config.yaml", cfg)
print("config.yaml: cap_reset, preferences and notifications written")

# ------------------------------------------------------------- profile.json
example = json.loads(read("profile.example.json"))
profile = {
    "name": inputs["name"],
    "graduation": inputs["graduation"],
    "school": ", ".join([s for s in [inputs["school"], inputs["degree"],
                                     f"GPA {inputs['gpa']}" if inputs.get("gpa") else ""] if s]),
    "owner": {
        "first_name": inputs.get("first_name") or inputs["name"].split()[0],
        "email": inputs["email"],
        "school_short": inputs["school_short"],
        "school_search_terms": list(inputs["school_search_terms"]),
        "school_linkedin_alumni_url": inputs.get("school_linkedin_alumni_url") or "",
        "class_label": inputs.get("class_label") or "student",
        "degree": inputs["degree"],
        "home_city": inputs.get("home_city") or "",
    },
    "location_preferences": [f"{m} (preferred)" for m in inputs["preferred_metros"]]
                            + ([f"{inputs['home_metro']} (home; acceptable)"] if inputs.get("home_metro") else [])
                            + (["Remote (acceptable)"] if inputs.get("remote_acceptable", True) else []),
    "target_start": inputs["start"],
    "targets": {
        "tier_1": ", ".join(inputs["job_types"]) + " in " + ", ".join(inputs["industries"]) + ".",
        "tier_2": inputs.get("tier_2") or "",
    },
    "hard_no": list(inputs["excluded"]),
    "citizenship": inputs["work_authorization"],
    "clearance": inputs["clearance"],
    "_todo": "REPLACE THIS KEY: write `evidence` (6-12 true items from the resume, each with id, "
             "text, emphasis from [product, consulting, defense, finance], signals), `skills` "
             "(engineering, analysis), `activities`, `interests`, `voice_notes`. Delete `_todo`. "
             "See profile.example.json for the shape.",
    "evidence": [],
    "skills": {"engineering": [], "analysis": []},
    "activities": [],
    "interests": [],
    "voice_notes": example.get("voice_notes", ""),
}
write("profile.json", json.dumps(profile, indent=2, ensure_ascii=False) + "\n")
print("profile.json: skeleton written; evidence, skills, activities, interests are the model's job")

# ------------------------------------------------------------------ resumes
os.makedirs("web/public/resume", exist_ok=True)
pairs = []
if os.path.exists("setup/resume-tech.pdf") or os.path.exists("setup/resume-finance.pdf"):
    tech = "setup/resume-tech.pdf" if os.path.exists("setup/resume-tech.pdf") else "setup/resume-finance.pdf"
    fin = "setup/resume-finance.pdf" if os.path.exists("setup/resume-finance.pdf") else tech
    pairs = [(tech, "tech"), (fin, "finance")]
elif os.path.exists("setup/resume.pdf"):
    pairs = [("setup/resume.pdf", "tech"), ("setup/resume.pdf", "finance")]
else:
    print("resumes: none in setup/ (expected setup/resume.pdf); skipping")
for src, variant in pairs:
    dest = f"web/public/resume/resume-{variant}.pdf"
    shutil.copyfile(src, dest)
    r = subprocess.run([sys.executable, "resume_from_pdf.py", dest, f"resume_{variant}.md"],
                       capture_output=True, text=True)
    print((r.stdout or r.stderr).strip())
    if r.returncode:
        die(f"could not convert {dest}; is the name in profile.json spelled as the PDF prints it?")

# -------------------------------------------------------------- cover letter
for cand in ("setup/cover_letter_example.md", "setup/cover_letter_example.txt"):
    if os.path.exists(cand):
        body = read(cand).strip()
        write("cover_letter_example.md", "# Cover letter example (the owner's own writing)\n\n" + body + "\n")
        print("cover_letter_example.md written")
        break
else:
    if os.path.exists("setup/cover_letter_example.pdf"):
        r = subprocess.run(["pdftotext", "-layout", "setup/cover_letter_example.pdf", "-"],
                           capture_output=True, text=True)
        if r.returncode == 0 and len(r.stdout.strip()) > 200:
            write("cover_letter_example.md", "# Cover letter example (the owner's own writing)\n\n"
                  + r.stdout.strip() + "\n")
            print("cover_letter_example.md written from the PDF")
    else:
        print("cover letter: none in setup/; packs will use profile voice_notes alone")

print("\nnext: SETUP.md steps 1 (evidence), 3, 4, 6, then 7.")
