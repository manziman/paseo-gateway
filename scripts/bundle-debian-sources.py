#!/usr/bin/env python3
"""Bundle exact Debian source files for package inventories from released images.

Usage: python3 scripts/bundle-debian-sources.py OUTPUT_DIR *-debian-sources.tsv
Produces debian-corresponding-source.tar.gz and debian-source-manifest.json.
"""

import hashlib
import json
import re
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


BASE = "https://snapshot.debian.org"
USER_AGENT = "paseo-release-corresponding-source/1"


def request(url):
    last = None
    for attempt in range(5):
        try:
            return urllib.request.urlopen(
                urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=90
            )
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
            last = error
            if isinstance(error, urllib.error.HTTPError) and error.code in (400, 404):
                break
            time.sleep(min(2**attempt, 16))
    raise RuntimeError(f"Debian Snapshot request failed: {url}: {last}") from last


def inventory(paths):
    sources = set()
    for path in paths:
        with Path(path).open(encoding="utf-8") as handle:
            for number, line in enumerate(handle, 1):
                fields = line.rstrip("\n").split("\t")
                if len(fields) != 4:
                    raise ValueError(f"{path}:{number}: expected four tab-separated columns")
                binary, binary_version, source, version = fields
                if (
                    not all(fields)
                    or not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*", source)
                    or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.+:~-]*", version)
                ):
                    raise ValueError(f"{path}:{number}: invalid package metadata")
                sources.add((source, version))
    if not sources:
        raise ValueError("empty Debian source inventory")
    return sorted(sources)


def source_files(item):
    package, version = item
    url = f"{BASE}/mr/package/{urllib.parse.quote(package, safe='')}/{urllib.parse.quote(version, safe='')}/srcfiles?fileinfo=1"
    with request(url) as response:
        document = json.load(response)
    files = []
    for result in document.get("result") or []:
        sha1 = result["hash"]
        if not re.fullmatch(r"[0-9a-f]{40}", sha1):
            raise ValueError(f"invalid SHA-1 from Snapshot for {package} {version}")
        entries = document.get("fileinfo", {}).get(sha1) or []
        if not entries:
            raise ValueError(f"missing Snapshot file metadata for {package} {version} {sha1}")
        entry = entries[0]
        name = entry["name"]
        if Path(name).name != name or name in (".", ".."):
            raise ValueError(f"unsafe Snapshot filename: {name}")
        files.append({"name": name, "sha1": sha1, "size": entry["size"]})
    if not any(file["name"].endswith(".dsc") for file in files):
        raise ValueError(f"Snapshot has no source control file for {package} {version}")
    if not files:
        raise ValueError(f"Snapshot has no source files for {package} {version}")
    return {"package": package, "version": version, "files": sorted(files, key=lambda f: f["name"])}


def download(file, directory):
    target = directory / file["sha1"]
    if target.exists() and digest(target) == file["sha1"]:
        return
    name = urllib.parse.quote(file["name"], safe="")
    url = f"{BASE}/file/{file['sha1']}/{name}"
    temporary = target.with_suffix(".partial")
    with request(url) as response, temporary.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    if temporary.stat().st_size != file["size"] or digest(temporary) != file["sha1"]:
        temporary.unlink(missing_ok=True)
        raise ValueError(f"Debian source hash/size mismatch: {file['name']}")
    temporary.replace(target)


def digest(path, algorithm="sha1"):
    checksum = hashlib.new(algorithm)
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            checksum.update(chunk)
    return checksum.hexdigest()


def verify_source_control(item, cache):
    files = {file["name"]: file for file in item["files"]}
    control = next(file for file in item["files"] if file["name"].endswith(".dsc"))
    contents = (cache / control["sha1"]).read_text(encoding="utf-8")
    lines = contents.splitlines()
    try:
        start = lines.index("Checksums-Sha256:") + 1
    except ValueError as error:
        raise ValueError(f"No SHA-256 checksums in {control['name']}") from error
    verified = set()
    for line in lines[start:]:
        if not line.startswith(" "):
            break
        parts = line.split()
        if len(parts) != 3:
            raise ValueError(f"Malformed source checksum in {control['name']}")
        sha256, size, name = parts
        file = files.get(name)
        if not file or file["size"] != int(size) or file["sha256"] != sha256:
            raise ValueError(f"Source control checksum mismatch: {control['name']} -> {name}")
        verified.add(name)
    if verified != files.keys() - {control["name"]}:
        raise ValueError(f"Source control file list mismatch: {control['name']}")


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    output = Path(sys.argv[1])
    output.mkdir(parents=True, exist_ok=True)
    packages = inventory(sys.argv[2:])
    print(f"Resolving {len(packages)} exact Debian source versions", flush=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        metadata = list(pool.map(source_files, packages))
    files = {file["sha1"]: file for item in metadata for file in item["files"]}
    # Keep downloaded inputs outside the release-asset directory so every
    # top-level entry there remains a file eligible for SHA256SUMS/upload.
    cache = output.parent / f".{output.name}-debian-source-cache"
    cache.mkdir(exist_ok=True)
    print(f"Downloading {len(files)} unique source files", flush=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(download, file, cache) for file in files.values()]
        for future in as_completed(futures):
            future.result()
    for item in metadata:
        for file in item["files"]:
            file["sha256"] = digest(cache / file["sha1"], "sha256")
        verify_source_control(item, cache)
    manifest = {"format": 1, "snapshot": BASE, "packages": metadata}
    manifest_path = output / "debian-source-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    archive_path = output / "debian-corresponding-source.tar.gz"
    with tarfile.open(archive_path, "w:gz") as archive:
        archive.add(manifest_path, arcname="debian-source-manifest.json")
        for item in metadata:
            for file in item["files"]:
                archive.add(
                    cache / file["sha1"],
                    arcname=f"sources/{item['package']}/{item['version']}/{file['name']}",
                )
    print(f"Wrote {archive_path} ({archive_path.stat().st_size} bytes)", flush=True)


if __name__ == "__main__":
    main()
