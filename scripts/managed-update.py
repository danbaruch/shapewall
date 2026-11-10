#!/usr/bin/env python3
"""Activate operator-prepared Shapewall releases; never download or build code.

Install root-owned as /usr/local/libexec/shapewall-managed-update. It runs
unprivileged and can change only the app user's installation pointers.
Configuration is fixed at /etc/shapewall/updater.json, not supplied by HTTP.
"""
import json
import os
from pathlib import Path
import re
import sys

CONFIG = Path('/etc/shapewall/updater.json')


def trusted(path, directory=False):
    path = Path(path)
    info = path.lstat()
    if path.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError('Update files must be root-owned and not writable by other users.')
    if directory and not path.is_dir():
        raise ValueError('Expected a release directory.')
    return path


def read_json(path):
    trusted(path)
    if path.stat().st_size > 8192:
        raise ValueError('Update metadata is too large.')
    return json.loads(path.read_text())


def immutable_release(candidate):
    # App code and dependencies must be immutable too, not just the metadata
    # advertising them. npm's internal executable symlinks may stay inside
    # this candidate; links to mutable data or another tree are refused.
    for path in [candidate, *candidate.rglob('*')]:
        info = path.lstat()
        if info.st_uid != 0:
            raise ValueError('Release contains files not owned by the operator.')
        if path.is_symlink():
            target = path.resolve(strict=True)
            if not target.is_relative_to(candidate):
                raise ValueError('Release link escapes the immutable candidate.')
        elif info.st_mode & 0o022:
            raise ValueError('Release contains writable code.')


def context():
    trusted(CONFIG.parent, directory=True)
    config = read_json(CONFIG)
    root = Path(config['installRoot'])
    if not root.is_absolute() or root.resolve() != root:
        raise ValueError('Invalid install root.')
    for parent in [root, *root.parents]:
        trusted(parent, directory=True)
    trusted(root / 'releases', directory=True)
    pointers = Path(config['pointerRoot'])
    if not pointers.is_absolute() or pointers.resolve() != pointers:
        raise ValueError('Invalid pointer directory.')
    pointer_info = pointers.lstat()
    if not pointers.is_dir() or pointer_info.st_uid != os.geteuid() or pointer_info.st_mode & 0o077:
        raise ValueError('Installation pointers must be private to the app user.')
    channel_file = root / 'update-channel.json'
    channel = read_json(channel_file)
    release = channel['release']
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', release):
        raise ValueError('Invalid release name.')
    candidate = trusted(root / 'releases' / release, directory=True)
    immutable_release(candidate)
    trusted(candidate / 'dist', directory=True)
    trusted(candidate / 'dist' / 'client', directory=True)
    metadata = read_json(candidate / 'dist' / 'client' / 'build-info.json')
    if not re.fullmatch(r'[a-f0-9]{7,40}', metadata.get('revision', '')):
        raise ValueError('Release has no verified revision.')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?', metadata.get('version', '')):
        raise ValueError('Release has no version.')
    current = (pointers / 'current').resolve(strict=True)
    if current.parent != root / 'releases':
        raise ValueError('Current release is outside the installation.')
    trusted(current, directory=True)
    return pointers, candidate, current, {k: metadata[k] for k in ['version', 'revision']}


def replace_link(root, name, target):
    temporary = root / ('.' + name + '-update-' + str(os.getpid()))
    temporary.symlink_to(target)
    try:
        temporary.replace(root / name)
    finally:
        temporary.unlink(missing_ok=True)


def run(action):
    pointers, candidate, current, latest = context()
    running = os.environ.get('SHAPEWALL_RUNNING_REVISION', '')
    if not re.fullmatch(r'[a-f0-9]{7,40}', running):
        raise ValueError('The running application revision is required.')
    available = running != latest['revision']
    if action == 'check' or not available:
        return {'latest': latest, 'updateAvailable': available}
    if action != 'apply':
        raise ValueError('Unknown update action.')
    import fcntl
    with (pointers / '.update.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Revalidate after acquiring the lock; only the operator can change
        # the prepared channel, but another update may have finished.
        pointers, candidate, current, latest = context()
        if candidate != current:
            replace_link(pointers, 'previous', current)
            try:
                replace_link(pointers, 'current', candidate)
            except Exception:
                replace_link(pointers, 'current', current)
                raise
    # The app acknowledges the request, then exits with 75. Its existing
    # Restart=on-failure service loads current. No elevated helper, timer,
    # new daemon or permission to restart other services is required.
    return {'latest': latest, 'updateAvailable': True, 'restartRequired': True}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in ['check', 'apply']:
            raise ValueError('Use the operator-installed update helper.')
        print(json.dumps(run(sys.argv[1])))
    except Exception:
        # Never echo paths, environment variables or subprocess stderr to a
        # browser. Detailed operator diagnosis belongs on the machine.
        print(json.dumps({'error': 'Managed update failed. Ask the installation owner to check the prepared release.'}))
        sys.exit(1)
