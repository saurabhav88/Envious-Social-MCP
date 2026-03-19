#!/usr/bin/env python3
"""
One-shot OAuth 2.0 flow for LinkedIn (and future platforms).
Spins up a local server, opens browser, catches callback, stores tokens in Keychain.

Usage:
    LINKEDIN_CLIENT_ID=xxx LINKEDIN_CLIENT_SECRET=yyy python oauth_flow.py linkedin
"""

import os
import sys
import json
import webbrowser
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
from connectors.keychain import keychain_set

REDIRECT_PORT = 9876
REDIRECT_URI = f"http://localhost:{REDIRECT_PORT}/callback"

PLATFORMS = {
    "linkedin": {
        "auth_url": "https://www.linkedin.com/oauth/v2/authorization",
        "token_url": "https://www.linkedin.com/oauth/v2/accessToken",
        "client_id": os.environ.get("LINKEDIN_CLIENT_ID", ""),
        "client_secret": os.environ.get("LINKEDIN_CLIENT_SECRET", ""),
        "scopes": "openid profile w_member_social email r_profile_basicinfo",
    },
}


class OAuthCallbackHandler(BaseHTTPRequestHandler):
    """Catches the OAuth redirect and extracts the auth code."""

    auth_code = None

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        if "code" in params:
            OAuthCallbackHandler.auth_code = params["code"][0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h1>Auth successful!</h1><p>You can close this tab.</p>")
        elif "error" in params:
            self.send_response(400)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            error = params.get("error_description", params["error"])
            self.wfile.write(f"<h1>Auth failed</h1><p>{error}</p>".encode())
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # suppress request logging


def exchange_code_for_tokens(platform_config: dict, code: str) -> dict:
    """Exchange auth code for access + refresh tokens."""
    import httpx

    resp = httpx.post(
        platform_config["token_url"],
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
            "client_id": platform_config["client_id"],
            "client_secret": platform_config["client_secret"],
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    resp.raise_for_status()
    return resp.json()


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in PLATFORMS:
        print(f"Usage: python oauth_flow.py <{'|'.join(PLATFORMS.keys())}>")
        sys.exit(1)

    platform_name = sys.argv[1]
    config = PLATFORMS[platform_name]

    # Build auth URL
    params = {
        "response_type": "code",
        "client_id": config["client_id"],
        "redirect_uri": REDIRECT_URI,
        "scope": config["scopes"],
        "state": "envious-social-oauth",
    }
    auth_url = f"{config['auth_url']}?{urllib.parse.urlencode(params)}"

    print(f"\nOpening browser for {platform_name} OAuth...")
    print(f"Redirect URI: {REDIRECT_URI}")
    print(f"Waiting for callback on port {REDIRECT_PORT}...\n")

    # Open browser
    webbrowser.open(auth_url)

    # Start local server to catch callback
    server = HTTPServer(("localhost", REDIRECT_PORT), OAuthCallbackHandler)
    server.handle_request()  # handle exactly one request

    if not OAuthCallbackHandler.auth_code:
        print("ERROR: No auth code received")
        sys.exit(1)

    print(f"Got auth code: {OAuthCallbackHandler.auth_code[:10]}...")

    # Exchange for tokens
    print("Exchanging for tokens...")
    tokens = exchange_code_for_tokens(config, OAuthCallbackHandler.auth_code)
    print(f"Token response keys: {list(tokens.keys())}")

    # Store in Keychain
    access_token = tokens.get("access_token")
    refresh_token = tokens.get("refresh_token")
    expires_in = tokens.get("expires_in")

    if access_token:
        keychain_set("envious-social", f"{platform_name}-access-token", access_token)
        print(f"Stored {platform_name}-access-token in Keychain")

    if refresh_token:
        keychain_set("envious-social", f"{platform_name}-refresh-token", refresh_token)
        print(f"Stored {platform_name}-refresh-token in Keychain")

    print(f"\nDone! Token expires in {expires_in}s" if expires_in else "\nDone!")
    print(json.dumps({k: v for k, v in tokens.items() if k != "access_token"}, indent=2))


if __name__ == "__main__":
    main()
