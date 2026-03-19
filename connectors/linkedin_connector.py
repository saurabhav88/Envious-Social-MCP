"""LinkedIn connector — OAuth 2.0, Posts API v2."""

import mimetypes
import os
from typing import Optional, List, Dict, Any

import httpx

from connectors.base import BaseConnector
from connectors.keychain import keychain_get


class LinkedInConnector(BaseConnector):
    platform = "linkedin"

    # API endpoints
    USERINFO_URL = "https://api.linkedin.com/v2/userinfo"
    UGC_POSTS_URL = "https://api.linkedin.com/v2/ugcPosts"
    IMAGES_INIT_URL = "https://api.linkedin.com/v2/assets?action=registerUpload"

    # Limits
    MAX_TEXT = 3000

    def _get_headers(self) -> Dict[str, str]:
        """Build auth headers from Keychain token."""
        token = keychain_get("envious-social", "linkedin-access-token")
        if not token:
            raise ValueError(
                "Missing LinkedIn access token in Keychain (service: envious-social, account: linkedin-access-token). "
                "Run: python oauth_flow.py linkedin"
            )
        return {
            "Authorization": f"Bearer {token}",
            "X-Restli-Protocol-Version": "2.0.0",
            "Content-Type": "application/json",
        }

    async def _get_person_urn(self) -> str:
        """Get the authenticated user's person URN via userinfo endpoint."""
        headers = self._get_headers()
        resp = httpx.get(self.USERINFO_URL, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f"Failed to get LinkedIn userinfo ({resp.status_code}): {resp.text}")
        sub = resp.json().get("sub")
        if not sub:
            raise RuntimeError("LinkedIn userinfo did not return a 'sub' field")
        return f"urn:li:person:{sub}"

    async def upload_media(
        self,
        file_path: str,
        media_type: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Upload an image to LinkedIn using the asset register + upload flow.

        LinkedIn image uploads are a 2-step process:
        1. Register the upload to get an upload URL and asset URN
        2. PUT the binary data to the upload URL
        """
        if not os.path.isfile(file_path):
            raise FileNotFoundError(f"Media file not found or is a directory: {file_path}")

        headers = self._get_headers()
        person_urn = await self._get_person_urn()

        mime = media_type or mimetypes.guess_type(file_path)[0] or "image/jpeg"

        # Step 1: Register upload
        register_data = {
            "registerUploadRequest": {
                "recipes": ["urn:li:digitalmediaRecipe:feedshare-image"],
                "owner": person_urn,
                "serviceRelationships": [
                    {
                        "relationshipType": "OWNER",
                        "identifier": "urn:li:userGeneratedContent",
                    }
                ],
            }
        }

        resp = httpx.post(self.IMAGES_INIT_URL, json=register_data, headers=headers)
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"LinkedIn image register failed ({resp.status_code}): {resp.text}")

        upload_data = resp.json()["value"]
        upload_url = upload_data["uploadMechanism"][
            "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
        ]["uploadUrl"]
        asset = upload_data["asset"]

        # Step 2: Upload binary
        with open(file_path, "rb") as f:
            put_resp = httpx.put(
                upload_url,
                content=f.read(),
                headers={
                    "Authorization": headers["Authorization"],
                    "Content-Type": mime,
                },
                timeout=60,
            )
        if put_resp.status_code not in (200, 201):
            raise RuntimeError(f"LinkedIn image upload failed ({put_resp.status_code}): {put_resp.text}")

        return {
            "media_id": asset,
            "platform": "linkedin",
            "type": "image",
            "size_bytes": os.path.getsize(file_path),
        }

    async def post(
        self,
        text: str,
        media_paths: Optional[List[str]] = None,
        reply_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Post to LinkedIn, optionally with images.

        reply_to is accepted but LinkedIn doesn't support threaded replies
        the same way X does — it's included for interface compatibility.
        """
        headers = self._get_headers()
        person_urn = await self._get_person_urn()

        if len(text) > self.MAX_TEXT:
            raise ValueError(f"LinkedIn text limit is {self.MAX_TEXT} chars, got {len(text)}")

        # Upload media if provided
        media_assets = []
        if media_paths:
            for path in media_paths:
                result = await self.upload_media(path)
                media_assets.append(result["media_id"])

        # Build UGC post payload
        if media_assets:
            media_entries = [
                {
                    "status": "READY",
                    "media": asset,
                }
                for asset in media_assets
            ]
            share_content = {
                "shareCommentary": {"text": text},
                "shareMediaCategory": "IMAGE",
                "media": media_entries,
            }
        else:
            share_content = {
                "shareCommentary": {"text": text},
                "shareMediaCategory": "NONE",
            }

        post_data = {
            "author": person_urn,
            "lifecycleState": "PUBLISHED",
            "specificContent": {
                "com.linkedin.ugc.ShareContent": share_content,
            },
            "visibility": {
                "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
            },
        }

        # If reply_to is provided, add as commentary context (not a true reply)
        resp = httpx.post(self.UGC_POSTS_URL, json=post_data, headers=headers, timeout=30)

        if resp.status_code == 201:
            post_id = resp.json().get("id", "")
            # Extract share ID for URL
            share_id = post_id.replace("urn:li:share:", "")
            return {
                "success": True,
                "platform": "linkedin",
                "post_id": post_id,
                "url": f"https://www.linkedin.com/feed/update/{post_id}/",
                "text": text,
            }
        else:
            return {
                "success": False,
                "platform": "linkedin",
                "status_code": resp.status_code,
                "error": resp.text,
            }

    async def verify_auth(self) -> Dict[str, Any]:
        """Verify LinkedIn OAuth token by calling userinfo."""
        try:
            headers = self._get_headers()
            resp = httpx.get(self.USERINFO_URL, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                return {
                    "valid": True,
                    "name": data.get("name"),
                    "email": data.get("email"),
                    "sub": data.get("sub"),
                }
            return {"valid": False, "status_code": resp.status_code, "error": resp.text}
        except Exception as e:
            return {"valid": False, "error": str(e)}
