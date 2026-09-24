#!/usr/bin/env python3
"""Apply the public repository's reviewed governance policy with gh admin access.

Run after the named checks have appeared on a real PR. Uses structured JSON,
does not access token values, and never changes repository/package visibility.
"""

import argparse
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / ".github" / "repository-settings"


def api(method, path, payload=None):
    command = ["gh", "api", "--method", method, path]
    if payload is not None:
        command.extend(["--input", "-"])
    result = subprocess.run(
        command,
        input=json.dumps(payload) if payload is not None else None,
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout) if result.stdout.strip() else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Apply reviewed rulesets")
    parser.add_argument("--repo", default="manziman/paseo-gateway")
    args = parser.parse_args()
    endpoint = f"repos/{args.repo}"
    desired = [json.loads(path.read_text()) for path in sorted(POLICY.glob("*.json"))]
    if not args.apply:
        print(json.dumps(desired, indent=2))
        return
    existing = api("GET", endpoint + "/rulesets")
    for policy in desired:
        match = next((rule for rule in existing if rule["name"] == policy["name"]), None)
        path = endpoint + "/rulesets"
        if match:
            path += f'/{match["id"]}'
        response = api("PUT" if match else "POST", path, policy)
        saved = api("GET", endpoint + f'/rulesets/{response["id"]}')
        for key in ("name", "target", "enforcement", "conditions", "rules", "bypass_actors"):
            if saved.get(key, []) != policy.get(key, []):
                raise RuntimeError(f"Ruleset verification failed: {policy['name']} {key}")
        print(f"Verified {saved['name']}: {saved['_links']['html']['href']}")


if __name__ == "__main__":
    main()
