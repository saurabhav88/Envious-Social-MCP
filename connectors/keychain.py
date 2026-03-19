"""macOS Keychain helpers for storing/retrieving OAuth tokens."""

import subprocess
from typing import Optional


def keychain_get(service: str, account: str) -> Optional[str]:
    """Read a value from macOS Keychain."""
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", service, "-a", account, "-w"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return None


def keychain_set(service: str, account: str, value: str) -> bool:
    """Write a value to macOS Keychain (creates or updates)."""
    try:
        result = subprocess.run(
            ["security", "add-generic-password", "-s", service, "-a", account, "-w", value, "-U"],
            capture_output=True, text=True, timeout=5,
        )
        return result.returncode == 0
    except Exception:
        return False
