"""X/Twitter connector — OAuth 1.0a, media via v1, posts via v2."""

import asyncio
import mimetypes
import os
import time
from typing import Optional, List, Dict, Any

from requests_oauthlib import OAuth1Session

from connectors.base import BaseConnector
from connectors.keychain import keychain_get


class XConnector(BaseConnector):
    platform = "x"

    # API endpoints
    TWEET_URL = "https://api.x.com/2/tweets"
    MEDIA_UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json"

    # Limits
    MAX_MEDIA = 4
    MAX_TEXT_STANDARD = 280
    MAX_TEXT_PREMIUM = 4000

    def _get_oauth_session(self) -> OAuth1Session:
        """Create an OAuth1Session from Keychain credentials."""
        consumer_key = keychain_get("envious-social", "x-consumer-key")
        consumer_secret = keychain_get("envious-social", "x-consumer-secret")
        access_token = keychain_get("envious-social", "x-access-token")
        access_secret = keychain_get("envious-social", "x-access-secret")

        if not all([consumer_key, consumer_secret, access_token, access_secret]):
            missing = []
            if not consumer_key: missing.append("x-consumer-key")
            if not consumer_secret: missing.append("x-consumer-secret")
            if not access_token: missing.append("x-access-token")
            if not access_secret: missing.append("x-access-secret")
            raise ValueError(
                f"Missing X OAuth credentials in Keychain (service: envious-social): {', '.join(missing)}. "
                f"Use social_store_tokens to store them."
            )

        return OAuth1Session(consumer_key, consumer_secret, access_token, access_secret)

    def _detect_media_type(self, file_path: str) -> str:
        """Detect MIME type from file extension."""
        mime, _ = mimetypes.guess_type(file_path)
        return mime or "application/octet-stream"

    def _media_category(self, mime_type: str) -> str:
        """Determine X media category from MIME type."""
        if mime_type.startswith("video/"):
            return "tweet_video"
        elif mime_type == "image/gif":
            return "tweet_gif"
        else:
            return "tweet_image"

    async def upload_media(
        self,
        file_path: str,
        media_type: Optional[str] = None,
        _oauth: Optional[OAuth1Session] = None,
    ) -> Dict[str, Any]:
        """Upload media to X using chunked upload (INIT/APPEND/FINALIZE).

        Works for images, GIFs, and videos up to ~512MB.
        Pass _oauth to reuse an existing session (ensures media_id is bound to same credentials).
        """
        if not os.path.isfile(file_path):
            raise FileNotFoundError(f"Media file not found or is a directory: {file_path}")

        oauth = _oauth or self._get_oauth_session()
        mime_type = media_type or self._detect_media_type(file_path)
        file_size = os.path.getsize(file_path)
        category = self._media_category(mime_type)

        # INIT
        init_resp = oauth.post(self.MEDIA_UPLOAD_URL, data={
            "command": "INIT",
            "media_type": mime_type,
            "total_bytes": file_size,
            "media_category": category,
        })
        if init_resp.status_code not in (200, 202):
            raise RuntimeError(f"Media INIT failed ({init_resp.status_code}): {init_resp.text}")

        media_id = init_resp.json()["media_id_string"]

        # APPEND — send in 5MB chunks
        chunk_size = 5 * 1024 * 1024
        segment = 0
        with open(file_path, "rb") as f:
            while True:
                chunk = f.read(chunk_size)
                if not chunk:
                    break
                append_resp = oauth.post(
                    self.MEDIA_UPLOAD_URL,
                    data={"command": "APPEND", "media_id": media_id, "segment_index": segment},
                    files={"media": chunk},
                )
                if append_resp.status_code not in (200, 204):
                    raise RuntimeError(f"Media APPEND failed ({append_resp.status_code}): {append_resp.text}")
                segment += 1

        # FINALIZE
        final_resp = oauth.post(self.MEDIA_UPLOAD_URL, data={
            "command": "FINALIZE",
            "media_id": media_id,
        })
        if final_resp.status_code not in (200, 201):
            raise RuntimeError(f"Media FINALIZE failed ({final_resp.status_code}): {final_resp.text}")

        final_data = final_resp.json()

        # Poll processing status for video/GIF (5 min timeout)
        if "processing_info" in final_data:
            deadline = time.monotonic() + 300
            poll_data = final_data  # first iteration uses FINALIZE response
            while True:
                if time.monotonic() > deadline:
                    raise RuntimeError(f"Media processing timed out after 300s (media_id={media_id})")
                wait_secs = poll_data.get("processing_info", {}).get("check_after_secs", 5)
                await asyncio.sleep(wait_secs)
                status_resp = oauth.get(self.MEDIA_UPLOAD_URL, params={
                    "command": "STATUS",
                    "media_id": media_id,
                })
                poll_data = status_resp.json()
                state = poll_data.get("processing_info", {}).get("state", "")
                if state == "succeeded":
                    break
                elif state == "failed":
                    error = poll_data.get("processing_info", {}).get("error", {})
                    raise RuntimeError(f"Media processing failed: {error}")

        return {
            "media_id": media_id,
            "platform": "x",
            "type": category,
            "size_bytes": file_size,
        }

    async def post(
        self,
        text: str,
        media_paths: Optional[List[str]] = None,
        reply_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Post a tweet, optionally with media and/or as a reply.

        Media files are uploaded automatically via chunked upload.
        """
        oauth = self._get_oauth_session()

        # Upload media if provided — reuse same OAuth session to keep media_id bound
        media_ids = []
        if media_paths:
            if len(media_paths) > self.MAX_MEDIA:
                raise ValueError(f"X supports max {self.MAX_MEDIA} media per tweet, got {len(media_paths)}")
            for path in media_paths:
                result = await self.upload_media(path, _oauth=oauth)
                media_ids.append(result["media_id"])

        # Validate text length before posting
        char_count = len(text)
        if char_count > self.MAX_TEXT_STANDARD:
            return {
                "success": False,
                "platform": "x",
                "error": f"Tweet is {char_count} chars — exceeds 280 limit (over by {char_count - self.MAX_TEXT_STANDARD}). Trim the text and retry.",
                "title": "Text too long",
                "char_count": char_count,
                "max_chars": self.MAX_TEXT_STANDARD,
            }

        # Build tweet payload
        payload: Dict[str, Any] = {"text": text}
        if media_ids:
            payload["media"] = {"media_ids": media_ids}
        if reply_to:
            payload["reply"] = {"in_reply_to_tweet_id": reply_to}

        # Post tweet
        resp = oauth.post(self.TWEET_URL, json=payload)

        if resp.status_code == 201:
            data = resp.json().get("data", {})
            tweet_id = data.get("id", "")
            return {
                "success": True,
                "platform": "x",
                "post_id": tweet_id,
                "url": f"https://x.com/i/status/{tweet_id}",
                "text": data.get("text", text),
            }
        else:
            error_data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            detail = error_data.get("detail", resp.text)
            title = error_data.get("title", "Unknown error")
            # Surface actionable hints for common errors
            hint = ""
            if resp.status_code == 403:
                hint = " (Check: text over 280 chars? App permissions set to Read+Write? Access token regenerated after permission change?)"
            elif resp.status_code == 429:
                hint = " (Rate limited — wait and retry)"
            return {
                "success": False,
                "platform": "x",
                "status_code": resp.status_code,
                "error": f"{detail}{hint}",
                "title": title,
            }

    async def delete_post(self, post_id: str) -> Dict[str, Any]:
        """Delete a tweet by ID."""
        oauth = self._get_oauth_session()
        resp = oauth.delete(f"{self.TWEET_URL}/{post_id}")
        if resp.status_code == 200:
            deleted = resp.json().get("data", {}).get("deleted", False)
            return {"success": deleted, "platform": "x", "post_id": post_id}
        return {
            "success": False,
            "platform": "x",
            "post_id": post_id,
            "status_code": resp.status_code,
            "error": resp.text,
        }

    async def verify_auth(self) -> Dict[str, Any]:
        """Verify X OAuth credentials by calling /2/users/me."""
        try:
            oauth = self._get_oauth_session()
            resp = oauth.get("https://api.x.com/2/users/me")
            if resp.status_code == 200:
                user = resp.json().get("data", {})
                return {
                    "valid": True,
                    "username": user.get("username"),
                    "name": user.get("name"),
                    "id": user.get("id"),
                }
            return {"valid": False, "status_code": resp.status_code, "error": resp.text}
        except Exception as e:
            return {"valid": False, "error": str(e)}
