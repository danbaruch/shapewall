import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('updater', 'scripts/managed-update.py')
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        self.environ = patch.dict(os.environ, {'SHAPEWALL_RUNNING_REVISION': 'b' * 40})
        self.environ.start()

    def tearDown(self):
        self.environ.stop()

    def test_root_owned_directory_is_trusted(self):
        self.assertEqual(updater.trusted('/usr', directory=True), Path('/usr'))

    def test_symlink_and_writable_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'file'
            path.write_text('{}')
            path.chmod(0o666)
            with self.assertRaises(ValueError):
                updater.trusted(path)
            link = Path(folder) / 'link'
            link.symlink_to('/usr')
            with self.assertRaises(ValueError):
                updater.trusted(link)

    def fixture(self, folder):
        root = Path(folder)
        old = root / 'releases' / 'old'
        new = root / 'releases' / 'new'
        old.mkdir(parents=True)
        new.mkdir()
        (root / 'current').symlink_to(old)
        return root, new, old, {'version': '0.1.0', 'revision': 'a' * 40}

    def test_check_has_no_process_or_filesystem_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            context = self.fixture(folder)
            with patch.object(updater, 'context', return_value=context), patch.object(updater, 'replace_link') as replace:
                self.assertTrue(updater.run('check')['updateAvailable'])
                replace.assert_not_called()
                self.assertEqual((context[0] / 'current').resolve(), context[2])

    def test_apply_switches_only_app_pointers_and_requests_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            context = self.fixture(folder)
            with patch.object(updater, 'context', return_value=context):
                self.assertTrue(updater.run('apply')['restartRequired'])
                self.assertEqual((context[0] / 'current').resolve(), context[1])
                self.assertEqual((context[0] / 'previous').resolve(), context[2])

    def test_unknown_actions_are_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            context = self.fixture(folder)
            with patch.object(updater, 'context', return_value=context):
                with self.assertRaises(ValueError):
                    updater.run('download-any-url')

    def test_failed_pointer_change_preserves_current(self):
        with tempfile.TemporaryDirectory() as folder:
            context = self.fixture(folder)
            real_replace = updater.replace_link
            def replace(root, name, target):
                if name == 'current' and target == context[1]:
                    raise OSError('disk full')
                real_replace(root, name, target)
            with patch.object(updater, 'context', return_value=context), patch.object(updater, 'replace_link', side_effect=replace):
                with self.assertRaises(OSError):
                    updater.run('apply')
                self.assertEqual((context[0] / 'current').resolve(), context[2])

    def test_current_release_is_noop(self):
        with tempfile.TemporaryDirectory() as folder:
            root, candidate, _, latest = self.fixture(folder)
            with patch.dict(os.environ, {'SHAPEWALL_RUNNING_REVISION': 'a' * 40}), patch.object(updater, 'context', return_value=(root, candidate, candidate, latest)), patch.object(updater, 'replace_link') as replace:
                self.assertFalse(updater.run('apply')['updateAvailable'])
                replace.assert_not_called()

    def test_interrupted_update_is_available_and_restarts_without_losing_rollback(self):
        with tempfile.TemporaryDirectory() as folder:
            root, candidate, _, latest = self.fixture(folder)
            with patch.object(updater, 'context', return_value=(root, candidate, candidate, latest)), patch.object(updater, 'replace_link') as replace:
                self.assertTrue(updater.run('check')['updateAvailable'])
                self.assertTrue(updater.run('apply')['restartRequired'])
                replace.assert_not_called()

    def test_untrusted_release_code_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'untrusted-code').write_text('code')
            with self.assertRaises(ValueError):
                updater.immutable_release(root)

    def test_context_rejects_channel_traversal_and_current_escape(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            install = base / 'install'
            candidate = install / 'releases' / 'release-a'
            (candidate / 'dist' / 'client').mkdir(parents=True)
            (candidate / 'dist' / 'client' / 'build-info.json').write_text(json.dumps({'version': '0.1.0', 'revision': 'a' * 40}))
            pointers = base / 'pointers'
            pointers.mkdir(mode=0o700)
            (pointers / 'current').symlink_to(candidate)
            config = base / 'updater.json'
            config.write_text(json.dumps({'installRoot': str(install), 'pointerRoot': str(pointers)}))
            channel = install / 'update-channel.json'
            channel.write_text(json.dumps({'release': 'release-a'}))
            # Ownership enforcement is separately exercised above; this tests
            # the real config/path logic without requiring root in CI.
            with patch.object(updater, 'CONFIG', config), patch.object(updater, 'trusted', side_effect=lambda p, **_: Path(p)), patch.object(updater, 'immutable_release'):
                self.assertEqual(updater.context()[1], candidate)
                channel.write_text(json.dumps({'release': '../escape'}))
                with self.assertRaises(ValueError):
                    updater.context()
                channel.write_text(json.dumps({'release': 'release-a'}))
                (pointers / 'current').unlink()
                (pointers / 'current').symlink_to(base)
                with self.assertRaises(ValueError):
                    updater.context()


unittest.main()
