"""Extract once and verify every native payload file against its pinned archive."""
from pathlib import Path
import hashlib
import subprocess
import sys
import tarfile

archive_path, destination = map(Path, sys.argv[1:3])
if hashlib.sha256(archive_path.read_bytes()).hexdigest() != sys.argv[3]:
    raise RuntimeError('Native archive integrity mismatch')

with tarfile.open(archive_path) as archive:
    members = archive.getmembers()
    for member in members:
        if member.name.startswith('/') or '..' in Path(member.name).parts or not (member.isfile() or member.isdir()):
            raise RuntimeError(f'Unexpected native archive member: {member.name}')
    # Official payload directories are read-only: repeated extraction would fail
    # or replace immutable inputs. Verify an existing tree instead of repairing it.
    if not destination.exists():
        destination.mkdir(parents=True)
        subprocess.run(['/usr/bin/tar', '-xf', str(archive_path), '-C', str(destination)], check=True)
    for member in members:
        target = destination / member.name
        if target.is_symlink() or not target.resolve().is_relative_to(destination.resolve()):
            raise RuntimeError(f'Unexpected native payload path: {member.name}')
        if member.isfile():
            expected = archive.extractfile(member)
            if expected is None or hashlib.sha256(expected.read()).digest() != hashlib.sha256(target.read_bytes()).digest():
                raise RuntimeError(f'Native payload differs from pinned archive: {member.name}')
