"""Normalize native Helm output so recovery compares immutable chart bytes."""
import gzip
import io
import pathlib
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
with tarfile.open(archive, "r:gz") as original:
    files = [(member, original.extractfile(member).read() if member.isfile() else None)
             for member in original.getmembers()]
result = io.BytesIO()
with gzip.GzipFile(fileobj=result, mode="wb", filename="", mtime=0) as compressed:
    with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as output:
        for member, content in sorted(files, key=lambda entry: entry[0].name):
            member.mtime = member.uid = member.gid = 0
            member.uname = member.gname = ""
            member.pax_headers = {}
            output.addfile(member, io.BytesIO(content) if content is not None else None)
archive.write_bytes(result.getvalue())
