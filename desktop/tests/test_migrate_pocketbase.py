"""Synthetic SQLite/storage fixtures only; never read the project's real pb_data.

Run: python -m unittest discover -s desktop/tests -p test_migrate_pocketbase.py -v
All source/destination/snapshot/staging data lives in OS temporary directories.
"""
from contextlib import closing, redirect_stdout, redirect_stderr
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "migrate-pocketbase.py"
SPEC = importlib.util.spec_from_file_location("migrate_pocketbase", SCRIPT)
migration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="test-pb-migration-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "pb_data"
        self.source.mkdir()
        self.destination = self.root / "desktop-output"
        self.destination.mkdir()
        self.database = self.source / "data.db"
        with closing(sqlite3.connect(self.database)) as db:
            db.execute('CREATE TABLE _collections (id TEXT PRIMARY KEY, name TEXT, type TEXT, fields TEXT)')
            db.execute('CREATE TABLE _params (id TEXT, value TEXT)')
            db.execute('INSERT INTO _params VALUES (?, ?)', ("secret", "SYSTEM_SECRET_NOT_EXPORTED"))
            db.execute('CREATE TABLE _logs (message TEXT)')
            db.execute('INSERT INTO _logs VALUES (?)', ("LOG_SECRET_NOT_EXPORTED",))
            self.collection(db, "users", "auth_users", {
                "id": "TEXT PRIMARY KEY", "email": "TEXT", "corpRole": "TEXT", "name": "TEXT",
                "password": "TEXT", "tokenKey": "TEXT", "otp": "TEXT", "mfa": "TEXT", "extra": "TEXT"
            }, [], "auth")
            db.executemany('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)', [
                ("user001", "private@example.invalid", "recruiter", "Private Person", "PASSWORD_SECRET", "TOKEN_SECRET", "OTP_SECRET", "MFA_SECRET", "NOT_SAFE"),
                ("unused002", "unused@example.invalid", "admin", "Unused Person", "secret", "secret", "secret", "secret", "extra")
            ])
            self.collection(db, "staff", "auth_staff", {"id": "TEXT", "email": "TEXT", "password": "TEXT"}, [], "auth")
            db.execute('INSERT INTO staff VALUES (?,?,?)', ("staff001", "staff@example.invalid", "STAFF_SECRET"))
            self.collection(db, "listings", "listings_id", {
                "id": "TEXT PRIMARY KEY", "ownerUserId": "TEXT", "title": "TEXT", "tags": "TEXT",
                "selection": "TEXT", "settings": "TEXT", "refreshToken": "TEXT", "credential": "TEXT"
            }, [{"name": "tags", "type": "json"}, {"name": "settings", "type": "json"},
                {"name": "selection", "type": "select"}, {"name": "credential", "type": "password"}])
            db.execute('INSERT INTO listings VALUES (?,?,?,?,?,?,?,?)', (
                "listing001", "user001", "[text is NOT JSON]", '["python","sql"]', '["a","b"]',
                '{"nested":{"password":"NESTED_SECRET","keep":5},"apiToken":"JSON_SECRET"}', "REFRESH_SECRET", "CREDENTIAL_SECRET"))
            self.collection(db, "candidate_profiles", "profiles_id", {
                "id": "TEXT PRIMARY KEY", "userId": "TEXT", "name": "TEXT", "skills": "TEXT", "custom": "TEXT"
            }, [{"name": "skills", "type": "array"}])
            db.execute('INSERT INTO candidate_profiles VALUES (?,?,?,?,?)', ("profile001", "user001", "Candidate", '["C#"]', "keep unknown"))
            self.collection(db, "applications", "applications_id", {
                "id": "TEXT PRIMARY KEY", "candidateUserId": "TEXT", "listingId": "TEXT", "stage": "TEXT"
            }, [])
            db.execute('INSERT INTO applications VALUES (?,?,?,?)', ("application001", "profile001", "listing001", "nuevo"))
            self.collection(db, "profile_imports", "imports_storage_id", {
                "id": "TEXT PRIMARY KEY", "userId": "TEXT", "applicationId": "TEXT", "file": "TEXT", "attachments": "TEXT", "kind": "TEXT"
            }, [{"name": "file", "type": "file"}, {"name": "attachments", "type": "file"}])
            db.execute('INSERT INTO profile_imports VALUES (?,?,?,?,?,?)', (
                "import001", "user001", "application001", "opaque_cv.pdf", '["opaque_1.txt","state.json"]', "cv"))
            for name in ("audit_log", "departments", "integration_outbox", "custom_business"):
                self.collection(db, name, name + "_id", {"id": "TEXT PRIMARY KEY", "value": "TEXT"}, [])
                db.execute(f'INSERT INTO "{name}" VALUES (?,?)', (name + "001", "unchanged"))
            db.commit()
        self.storage = self.source / "storage" / "imports_storage_id" / "import001"
        self.storage.mkdir(parents=True)
        for name, content in {"opaque_cv.pdf": b"%PDF synthetic\x00\xff", "opaque_1.txt": b"synthetic document", "state.json": b"business attachment"}.items():
            (self.storage / name).write_bytes(content)
        (self.storage / "orphan.txt").write_bytes(b"never copy orphan")
        self.original = self.source_bytes()

    @staticmethod
    def collection(db, name, identifier, columns, fields, kind="base", schema_column="fields"):
        db.execute(f'CREATE TABLE "{name}" (' + ','.join(f'"{k}" {v}' for k, v in columns.items()) + ')')
        db.execute(f'INSERT INTO _collections (id,name,type,"{schema_column}") VALUES (?,?,?,?)',
                   (identifier, name, kind, json.dumps(fields)))

    def source_bytes(self):
        return {p.relative_to(self.source).as_posix(): p.read_bytes() for p in self.source.rglob("*") if p.is_file()}

    def update(self, sql, args=()):
        with closing(sqlite3.connect(self.database)) as db:
            db.execute(sql, args)
            db.commit()

    def run_migration(self):
        return migration.migrate(self.source, self.destination)

    def state(self):
        return json.loads((self.destination / "state.json").read_text(encoding="utf-8"))

    def assert_empty_destination(self):
        self.assertEqual(list(self.destination.iterdir()), [])
        self.assertEqual(list(self.root.glob(".desktop-migration-*")), [])

    def test_preserves_all_business_collections_and_source_bytes(self):
        report = self.run_migration()
        state = self.state()
        self.assertEqual(state["revision"], 1)
        data = state["data"]
        for name in ("listings", "applications", "audit_log", "departments", "integration_outbox", "custom_business", "profile_imports"):
            self.assertEqual(len(data[name]), 1)
            self.assertEqual(report["collectionCounts"][name], 1)
        self.assertEqual(data["candidates"], data["candidate_profiles"])
        self.assertEqual(data["candidates"][0]["id"], "profile001")
        self.assertEqual(data["candidates"][0]["custom"], "keep unknown")
        self.assertEqual(data["applications"][0]["candidateUserId"], "profile001")
        self.assertEqual(data["listings"][0]["tags"], ["python", "sql"])
        self.assertEqual(data["candidates"][0]["skills"], ["C#"])
        self.assertEqual(data["listings"][0]["title"], "[text is NOT JSON]")
        self.assertEqual(data["listings"][0]["selection"], '["a","b"]')
        self.assertEqual(data["listings"][0]["settings"], {"nested": {"keep": 5}})
        self.assertEqual(self.source_bytes(), self.original)
        self.assertEqual(data["audit"][0]["revision"], 1)
        self.assertEqual(data["_operations"], {})

    def test_auth_allowlist_only_referenced_users_and_no_secrets(self):
        self.run_migration()
        data = self.state()["data"]
        self.assertEqual(data["users"], [{"id": "user001", "email": "private@example.invalid", "corpRole": "recruiter", "name": "Private Person"}])
        self.assertNotIn("staff", data)
        self.assertNotIn("_params", data)
        self.assertNotIn("_logs", data)
        text = json.dumps(data)
        for value in ("SYSTEM_SECRET", "LOG_SECRET", "PASSWORD_SECRET", "TOKEN_SECRET", "OTP_SECRET", "MFA_SECRET", "NESTED_SECRET", "JSON_SECRET", "REFRESH_SECRET", "CREDENTIAL_SECRET", "unused@example.invalid", "STAFF_SECRET"):
            self.assertNotIn(value, text)

    def test_unreferenced_users_are_not_exported(self):
        for table, field in (("listings", "ownerUserId"), ("candidate_profiles", "userId"), ("profile_imports", "userId")):
            self.update(f'UPDATE "{table}" SET "{field}" = ?', ("",))
        self.run_migration()
        self.assertNotIn("users", self.state()["data"])

    def test_file_paths_mapping_sizes_hashes_and_manifest(self):
        self.run_migration()
        mapping = self.state()["data"]["profile_imports"][0]["_desktopFiles"]
        self.assertEqual(set(mapping), {"file", "attachments"})
        entries = mapping["file"] + mapping["attachments"]
        self.assertEqual(len(entries), 3)
        for entry in entries:
            path = self.destination / entry["relativePath"]
            expected = self.storage / entry["fileName"]
            self.assertEqual(path.read_bytes(), expected.read_bytes())
            self.assertEqual(entry["relativePath"], "pocketbase-storage/imports_storage_id/import001/" + entry["fileName"])
            self.assertEqual(entry["size"], len(expected.read_bytes()))
            self.assertEqual(entry["sha256"], hashlib.sha256(expected.read_bytes()).hexdigest())
        self.assertFalse(any(self.destination.rglob("orphan.txt")))
        manifest = json.loads((self.destination / "migration-manifest.json").read_text())
        self.assertEqual(manifest["fileCount"], 3)
        self.assertEqual(manifest["fileBytes"], sum(e["size"] for e in entries))
        digest = hashlib.sha256(self.original["data.db"]).hexdigest()
        self.assertEqual(manifest["sourceDatabaseSha256Before"], digest)
        self.assertEqual(manifest["sourceDatabaseSha256After"], digest)
        self.assertEqual(manifest["stateSha256"], migration.sha256(self.destination / "state.json"))
        self.assertEqual(len(manifest["snapshotSha256"]), 64)
        self.assertTrue(manifest["sourceUnchanged"])

    def test_dry_run_no_destination_no_pii_or_writes(self):
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            code = migration.main(["--source", str(self.source), "--dry-run"])
        self.assertEqual(code, 0, errors.getvalue())
        report = json.loads(output.getvalue())
        self.assertEqual(set(report), {"collectionCounts", "missingFiles"})
        self.assertEqual(report["missingFiles"], 0)
        for sensitive in ("private@example.invalid", "Private Person", "opaque_cv.pdf", "user001"):
            self.assertNotIn(sensitive, output.getvalue() + errors.getvalue())
        self.assertEqual(self.source_bytes(), self.original)
        self.assert_empty_destination()

    def test_missing_files_reported_in_dry_run_and_export_fails_without_state(self):
        (self.storage / "opaque_cv.pdf").unlink()
        report = migration.migrate(self.source, dry_run=True)
        self.assertEqual(report["missingFiles"], 1)
        with self.assertRaisesRegex(migration.MigrationError, "Missing record files: 1"):
            self.run_migration()
        self.assert_empty_destination()
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(migration.main(["--source", str(self.source), "--dry-run"]), 1)
        self.assertNotIn("opaque_cv", output.getvalue())

    def test_nonempty_destination_not_modified(self):
        existing = self.destination / "state.json"
        existing.write_bytes(b"original desktop state")
        with self.assertRaisesRegex(migration.MigrationError, "not empty"):
            self.run_migration()
        self.assertEqual(existing.read_bytes(), b"original desktop state")
        self.assertEqual(self.source_bytes(), self.original)

    def test_overlap_missing_destination_and_project_root_rejected(self):
        nested = self.source / "empty"
        nested.mkdir()
        for target in (self.source, self.root, nested, migration.PROJECT_ROOT, self.root / "absent"):
            with self.subTest(target=target), self.assertRaises(migration.MigrationError):
                migration.migrate(self.source, target)
        with self.assertRaisesRegex(migration.MigrationError, "destination"):
            migration.migrate(self.source)
        self.assert_empty_destination()

    def test_traversal_ads_reserved_and_invalid_filename_rejected(self):
        for value in ("../escape.pdf", "..\\escape.pdf", "/absolute.pdf", "C:\\file.pdf", "cv.pdf:secret", "CON.pdf", "LPT1", "COM¹.pdf", "file.", "file ", "a\x00b", "x/y.pdf", "a?b"):
            with self.subTest(value=value):
                self.update('UPDATE profile_imports SET file = ?', (value,))
                with self.assertRaises(migration.MigrationError):
                    self.run_migration()
                self.assert_empty_destination()
        self.assertFalse((self.root / "escape.pdf").exists())

    def test_collection_and_record_id_traversal_rejected(self):
        for sql in ('UPDATE _collections SET id = \'../evil\' WHERE name = \'profile_imports\'',
                    'UPDATE profile_imports SET id = \'../evil\''):
            with self.subTest(sql=sql):
                self.update(sql)
                with self.assertRaises(migration.MigrationError):
                    self.run_migration()
                self.assert_empty_destination()

    def make_link(self, target, link, directory=False):
        try:
            link.symlink_to(target, target_is_directory=directory)
        except (OSError, NotImplementedError):
            self.skipTest("Symlink creation requires Windows developer mode/privilege")

    def test_source_symlink_rejected(self):
        link = self.root / "linked-source"
        self.make_link(self.source, link, True)
        with self.assertRaisesRegex(migration.MigrationError, "Symlink"):
            migration.migrate(link, self.destination)
        self.assert_empty_destination()

    def test_destination_symlink_rejected(self):
        link = self.root / "linked-destination"
        self.make_link(self.destination, link, True)
        with self.assertRaisesRegex(migration.MigrationError, "Symlink"):
            migration.migrate(self.source, link)
        self.assert_empty_destination()

    def test_storage_file_symlink_rejected(self):
        attachment = self.storage / "opaque_cv.pdf"
        attachment.unlink()
        external = self.root / "external.pdf"
        external.write_bytes(b"external do not copy")
        self.make_link(external, attachment)
        with self.assertRaisesRegex(migration.MigrationError, "Symlink"):
            self.run_migration()
        self.assert_empty_destination()

    def test_storage_ancestor_symlink_rejected(self):
        moved = self.root / "external-storage"
        self.storage.rename(moved)
        self.make_link(moved, self.storage, True)
        with self.assertRaisesRegex(migration.MigrationError, "Symlink"):
            self.run_migration()
        self.assert_empty_destination()

    def test_invalid_source_and_schema_rejected(self):
        invalid = self.root / "invalid"
        invalid.mkdir()
        with self.assertRaises(migration.MigrationError):
            migration.migrate(invalid, self.destination)
        (invalid / "data.db").write_bytes(b"not a database")
        errors = io.StringIO()
        with redirect_stderr(errors):
            self.assertEqual(migration.main(["--source", str(invalid), "--destination", str(self.destination)]), 1)
        self.assertNotIn(str(invalid), errors.getvalue())
        (invalid / "data.db").unlink()
        with closing(sqlite3.connect(invalid / "data.db")) as db:
            db.execute("CREATE TABLE something (id TEXT)")
        with self.assertRaisesRegex(migration.MigrationError, "not a PocketBase"):
            migration.migrate(invalid, self.destination)
        self.assert_empty_destination()

    def test_old_schema_column_supported(self):
        self.update('ALTER TABLE _collections RENAME COLUMN fields TO schema')
        self.run_migration()
        self.assertEqual(self.state()["data"]["listings"][0]["tags"], ["python", "sql"])

    def test_invalid_json_and_unregistered_tables_fail_without_silent_loss(self):
        self.update('UPDATE listings SET tags = ?', ("not json",))
        with self.assertRaisesRegex(migration.MigrationError, "JSON"):
            self.run_migration()
        self.update('UPDATE listings SET tags = ?', ('[]',))
        self.update('CREATE TABLE unregistered_business (id TEXT)')
        with self.assertRaisesRegex(migration.MigrationError, "Unregistered"):
            self.run_migration()
        self.assert_empty_destination()

    def test_snapshot_private_mirror_readonly_and_original_never_opened_by_sqlite(self):
        original_connect = sqlite3.connect
        uris = []
        def connect(database, *args, **kwargs):
            uris.append(str(database))
            return original_connect(database, *args, **kwargs)
        original_export = migration.export_snapshot
        def export(db, source):
            private_path = Path(db.execute('PRAGMA database_list').fetchone()[2])
            self.assertNotEqual(private_path, self.database)
            self.assertNotIn(self.source, private_path.parents)
            self.assertNotIn(self.destination, private_path.parents)
            return original_export(db, source)
        with mock.patch.object(migration.sqlite3, "connect", side_effect=connect), mock.patch.object(migration, "export_snapshot", side_effect=export):
            self.run_migration()
        original_connections = [uri for uri in uris if self.database.as_uri() in uri]
        self.assertEqual(original_connections, [])
        mirror_connections = [uri for uri in uris if "/input/data.db?mode=ro" in uri]
        self.assertEqual(len(mirror_connections), 1)
        self.assertEqual(self.source_bytes(), self.original)

    def test_auto_source_detection_requires_selection_if_backup_also_exists(self):
        fake_project = self.root / "repo" / "project"
        with mock.patch.object(migration, "PROJECT_ROOT", fake_project):
            self.assertEqual(migration.source_path(), self.source.resolve())
            backup = self.root / "backup_portable" / "pb_data"
            backup.mkdir(parents=True)
            (backup / "data.db").write_bytes(self.database.read_bytes())
            with self.assertRaisesRegex(migration.MigrationError, "no unique source"):
                migration.source_path()
        self.assert_empty_destination()

    def test_changes_during_raw_mirroring_aborted(self):
        original_copy = migration.shutil.copyfileobj
        def copy_and_change(incoming, outgoing, length):
            original_copy(incoming, outgoing, length)
            if Path(incoming.name) == self.database:
                self.update('UPDATE departments SET value = ?', ("concurrent update",))
        with mock.patch.object(migration.shutil, "copyfileobj", side_effect=copy_and_change):
            with self.assertRaisesRegex(migration.MigrationError, "Source changed"):
                self.run_migration()
        self.assert_empty_destination()

    def test_hot_rollback_journal_refused_without_opening_original(self):
        (self.source / "data.db-journal").write_bytes(b"possible hot journal")
        with self.assertRaisesRegex(migration.MigrationError, "Rollback journal"):
            self.run_migration()
        self.assert_empty_destination()

    def test_source_change_aborts_before_publication(self):
        original_export = migration.export_snapshot
        def export(db, source):
            result = original_export(db, source)
            self.update('UPDATE listings SET title = ?', ("writer changed source",))
            return result
        with mock.patch.object(migration, "export_snapshot", side_effect=export):
            with self.assertRaisesRegex(migration.MigrationError, "Source changed"):
                self.run_migration()
        self.assert_empty_destination()

    def test_document_corruption_aborts_and_removes_stage(self):
        original_copy = migration.copy_document
        def corrupt(origin, target, entry, stamp):
            origin.write_bytes(b"unexpected writer")
            original_copy(origin, target, entry, stamp)
        with mock.patch.object(migration, "copy_document", side_effect=corrupt):
            with self.assertRaisesRegex(migration.MigrationError, "changed"):
                self.run_migration()
        self.assert_empty_destination()

    def test_destination_checksum_is_verified(self):
        original_hash = migration.sha256
        def altered_hash(path):
            if ".desktop-migration-" in str(path) and Path(path).name == "opaque_cv.pdf":
                return "0" * 64
            return original_hash(path)
        with mock.patch.object(migration, "sha256", side_effect=altered_hash):
            with self.assertRaisesRegex(migration.MigrationError, "verification"):
                self.run_migration()
        self.assert_empty_destination()

    def test_state_is_published_last(self):
        published = []
        original_publish = migration.publish_file
        def publish(source, target):
            published.append(target.relative_to(self.destination).as_posix())
            if target == self.destination / "state.json":
                self.assertTrue((self.destination / "migration-manifest.json").is_file())
                self.assertTrue((self.destination / "pocketbase-storage/imports_storage_id/import001/opaque_cv.pdf").is_file())
            return original_publish(source, target)
        with mock.patch.object(migration, "publish_file", side_effect=publish):
            self.run_migration()
        self.assertEqual(published[-1], "state.json")
        self.assertIn("pocketbase-storage/imports_storage_id/import001/state.json", published[:-1])

    def test_failed_promotion_rolls_back_only_our_files(self):
        original_publish = migration.publish_file
        def publish(source, target):
            if target == self.destination / "state.json":
                raise OSError("simulated UNC publication failure")
            return original_publish(source, target)
        with mock.patch.object(migration, "publish_file", side_effect=publish):
            with self.assertRaises(OSError):
                self.run_migration()
        self.assert_empty_destination()
        self.assertEqual(self.source_bytes(), self.original)

    def test_no_replace_publication_preserves_existing_file(self):
        staged = self.root / "staged-file"
        staged.write_bytes(b"new")
        existing = self.destination / "state.json"
        existing.write_bytes(b"existing")
        with self.assertRaises(OSError):
            migration.publish_file(staged, existing)
        self.assertEqual(existing.read_bytes(), b"existing")
        self.assertEqual(staged.read_bytes(), b"new")

    def test_destination_race_not_adopted_or_deleted(self):
        original_promote = migration.promote
        marker = self.destination / "another-writer"
        def promote(stage, destination):
            marker.write_bytes(b"not ours")
            return original_promote(stage, destination)
        with mock.patch.object(migration, "promote", side_effect=promote):
            with self.assertRaisesRegex(migration.MigrationError, "changed"):
                self.run_migration()
        self.assertEqual(marker.read_bytes(), b"not ours")
        self.assertFalse((self.destination / "state.json").exists())

    def test_wal_committed_rows_included_without_stale_immutable_snapshot(self):
        with closing(sqlite3.connect(self.database)) as writer:
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('PRAGMA wal_autocheckpoint=0')
            writer.execute('INSERT INTO departments VALUES (?,?)', ("wal001", "committed WAL row"))
            writer.commit()
            self.assertTrue((self.source / "data.db-wal").stat().st_size > 0)
            original_db = self.database.read_bytes()
            original_wal = (self.source / "data.db-wal").read_bytes()
            original_tree = self.source_bytes()
            self.run_migration()
            self.assertEqual(self.source_bytes(), original_tree)
            self.assertEqual(self.database.read_bytes(), original_db)
            self.assertEqual((self.source / "data.db-wal").read_bytes(), original_wal)
            self.assertEqual(len(self.state()["data"]["departments"]), 2)
            with closing(sqlite3.connect(self.database.as_uri() + "?immutable=1", uri=True)) as stale:
                self.assertEqual(stale.execute('SELECT COUNT(*) FROM departments').fetchone()[0], 1)

    def test_candidate_alias_merge_preserves_fields_and_conflicts_fail(self):
        with closing(sqlite3.connect(self.database)) as db:
            self.collection(db, "candidates", "candidates_id", {"id": "TEXT PRIMARY KEY", "extraField": "TEXT"}, [])
            db.execute('INSERT INTO candidates VALUES (?,?)', ("profile001", "extra preserved"))
            db.commit()
        self.run_migration()
        self.assertEqual(self.state()["data"]["candidates"][0]["extraField"], "extra preserved")
        fresh = self.root / "fresh-output"
        fresh.mkdir()
        self.update('ALTER TABLE candidates ADD COLUMN name TEXT')
        self.update('UPDATE candidates SET name = ?', ("conflicting name",))
        with self.assertRaisesRegex(migration.MigrationError, "Conflicting candidate"):
            migration.migrate(self.source, fresh)
        self.assertEqual(list(fresh.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
