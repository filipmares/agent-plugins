#!/usr/bin/env python3
"""Cross-platform export/import of GitHub Copilot app configuration.

Works on macOS, Windows and Linux. Handles the fact that the Copilot databases
store absolute, OS-specific filesystem paths: on import you can rewrite them to
match the new machine's home directory and path style.

    python3 copilot_migrate.py export  [--out DIR] [--no-history]
    python3 copilot_migrate.py inspect BUNDLE
    python3 copilot_migrate.py import  BUNDLE [--map OLD=NEW] [--dry-run]

On Windows the interpreter is `python`, not `python3`.

Run `import` with the Copilot app fully quit.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import tarfile
import tempfile
from datetime import datetime
from pathlib import Path, PurePosixPath, PureWindowsPath

# --------------------------------------------------------------------------
# What we move, and what we deliberately leave behind.
# --------------------------------------------------------------------------

CONFIG_FILES = ["settings.json", "mcp-config.json", "permissions-config.json"]
DATABASES = ["data.db", "session-store.db"]
HISTORY_DATABASES = {"session-store.db"}

# Directory names never worth carrying: runtime state, caches, build output.
PRUNE_DIRS = {
    "node_modules", ".venv", "__pycache__", "out", "dist", ".git",
    "user-data", "edge-profile", "Cache", "CacheStorage", "Code Cache",
    "GPUCache", "Service Worker", "logs",
}
PRUNE_SUFFIXES = {".db-wal", ".db-shm", ".log", ".pyc"}
PRUNE_NAMES = {".DS_Store", "Thumbs.db"}
MAX_FILE_BYTES = 10 * 1024 * 1024

EXCLUDED_NOTES = """\
  config.json                 auto-managed auth/state, machine-bound
  m-encryption-key.enc        local encryption key, machine-bound
  mcp-oauth-config/           OAuth tokens - re-authenticate instead
  installed-plugins/          reinstall from marketplaces named in settings.json
  extensions/<ext>/ code      reinstall the extension; only artifacts/ travel
  platform-cache.db           PR/issue cache, rebuilds itself
  embedding-cache.db          rebuilds itself
  session-state/ state/ logs/ chats/ review-state/ workspaces/
  attachments/ browser-output/ media-cache/ run/ servers/
  *.bak-* *.pre-update-backup-*
  gh CLI config               run `gh auth login` on the new machine
"""

# (table, column) pairs that contain absolute filesystem paths.
PATH_COLUMNS = [
    ("projects", "main_repo_path"),
    ("worktrees", "path"),
    ("workspace_checkout_bindings", "repo_path"),
    ("workspace_checkout_bindings", "checkout_path"),
    ("workspaces", "source_path"),
    ("project_checkouts", "root_resource_uri"),
    ("settings", "storage_location"),
    ("app_state", "value"),
    ("activity_items", "preview"),
    ("session_open_canvases", "payload"),
]

HOME_RE = re.compile(r"(?:/Users/|/home/|[A-Za-z]:[\\/]Users[\\/])[^/\\\"'\s,;:)\]}]+")


def log(msg: str = "") -> None:
    print(msg, flush=True)


def copilot_home() -> Path:
    return Path(os.environ.get("COPILOT_HOME") or Path.home() / ".copilot")


# --------------------------------------------------------------------------
# Copying helpers
# --------------------------------------------------------------------------

def should_prune(path: Path) -> bool:
    if path.name in PRUNE_NAMES:
        return True
    if path.is_dir():
        return path.name in PRUNE_DIRS
    if path.suffix in PRUNE_SUFFIXES:
        return True
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return True
    except OSError:
        return True
    return False


def copy_tree(src: Path, dst: Path) -> int:
    """Copy src into dst, following symlinks and pruning runtime junk."""
    count = 0
    if not src.exists():
        return 0
    dst.mkdir(parents=True, exist_ok=True)
    for entry in sorted(src.iterdir()):
        try:
            resolved = entry.resolve()
        except OSError:
            continue
        if should_prune(resolved):
            continue
        target = dst / entry.name
        if resolved.is_dir():
            count += copy_tree(resolved, target)
        else:
            try:
                shutil.copy2(resolved, target)
                count += 1
            except OSError:
                pass
    return count


def read_conn(path: Path) -> sqlite3.Connection:
    """Open a database for reading.

    Read-only URI mode fails on a WAL-mode database that has no sidecar -shm
    file (as is the case for freshly copied snapshots), so fall back to a
    normal connection.
    """
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        con.execute("SELECT 1 FROM sqlite_master LIMIT 1")
        return con
    except sqlite3.Error:
        return sqlite3.connect(str(path))


def snapshot_db(src: Path, dst: Path) -> bool:
    """Consistent SQLite copy that tolerates a live WAL."""
    if not src.exists():
        return False
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        con = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
        out = sqlite3.connect(dst)
        with out:
            con.backup(out)
        # Roll the copy out of WAL mode so it is a single self-contained file
        # that opens cleanly anywhere, including read-only on another OS.
        out.execute("PRAGMA journal_mode=DELETE")
        out.close()
        con.close()
        for side in ("-wal", "-shm"):
            stale = Path(str(dst) + side)
            if stale.exists():
                stale.unlink()
        return True
    except sqlite3.Error as exc:
        log(f"  ! could not snapshot {src.name}: {exc}")
        return False


def human(num: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if num < 1024:
            return f"{num:.0f}{unit}"
        num /= 1024
    return f"{num:.0f}TB"


# --------------------------------------------------------------------------
# Path analysis and rewriting
# --------------------------------------------------------------------------

def detect_home_prefixes(db: Path) -> dict[str, int]:
    """Find home-directory prefixes referenced inside a database."""
    found: dict[str, int] = {}
    if not db.exists():
        return found
    con = read_conn(db)
    try:
        for table, column in PATH_COLUMNS:
            try:
                rows = con.execute(
                    f'SELECT CAST("{column}" AS TEXT) FROM "{table}" '
                    f'WHERE "{column}" IS NOT NULL'
                ).fetchall()
            except sqlite3.Error:
                continue
            for (value,) in rows:
                if not value:
                    continue
                for match in HOME_RE.findall(value):
                    key = match.replace("\\", "/")
                    found[key] = found.get(key, 0) + 1
    finally:
        con.close()
    return found


def to_native(path_str: str) -> str:
    """Convert a POSIX-style path to this machine's native separators."""
    if os.name == "nt":
        return str(PureWindowsPath(PurePosixPath(path_str)))
    return path_str


def as_uri(path_str: str) -> str:
    p = path_str.replace("\\", "/")
    if re.match(r"^[A-Za-z]:", p):
        return "file:///" + p
    return "file://" + p


def target_is_windows(path_str: str) -> bool:
    return bool(re.match(r"^[A-Za-z]:", path_str)) or "\\" in path_str


# A path tail may contain spaces (e.g. "Application Support"), so stop only at
# characters that cannot continue a path in JSON, prose or URI context.
TAIL = r'[^"\'\n\r\t,;)\]}<>|*?]*'


def rewrite_value(value: str, mapping: dict[str, str]) -> str:
    """Rewrite path prefixes in a string, normalising separators for the target."""
    result = value
    for old, new in mapping.items():
        win = target_is_windows(new)
        sep = "\\" if win else "/"
        new_root = new.replace("/", "\\") if win else new.replace("\\", "/")
        old_fwd = old.replace("\\", "/")

        # file:// URIs always use forward slashes, so handle them first.
        uri_pattern = re.compile(r"file://(?:/)?" + re.escape(old_fwd) + "(" + TAIL + ")")

        def uri_repl(m: "re.Match[str]") -> str:
            tail = m.group(1).replace("\\", "/")
            return as_uri(new_root.replace("\\", "/") + tail)

        result = uri_pattern.sub(uri_repl, result)

        for variant in {old, old.replace("/", "\\")}:
            pattern = re.compile(re.escape(variant) + "(" + TAIL + ")")

            def repl(m: "re.Match[str]", _v: str = variant) -> str:
                tail = m.group(1).replace("\\", "/").replace("/", sep)
                return new_root + tail

            result = pattern.sub(repl, result)
    return result


def rewrite_db_paths(db: Path, mapping: dict[str, str], dry_run: bool) -> int:
    if not db.exists() or not mapping:
        return 0
    con = sqlite3.connect(db)
    changed = 0
    try:
        existing = {
            r[0] for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        for table, column in PATH_COLUMNS:
            if table not in existing:
                continue
            try:
                cols = {r[1] for r in con.execute(f'PRAGMA table_info("{table}")')}
            except sqlite3.Error:
                continue
            if column not in cols:
                continue
            pk = "rowid"
            try:
                rows = con.execute(
                    f'SELECT {pk}, CAST("{column}" AS TEXT) FROM "{table}" '
                    f'WHERE "{column}" IS NOT NULL'
                ).fetchall()
            except sqlite3.Error:
                continue
            for rowid, value in rows:
                if not value:
                    continue
                new_value = rewrite_value(value, mapping)
                if new_value != value:
                    changed += 1
                    if not dry_run:
                        con.execute(
                            f'UPDATE "{table}" SET "{column}" = ? WHERE {pk} = ?',
                            (new_value, rowid),
                        )
        if not dry_run:
            con.commit()
    finally:
        con.close()
    return changed


def rewrite_json_paths(path: Path, mapping: dict[str, str], dry_run: bool) -> int:
    """Rewrite path prefixes inside a JSON file, keys included.

    Parsing rather than string-replacing keeps backslash escaping correct when
    the target is a Windows path.
    """
    if not path.exists() or not mapping:
        return 0
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return 0

    count = 0

    def walk(node):
        nonlocal count
        if isinstance(node, str):
            new_node = rewrite_value(node, mapping)
            if new_node != node:
                count += 1
            return new_node
        if isinstance(node, list):
            return [walk(v) for v in node]
        if isinstance(node, dict):
            out = {}
            for k, v in node.items():
                new_key = rewrite_value(k, mapping) if isinstance(k, str) else k
                if new_key != k:
                    count += 1
                out[new_key] = walk(v)
            return out
        return node

    updated = walk(data)
    if count and not dry_run:
        path.write_text(json.dumps(updated, indent=2, sort_keys=True) + "\n",
                        encoding="utf-8")
    return count


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------

def cmd_export(args: argparse.Namespace) -> int:
    src = copilot_home()
    if not src.is_dir():
        log(f"No Copilot home at {src}")
        return 1

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = Path(args.out).expanduser() if args.out else Path.home() / "Desktop"
    if not out_dir.is_dir():
        out_dir = Path.home()
    tmp = Path(tempfile.mkdtemp())
    stage = tmp / f"copilot-migration-{stamp}"
    stage.mkdir(parents=True)

    try:
        log("==> config files")
        for name in CONFIG_FILES:
            f = src / name
            if f.is_file():
                shutil.copy2(f, stage / name)
                log(f"  {name}")

        log("==> user skills")
        skills_src = src / "skills"
        n = copy_tree(skills_src, stage / "skills")
        if n:
            dirs = [d.name for d in (stage / "skills").iterdir() if d.is_dir()]
            log(f"  {len(dirs)} skills, {n} files (runtime state stripped)")
            for entry in sorted(skills_src.iterdir()):
                if entry.is_symlink():
                    log(f"  note: {entry.name} was a symlink -> {os.readlink(entry)}")

        log("==> personal automation")
        auto_src = src / "automation"
        if auto_src.is_dir():
            copy_tree(auto_src, stage / "automation")
            for db in auto_src.glob("*.db"):
                if snapshot_db(db, stage / "automation" / db.name):
                    log(f"  {db.name} (consistent snapshot)")

        log("==> extension artifacts")
        ext_src = src / "extensions"
        if ext_src.is_dir():
            for ext in sorted(p for p in ext_src.iterdir() if p.is_dir()):
                artifacts = ext / "artifacts"
                if artifacts.is_dir():
                    copy_tree(artifacts, stage / "extensions" / ext.name / "artifacts")
                    log(f"  extensions/{ext.name}/artifacts")

        log("==> databases")
        for name in DATABASES:
            if args.no_history and name in HISTORY_DATABASES:
                log(f"  {name} skipped (--no-history)")
                continue
            dest = stage / "db" / name
            if snapshot_db(src / name, dest):
                log(f"  {name} ({human(dest.stat().st_size)})")

        write_manifest(stage, src, stamp)

        # Ship this script inside the bundle so the target machine needs nothing else.
        try:
            shutil.copy2(Path(__file__).resolve(), stage / "copilot_migrate.py")
        except OSError:
            pass

        log("==> packing")
        tarball = out_dir / f"copilot-migration-{stamp}.tar.gz"
        with tarfile.open(tarball, "w:gz") as tf:
            tf.add(stage, arcname=stage.name)

        log("")
        log(f"Done: {tarball}  ({human(tarball.stat().st_size)})")
        log("Next: copy it over, then run (from inside the extracted bundle)")
        log(f"  python3 copilot_migrate.py import {tarball.name}    # macOS, Linux")
        log(f"  python  copilot_migrate.py import {tarball.name}    # Windows")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def write_manifest(stage: Path, src: Path, stamp: str) -> None:
    lines = [
        f"# Copilot migration manifest - {stamp}",
        f"# Source home: {src}",
        f"# Source platform: {sys.platform}",
        "",
        "## Included",
    ]
    for p in sorted(stage.rglob("*")):
        rel = p.relative_to(stage)
        if len(rel.parts) <= 2:
            lines.append(f"  {rel.as_posix()}{'/' if p.is_dir() else ''}")

    lines += ["", "## Deliberately excluded (re-auth or regenerate)", EXCLUDED_NOTES]

    db = stage / "db" / "data.db"
    if db.exists():
        con = read_conn(db)
        try:
            lines.append("## Workflows")
            for name, interval, enabled in con.execute(
                "SELECT name, interval, enabled FROM workflows"
            ):
                lines.append(f"  {name} ({interval}, enabled={enabled})")
            lines.append("")
            lines.append("## Accounts (re-auth required)")
            for login, host in con.execute("SELECT login, host FROM accounts"):
                lines.append(f"  {login} @ {host}")
            lines.append("")
            lines.append("## Projects and their local paths")
            for name, path in con.execute(
                "SELECT name, main_repo_path FROM projects"
            ):
                lines.append(f"  {name}: {path}")
        except sqlite3.Error:
            pass
        finally:
            con.close()

        lines.append("")
        lines.append("## Home prefixes found inside the databases")
        lines.append("## (import rewrites these; see `inspect`)")
        for prefix, count in sorted(
            detect_home_prefixes(db).items(), key=lambda kv: -kv[1]
        ):
            lines.append(f"  {prefix}  ({count} references)")

    (stage / "MANIFEST.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------
# Inspect / Import
# --------------------------------------------------------------------------

def extract_bundle(bundle: Path, work: Path) -> Path:
    with tarfile.open(bundle, "r:gz") as tf:
        # Guard against path traversal in archive members
        for member in tf.getmembers():
            target = (work / member.name).resolve()
            if not str(target).startswith(str(work.resolve())):
                raise RuntimeError(f"unsafe path in archive: {member.name}")
        tf.extractall(work)
    dirs = [d for d in work.iterdir() if d.is_dir()]
    if not dirs:
        raise RuntimeError("unexpected bundle layout")
    return dirs[0]


def cmd_inspect(args: argparse.Namespace) -> int:
    bundle = Path(args.bundle).expanduser()
    work = Path(tempfile.mkdtemp())
    try:
        root = extract_bundle(bundle, work)
        manifest = root / "MANIFEST.md"
        if manifest.exists():
            log(manifest.read_text(encoding="utf-8"))
        prefixes = detect_home_prefixes(root / "db" / "data.db")
        if prefixes:
            log("Suggested mapping for this machine:")
            for prefix in prefixes:
                log(f"  --map '{prefix}={Path.home().as_posix()}'")
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


def build_mapping(args: argparse.Namespace, root: Path) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for item in args.map or []:
        if "=" not in item:
            log(f"Ignoring malformed --map value: {item}")
            continue
        old, new = item.split("=", 1)
        mapping[old.rstrip("/\\").replace("\\", "/")] = new.rstrip("/\\")
    if mapping or args.no_rewrite:
        return mapping

    # Auto-detect: map every discovered source home onto this machine's home.
    prefixes = detect_home_prefixes(root / "db" / "data.db")
    home = Path.home().as_posix()
    for prefix in prefixes:
        if prefix.rstrip("/") != home.rstrip("/"):
            mapping[prefix] = home
    return mapping


def cmd_import(args: argparse.Namespace) -> int:
    bundle = Path(args.bundle).expanduser()
    if not bundle.is_file():
        log(f"No such bundle: {bundle}")
        return 1

    dest = copilot_home()
    work = Path(tempfile.mkdtemp())
    try:
        root = extract_bundle(bundle, work)
        mapping = build_mapping(args, root)

        log(f"==> importing into {dest}")
        if args.dry_run:
            log("    (dry run - nothing will be written)")
        if mapping:
            log("==> path rewriting")
            for old, new in mapping.items():
                log(f"    {old}  ->  {to_native(new)}")
        else:
            log("==> path rewriting disabled")

        dest.mkdir(parents=True, exist_ok=True)
        backup = dest / f"pre-import-backup-{datetime.now():%Y%m%d-%H%M%S}"

        def preserve(rel: str) -> None:
            existing = dest / rel
            if existing.exists() and not args.dry_run:
                target = backup / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                if existing.is_dir():
                    shutil.copytree(existing, target, dirs_exist_ok=True)
                else:
                    shutil.copy2(existing, target)

        log("-- config files")
        for name in CONFIG_FILES:
            f = root / name
            if not f.is_file():
                continue
            preserve(name)
            if not args.dry_run:
                shutil.copy2(f, dest / name)
                rewrite_json_paths(dest / name, mapping, args.dry_run)
            log(f"  {name}")

        for folder in ("skills", "automation"):
            srcdir = root / folder
            if srcdir.is_dir():
                log(f"-- {folder}")
                preserve(folder)
                if not args.dry_run:
                    shutil.copytree(srcdir, dest / folder, dirs_exist_ok=True)
                log(f"  {folder} restored")

        ext = root / "extensions"
        if ext.is_dir():
            log("-- extension artifacts")
            for e in sorted(p for p in ext.iterdir() if p.is_dir()):
                art = e / "artifacts"
                if art.is_dir() and not args.dry_run:
                    shutil.copytree(
                        art, dest / "extensions" / e.name / "artifacts",
                        dirs_exist_ok=True,
                    )
                log(f"  extensions/{e.name}/artifacts")

        log("-- databases")
        for name in DATABASES:
            f = root / "db" / name
            if not f.is_file():
                continue
            preserve(name)
            if not args.dry_run:
                for side in ("-wal", "-shm"):
                    stale = dest / (name + side)
                    if stale.exists():
                        stale.unlink()
                shutil.copy2(f, dest / name)
                changed = rewrite_db_paths(dest / name, mapping, args.dry_run)
            else:
                changed = rewrite_db_paths(f, mapping, True)
            suffix = f", {changed} path values rewritten" if mapping else ""
            log(f"  {name}{suffix}")

        log("")
        log("==> manual follow-ups")
        log("  1. Launch Copilot and sign in to each account (see MANIFEST.md).")
        log("  2. Re-authenticate MCP servers.")
        log("  3. Reinstall plugins from the marketplaces in settings.json.")
        log("  4. Reinstall canvas extensions, then check artifacts/ survived.")
        log("  5. Clone repos to the rewritten paths shown above.")
        log("  6. Reinstall dependencies for skills that used node_modules/venvs.")
        log("  7. On Windows, replace `python3` with `python` in automation prompts.")
        if not args.dry_run:
            log("")
            log(f"Backup of replaced files: {backup}")
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    ex = sub.add_parser("export", help="create a migration bundle")
    ex.add_argument("--out", help="output directory (default: ~/Desktop)")
    ex.add_argument("--no-history", action="store_true",
                    help="skip session-store.db (much smaller bundle)")
    ex.set_defaults(func=cmd_export)

    ins = sub.add_parser("inspect", help="show a bundle's manifest and path prefixes")
    ins.add_argument("bundle")
    ins.set_defaults(func=cmd_inspect)

    im = sub.add_parser("import", help="restore a bundle onto this machine")
    im.add_argument("bundle")
    im.add_argument("--map", action="append", metavar="OLD=NEW",
                    help="rewrite path prefix; repeatable. Default: auto-detect")
    im.add_argument("--no-rewrite", action="store_true",
                    help="leave stored paths untouched")
    im.add_argument("--dry-run", action="store_true")
    im.set_defaults(func=cmd_import)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
