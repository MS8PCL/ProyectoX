#!/usr/bin/env python3
"""Offline, stdlib-only PocketBase -> desktop revision-1 migration.

Stop PocketBase before exporting. First mirror DB + WAL byte-for-byte into a
private directory and verify fingerprints, then open that mirror with mode=ro
and use SQLite backup to make the consistent snapshot (never immutable=1, which
can silently ignore WAL). SQLite NEVER opens originals: even a mode=ro connection
can modify/create the source SHM. DB/WAL/SHM fingerprints are checked before and
after; any observed change aborts, not a claim of equality. This cannot exclude a
writer starting after the final check; do not run against a live server.

--dry-run needs no destination and prints ONLY collection counts/missing counts.
--source accepts pb_data or data.db. Without it, exactly one known ancestor
pb_data/backup_portable/pb_data must exist; ambiguous sources require selection.
--destination must be an existing empty local/UNC directory, disjoint from source.
Within this repository use an existing empty subdirectory of desktop/runtime-data
or desktop/artifacts (already ignored); no ignore/config/GUI files are changed.

Only schema-declared record files are copied, not thumbnails/orphans/system
storage. _desktopFiles maps field -> [{fileName, relativePath, size, sha256}],
relative to the desktop root, under pocketbase-storage/collectionID/recordID/.
DocumentApi is not implemented here. State/manifest contain business PII: protect
output with appropriate ACLs; stdout/errors never include row values/file names.
Files are staged in a unique sibling directory. No-replace publication promotes
state.json LAST. Failure rolls back only files created by this invocation; a
process/power crash may leave an incomplete root WITHOUT state.json. Never resume
by overwriting it: inspect/clean manually and use a fresh empty destination.
"""
from __future__ import annotations

import argparse
import copy
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import sys
import tempfile
import time


class MigrationError(Exception):
    """A privacy-safe, actionable migration failure."""


PROJECT_ROOT = Path(__file__).resolve().parents[2]
RESERVED = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"} | {
    f"{prefix}{number}" for prefix in ("COM", "LPT") for number in range(1, 10)
}


def component(value):
    if (not isinstance(value, str) or not value or value in (".", "..")
            or any(ord(c) < 32 or c in '<>:"/\\|?*' for c in value)
            or value.endswith((".", " "))
            or value.split(".", 1)[0].upper() in RESERVED
            or value.split(".", 1)[0].upper() in {"COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³"}):
        raise MigrationError("Unsafe storage/collection path component; migration refused.")
    return value


def no_links(path):
    """Reject symlinks and Windows junctions/reparse points, including ancestors."""
    path = Path(os.path.abspath(path))
    for entry in (path, *path.parents):
        try:
            info = entry.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise MigrationError("Symlink/reparse point encountered; migration refused.")
    return path


def overlaps(a, b):
    return a == b or a in b.parents or b in a.parents


def source_path(source=None):
    if source is None:
        found = set()
        for parent in PROJECT_ROOT.parents:
            for relative in ("pb_data", "backup_portable/pb_data"):
                candidate = parent / relative
                if (candidate / "data.db").is_file():
                    found.add(candidate)
        if len(found) != 1:
            raise MigrationError("Specify --source: no unique source detected (none or multiple).")
        source = found.pop()
    path = no_links(Path(source))
    if path.is_file():
        if path.name != "data.db":
            raise MigrationError("Source database must be named data.db.")
        path = path.parent
    if not path.is_dir() or not no_links(path / "data.db").is_file():
        raise MigrationError("Source must contain a regular data.db.")
    return path.resolve()


def destination_path(destination, source):
    path = no_links(Path(destination))
    if not path.is_dir():
        raise MigrationError("Destination must be an existing empty directory.")
    path = path.resolve()
    if overlaps(path, source):
        raise MigrationError("Source and destination must not overlap.")
    if path == PROJECT_ROOT or PROJECT_ROOT in path.parents:
        allowed = (PROJECT_ROOT / "desktop/runtime-data", PROJECT_ROOT / "desktop/artifacts")
        if not any(root in path.parents for root in allowed):
            raise MigrationError("Repository output must use an ignored desktop runtime subdirectory.")
    if any(path.iterdir()):
        raise MigrationError("Destination is not empty; nothing will be overwritten.")
    return path


def sha256(path):
    no_links(path)
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_stamp(path):
    no_links(path)
    try:
        info = path.stat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode):
        raise MigrationError("Expected a regular source file.")
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def fingerprint(source):
    result = {}
    for name in ("data.db", "data.db-wal", "data.db-shm", "data.db-journal"):
        path = source / name
        before = file_stamp(path)
        digest = sha256(path) if before else None
        if file_stamp(path) != before:
            raise MigrationError("Source changed during fingerprinting; stop PocketBase and retry.")
        result[name] = {"stat": before, "sha256": digest}
    return result


def ensure_unchanged(source, before):
    if fingerprint(source) != before:
        raise MigrationError("Source changed; stop PocketBase and retry. No state published.")


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def secret_key(key):
    normalized = re.sub(r"[^a-z0-9]", "", key.lower())
    return (any(part in normalized for part in ("password", "token", "secret"))
            or normalized in {"apikey", "accesskey", "privatekey", "signingkey", "encryptionkey",
                              "authkey", "credentials", "credential", "passhash",
                              "otp", "otpcode", "otpseed", "mfa", "mfaenabled", "mfasecret",
                              "totp", "totpseed", "totpsecret", "recoverycodes", "backupcodes"}
            or normalized.startswith(("otp", "mfa", "totp")))


def scrub(value):
    if isinstance(value, dict):
        return {key: scrub(item) for key, item in value.items() if not secret_key(key)}
    if isinstance(value, list):
        return [scrub(item) for item in value]
    if isinstance(value, bytes):
        raise MigrationError("Unsupported binary business field; migration refused without data loss.")
    return value


def decode(value):
    if isinstance(value, str) and value:
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            raise MigrationError("Invalid schema-declared JSON field.") from None
    return value


def fields_for(collection):
    fields = decode(collection.get("fields") or collection.get("schema") or "[]")
    if not isinstance(fields, list) or any(not isinstance(f, dict) or not isinstance(f.get("name"), str) for f in fields):
        raise MigrationError("Invalid PocketBase collection schema.")
    return {f["name"]: f for f in fields}


def file_names(value):
    if value is None or value == "":
        return []
    if isinstance(value, str) and value.startswith("["):
        value = decode(value)
    names = value if isinstance(value, list) else [value]
    for name in names:
        component(name)
    if len(set(names)) != len(names):
        raise MigrationError("Duplicate record file name.")
    return names


def string_values(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from string_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from string_values(item)


def export_snapshot(db, source):
    db.row_factory = sqlite3.Row
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view')")}
    if "_collections" not in tables:
        raise MigrationError("Source is not a PocketBase database (_collections missing).")
    collections = [dict(row) for row in db.execute('SELECT * FROM "_collections"')]
    if not collections:
        raise MigrationError("PocketBase collection metadata is empty.")
    data, counts, jobs, missing = {}, {}, {}, 0
    users = None
    known = set()
    for collection in collections:
        name = collection.get("name")
        component(name)
        if name in known:
            raise MigrationError("Duplicate collection metadata.")
        known.add(name)
        if name.startswith("_") or name in {"logs", "params"}:
            continue
        if name not in tables:
            raise MigrationError("A registered collection table is missing.")
        kind = collection.get("type")
        if kind not in {"base", "auth", "view"}:
            raise MigrationError("Unsupported PocketBase collection type.")
        fields = fields_for(collection)
        if kind == "auth":
            if name == "users":
                users = [dict(row) for row in db.execute(f"SELECT * FROM {quote(name)}")]
            continue
        collection_id = component(collection.get("id"))
        rows = []
        for row in db.execute(f"SELECT * FROM {quote(name)} ORDER BY id"):
            record = dict(row)
            record_id = component(record.get("id"))
            if "_desktopFiles" in record:
                raise MigrationError("Reserved _desktopFiles field already exists.")
            mapping = {}
            for field, definition in fields.items():
                if field not in record:
                    continue
                field_type = definition.get("type")
                if secret_key(field) or field_type in {"password", "secret", "token", "otp", "mfa"}:
                    record.pop(field, None)
                    continue
                if field_type in {"json", "array"}:
                    record[field] = decode(record[field])
                elif field_type == "file":
                    entries = []
                    for filename in file_names(record[field]):
                        relative = Path("pocketbase-storage") / collection_id / record_id / filename
                        origin = source / "storage" / collection_id / record_id / filename
                        no_links(origin)
                        if not origin.exists():
                            missing += 1
                            continue
                        stamp = file_stamp(origin)
                        digest = sha256(origin)
                        if stamp != file_stamp(origin):
                            raise MigrationError("Source document changed during inspection.")
                        entry = {"fileName": filename, "relativePath": relative.as_posix(),
                                 "size": stamp[2], "sha256": digest}
                        entries.append(entry)
                        key = relative.as_posix()
                        if key in jobs and jobs[key][1] != entry:
                            raise MigrationError("Storage file collision.")
                        jobs[key] = (origin, entry, stamp)
                    mapping[field] = entries
            record = scrub(record)
            if mapping:
                record["_desktopFiles"] = mapping
            rows.append(record)
        data[name] = rows
        counts[name] = len(rows)
    unknown = tables - known
    if any(not name.startswith(("_", "sqlite_")) and name not in {"logs", "params"} for name in unknown):
        raise MigrationError("Unregistered business table found; refusing silent omission.")
    if users is not None:
        referenced = set(string_values(data))
        safe = [{key: row[key] for key in ("id", "email", "corpRole", "name") if key in row}
                for row in users if row.get("id") in referenced]
        if safe:
            data["users"] = safe
            counts["users"] = len(safe)
    # Keep all original profile fields; merge both aliases deterministically by ID.
    canonical = {row["id"]: copy.deepcopy(row) for row in data.get("candidates", [])}
    for row in data.get("candidate_profiles", []):
        existing = canonical.setdefault(row["id"], {})
        for field, value in row.items():
            if field in existing and existing[field] != value:
                raise MigrationError("Conflicting candidate aliases; manual reconciliation required.")
            existing[field] = copy.deepcopy(value)
    data["candidates"] = list(canonical.values())
    data["candidate_profiles"] = copy.deepcopy(data["candidates"])
    for required in ("listings", "applications", "audit_log"):
        data.setdefault(required, [])
    data["_operations"] = {}
    if "_migration" in data:
        raise MigrationError("Reserved migration metadata collision.")
    return data, counts, jobs, missing


def write_json(path, value):
    with open(path, "x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def copy_document(origin, target, entry, stamp):
    no_links(origin)
    if file_stamp(origin) != stamp:
        raise MigrationError("Source document changed before copying.")
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(origin, "rb") as incoming, open(target, "xb") as outgoing:
        shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
        outgoing.flush()
        os.fsync(outgoing.fileno())
    if (file_stamp(origin) != stamp or target.stat().st_size != entry["size"]
            or sha256(origin) != entry["sha256"] or sha256(target) != entry["sha256"]):
        raise MigrationError("Document verification failed; no state published.")


def publish_file(source, target):
    # Windows rename is atomic and refuses an existing target (also on UNC).
    # POSIX rename can overwrite; link is the atomic no-replace equivalent.
    no_links(target)
    if os.name == "nt":
        os.rename(source, target)
    else:
        os.link(source, target)
        source.unlink()


def promote(stage, destination):
    if any(destination.iterdir()):
        raise MigrationError("Destination changed while staging; no state published.")
    created_files, created_dirs = [], []
    try:
        for directory in sorted((p for p in stage.rglob("*") if p.is_dir()), key=lambda p: len(p.parts)):
            target = destination / directory.relative_to(stage)
            no_links(target)
            target.mkdir()  # no exist_ok: never adopt another writer's directory
            created_dirs.append(target)
        # A business file may also be named state.json; only the root state is last.
        files = sorted(p for p in stage.rglob("*") if p.is_file() and p != stage / "state.json")
        files.append(stage / "state.json")
        for path in files:
            target = destination / path.relative_to(stage)
            publish_file(path, target)
            created_files.append(target)
    except BaseException:
        for path in reversed(created_files):
            path.unlink()
        for path in reversed(created_dirs):
            try:
                path.rmdir()
            except OSError:
                pass  # Never remove another process's files.
        raise


def migrate(source=None, destination=None, dry_run=False):
    source = source_path(source)
    if not dry_run and destination is None:
        raise MigrationError("--destination is required unless --dry-run is used.")
    destination = destination_path(destination, source) if destination is not None else None
    before = fingerprint(source)
    if before["data.db-journal"]["stat"] and before["data.db-journal"]["stat"][2]:
        raise MigrationError("Rollback journal present; stop/recover PocketBase before migrating.")
    with tempfile.TemporaryDirectory(prefix="proyecto-x-pb-snapshot-") as private:
        private = no_links(Path(private))
        if overlaps(private, source):
            raise MigrationError("Private snapshot directory must be outside the source.")
        mirror = private / "input"
        mirror.mkdir()
        for name in ("data.db", "data.db-wal"):
            if before[name]["stat"] is None:
                continue
            with open(source / name, "rb") as incoming, open(mirror / name, "xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
            if sha256(mirror / name) != before[name]["sha256"]:
                raise MigrationError("Source changed while mirroring; stop PocketBase and retry.")
        ensure_unchanged(source, before)
        snapshot = private / "snapshot.db"
        start = time.monotonic()
        def progress(status, remaining, total):
            if time.monotonic() - start > 30:
                raise MigrationError("Snapshot timed out; stop PocketBase and retry.")
        # Read-only URI against the verified mirror; any SHM writes stay private.
        # Not immutable: committed WAL must participate in the backup API.
        with closing(sqlite3.connect((mirror / "data.db").as_uri() + "?mode=ro", uri=True, timeout=5)) as live:
            with closing(sqlite3.connect(snapshot)) as db:
                live.backup(db, pages=256, progress=progress, sleep=0.05)
        ensure_unchanged(source, before)
        snapshot_hash = sha256(snapshot)
        with closing(sqlite3.connect(snapshot.as_uri() + "?mode=ro", uri=True)) as db:
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise MigrationError("Private database snapshot failed integrity check.")
            data, counts, jobs, missing = export_snapshot(db, source)
        ensure_unchanged(source, before)
        report = {"collectionCounts": counts, "missingFiles": missing}
        if dry_run:
            return report
        if missing:
            raise MigrationError(f"Missing record files: {missing}; no state published.")
        timestamp = datetime.now(timezone.utc).isoformat()
        metadata = {"formatVersion": 1, "tool": "migrate-pocketbase", "timestampUtc": timestamp,
                    "snapshotSha256": snapshot_hash, "sourceDatabaseSha256Before": before["data.db"]["sha256"],
                    "sourceDatabaseSha256After": before["data.db"]["sha256"],
                    "sourceUnchanged": True, "sourceWalSha256": before["data.db-wal"]["sha256"]}
        data["_migration"] = metadata
        if "audit" in data and not isinstance(data["audit"], list):
            raise MigrationError("Business audit is not an array; refusing to overwrite it.")
        data.setdefault("audit", []).append({"revision": 1, "actorHash": hashlib.sha256(b"pocketbase-migration").hexdigest(),
                                             "timestampUtc": timestamp, "migration": copy.deepcopy(metadata)})
        with tempfile.TemporaryDirectory(prefix=".desktop-migration-", dir=destination.parent) as staging:
            stage = Path(staging)
            for relative, (origin, entry, stamp) in jobs.items():
                copy_document(origin, stage / relative, entry, stamp)
            state = stage / "state.json"
            write_json(state, {"revision": 1, "data": data})
            ensure_unchanged(source, before)
            for origin, entry, stamp in jobs.values():
                if file_stamp(origin) != stamp or sha256(origin) != entry["sha256"]:
                    raise MigrationError("Source document changed; no state published.")
            manifest = {**metadata, "collectionCounts": counts,
                        "outputCollectionCounts": {k: len(v) for k, v in data.items() if isinstance(v, list)},
                        "fileCount": len(jobs), "fileBytes": sum(e[1]["size"] for e in jobs.values()),
                        "files": [e[1] for e in jobs.values()], "stateSha256": sha256(state),
                        "missingFiles": 0, "storagePolicy": "schema-listed-record-files-only"}
            write_json(stage / "migration-manifest.json", manifest)
            # Revalidate root and emptiness immediately before no-replace publication.
            destination_path(destination, source)
            ensure_unchanged(source, before)
            promote(stage, destination)
        return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--destination", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    try:
        report = migrate(args.source, args.destination, args.dry_run)
        print(json.dumps(report, sort_keys=True, ensure_ascii=True))
        return 1 if report["missingFiles"] else 0
    except MigrationError as error:
        print(f"Migration refused: {error}", file=sys.stderr)
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
        # Raw SQLite/OS errors may disclose PII in paths or values.
        print("Migration failed (database/schema/filesystem error); no success claimed. Inspect destination before retrying.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
