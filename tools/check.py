#!/usr/bin/env python3
"""Static checks for Dolly's front-end (no Node required).

1. Syntax-checks every ES module under public/js with macOS JavaScriptCore (jsc).
2. Verifies every named import resolves to a file that actually exports that name.
3. Verifies every stylesheet linked from index.html / imported exists.

Usage: python3 tools/check.py [file ...]   (exit code 1 on any problem)
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "public")
JSC = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc"

IMPORT_RE = re.compile(r"import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+[\w$]+)?\s*from\s*['\"]([^'\"]+)['\"]", re.S)
SIDE_IMPORT_RE = re.compile(r"^\s*import\s+['\"]([^'\"]+)['\"]", re.M)
DYN_IMPORT_RE = re.compile(r"import\(\s*['\"]([^'\"]+)['\"]\s*\)")
EXPORT_DECL_RE = re.compile(r"export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+)")
EXPORT_LIST_RE = re.compile(r"export\s*\{([^}]*)\}")
EXPORT_DEFAULT_RE = re.compile(r"export\s+default\b")
EXPORT_DESTRUCT_RE = re.compile(r"export\s+(?:const|let|var)\s*\{([^}]*)\}")


def strip_comments(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"(^|[^:'\"\\])//[^\n]*", r"\1", src)


def exports_of(path, cache={}):
    if path in cache:
        return cache[path]
    with open(path, encoding="utf-8") as f:
        src = strip_comments(f.read())
    names = set(EXPORT_DECL_RE.findall(src))
    for group in EXPORT_LIST_RE.findall(src) + EXPORT_DESTRUCT_RE.findall(src):
        for part in group.split(","):
            part = part.strip()
            if not part:
                continue
            if " as " in part:
                part = part.split(" as ")[1].strip()
            names.add(part.split(":")[-1].strip())
    if EXPORT_DEFAULT_RE.search(src):
        names.add("default")
    cache[path] = names
    return names


def js_files(args):
    if args:
        return [os.path.abspath(a) for a in args]
    out = []
    for d, _, files in os.walk(os.path.join(PUBLIC, "js")):
        out += [os.path.join(d, f) for f in files if f.endswith(".js")]
    return sorted(out)


def main():
    problems = []
    files = js_files(sys.argv[1:])
    for path in files:
        rel = os.path.relpath(path, ROOT)
        res = subprocess.run([JSC, "-e", f'try{{checkModuleSyntax(readFile({path!r}));print("OK")}}catch(e){{print("ERR "+e)}}'],
                             capture_output=True, text=True)
        out = (res.stdout + res.stderr).strip()
        if not out.startswith("OK"):
            problems.append(f"{rel}: {out}")
            continue
        with open(path, encoding="utf-8") as f:
            src = strip_comments(f.read())
        specs = [(m.group(1), m.group(2), m.group(3)) for m in IMPORT_RE.finditer(src)]
        specs += [(None, None, s) for s in SIDE_IMPORT_RE.findall(src) + DYN_IMPORT_RE.findall(src)]
        for default, named, spec in specs:
            if not spec.startswith("."):
                continue
            target = os.path.normpath(os.path.join(os.path.dirname(path), spec))
            if not os.path.exists(target):
                problems.append(f"{rel}: import target missing: {spec}")
                continue
            if not target.endswith(".js"):
                continue
            exp = exports_of(target)
            wanted = []
            if default:
                wanted.append("default")
            if named:
                for part in named.split(","):
                    part = part.strip()
                    if part:
                        wanted.append(part.split(" as ")[0].strip())
            for name in wanted:
                if name not in exp:
                    problems.append(f"{rel}: '{name}' is not exported by {spec}")

    index = os.path.join(PUBLIC, "index.html")
    if os.path.exists(index):
        html = open(index, encoding="utf-8").read()
        for ref in re.findall(r"(?:href|src)=\"(\./[^\"]+|css/[^\"]+|js/[^\"]+)\"", html):
            if not os.path.exists(os.path.join(PUBLIC, ref)):
                problems.append(f"public/index.html: missing {ref}")

    if problems:
        print("\n".join(problems))
        print(f"\n{len(problems)} problem(s) in {len(files)} file(s)")
        sys.exit(1)
    print(f"All good: {len(files)} module(s) checked")


if __name__ == "__main__":
    main()
