#!/usr/bin/env python3
"""
Envious Social MCP Server — post to social media from Claude Code.

V1: Direct posting to X/Twitter, YouTube, LinkedIn, Facebook, Instagram, TikTok.
No Docker, no middleware. OAuth tokens stored in macOS Keychain.

Architecture: Each platform is a connector module in connectors/.
This file is the MCP entry point — it registers tools and delegates to connectors.
"""

import json
from typing import Optional, List
from enum import Enum
from pydantic import BaseModel, Field, ConfigDict
from mcp.server.fastmcp import FastMCP
from connectors.keychain import keychain_get, keychain_set

# Initialize MCP server
mcp = FastMCP(
    "envious_social_mcp",
    instructions=(
        "Social media posting server for Envious Labs. "
        "Post text and media to X/Twitter, YouTube, LinkedIn, Facebook, Instagram, and TikTok. "
        "OAuth tokens are stored in macOS Keychain. "
        "X/Twitter is fully functional. Other platforms coming soon."
    ),
)

# ---------------------------------------------------------------------------
# Platform registry
# ---------------------------------------------------------------------------

class Platform(str, Enum):
    X = "x"
    YOUTUBE = "youtube"
    LINKEDIN = "linkedin"
    FACEBOOK = "facebook"
    INSTAGRAM = "instagram"
    TIKTOK = "tiktok"


# Lazy-loaded connector instances
_connectors: dict = {}


def _get_connector(platform: Platform):
    """Get or create a connector for the given platform."""
    if platform not in _connectors:
        if platform == Platform.X:
            from connectors.x_connector import XConnector
            _connectors[platform] = XConnector()
        elif platform == Platform.LINKEDIN:
            from connectors.linkedin_connector import LinkedInConnector
            _connectors[platform] = LinkedInConnector()
        else:
            raise ValueError(
                f"Platform '{platform.value}' is not yet implemented. "
                f"Currently supported: x, linkedin. Coming soon: youtube, facebook, instagram, tiktok."
            )
    return _connectors[platform]


# ---------------------------------------------------------------------------
# Input models
# ---------------------------------------------------------------------------

class PostInput(BaseModel):
    """Input for creating a social media post."""
    model_config = ConfigDict(str_strip_whitespace=True)

    platform: Platform = Field(..., description="Target platform: x, youtube, linkedin, facebook, instagram, tiktok")
    text: str = Field(..., description="Post text content", min_length=1)
    media_paths: Optional[List[str]] = Field(
        default=None,
        description="Local file paths to media (images, videos) to attach. Max 4 for X, 1 for most others.",
    )
    reply_to: Optional[str] = Field(
        default=None,
        description="Post/tweet ID to reply to (creates a thread on X).",
    )


class ReplyInput(BaseModel):
    """Input for replying to an existing post."""
    model_config = ConfigDict(str_strip_whitespace=True)

    platform: Platform = Field(..., description="Target platform")
    post_id: str = Field(..., description="ID of the post to reply to", min_length=1)
    text: str = Field(..., description="Reply text content", min_length=1)
    media_paths: Optional[List[str]] = Field(
        default=None,
        description="Local file paths to media to attach to the reply.",
    )


class UploadMediaInput(BaseModel):
    """Input for uploading media to a platform."""
    model_config = ConfigDict(str_strip_whitespace=True)

    platform: Platform = Field(..., description="Target platform")
    file_path: str = Field(..., description="Local file path to the media file", min_length=1)
    media_type: Optional[str] = Field(
        default=None,
        description="MIME type override (e.g. 'video/mp4'). Auto-detected if not provided.",
    )


class AuthStatusInput(BaseModel):
    """Input for checking auth status."""
    platform: Optional[Platform] = Field(
        default=None,
        description="Check a specific platform, or omit to check all.",
    )


class DeletePostInput(BaseModel):
    """Input for deleting a social media post."""
    model_config = ConfigDict(str_strip_whitespace=True)

    platform: Platform = Field(..., description="Platform: x (supported). LinkedIn, Instagram, TikTok do not support deletion via API.")
    post_id: str = Field(..., description="ID of the post to delete", min_length=1)


class StoreTokenInput(BaseModel):
    """Input for storing OAuth tokens in Keychain."""
    model_config = ConfigDict(str_strip_whitespace=True)

    platform: Platform = Field(..., description="Platform to store tokens for")
    consumer_key: Optional[str] = Field(default=None, description="OAuth 1.0a consumer key (X only)")
    consumer_secret: Optional[str] = Field(default=None, description="OAuth 1.0a consumer secret (X only)")
    access_token: Optional[str] = Field(default=None, description="Access token")
    access_secret: Optional[str] = Field(default=None, description="Access token secret (OAuth 1.0a only)")
    refresh_token: Optional[str] = Field(default=None, description="Refresh token (OAuth 2.0 only)")


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@mcp.tool(
    name="social_post",
    annotations={
        "title": "Post to Social Media",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": True,
    },
)
async def social_post(params: PostInput) -> str:
    """Post text and optional media to a social media platform.

    Supports X/Twitter (V1), with YouTube, LinkedIn, Facebook, Instagram,
    and TikTok coming soon. Media files are uploaded automatically.

    For X: text limit is 280 chars (standard) or 4000 (premium).
    Links in replies get better algorithm treatment than links in main tweets.

    Args:
        params: PostInput with platform, text, optional media_paths, optional reply_to.

    Returns:
        JSON with post ID, URL, and platform response details.
    """
    connector = _get_connector(params.platform)
    result = await connector.post(
        text=params.text,
        media_paths=params.media_paths,
        reply_to=params.reply_to,
    )
    if not result.get("success", True):
        raise ValueError(f"Post failed: {result.get('error', result.get('title', 'Unknown error'))}")
    return json.dumps(result, indent=2)


@mcp.tool(
    name="social_reply",
    annotations={
        "title": "Reply to a Social Media Post",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": True,
    },
)
async def social_reply(params: ReplyInput) -> str:
    """Reply to an existing post on a social media platform.

    On X/Twitter, this creates a threaded reply. Useful for adding links
    in replies (better for algorithm than links in main tweet).

    Args:
        params: ReplyInput with platform, post_id, text, optional media_paths.

    Returns:
        JSON with reply post ID, URL, and platform response details.
    """
    connector = _get_connector(params.platform)
    result = await connector.post(
        text=params.text,
        media_paths=params.media_paths,
        reply_to=params.post_id,
    )
    if not result.get("success", True):
        raise ValueError(f"Reply failed: {result.get('error', result.get('title', 'Unknown error'))}")
    return json.dumps(result, indent=2)


@mcp.tool(
    name="social_upload_media",
    annotations={
        "title": "Upload Media to Social Platform",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def social_upload_media(params: UploadMediaInput) -> str:
    """Upload a media file to a social platform and return a media reference.

    Use this to pre-upload media before creating a post. Returns a media_id
    that can be used in social_post. For most cases, social_post handles
    uploads automatically — use this only for advanced workflows.

    Args:
        params: UploadMediaInput with platform, file_path, optional media_type.

    Returns:
        JSON with media_id and platform-specific upload details.
    """
    connector = _get_connector(params.platform)
    result = await connector.upload_media(
        file_path=params.file_path,
        media_type=params.media_type,
    )
    return json.dumps(result, indent=2)


PLATFORMS_WITH_DELETE = {Platform.X}


@mcp.tool(
    name="social_delete",
    annotations={
        "title": "Delete a Social Media Post",
        "readOnlyHint": False,
        "destructiveHint": True,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def social_delete(params: DeletePostInput) -> str:
    """Delete a post from a social media platform.

    Currently supported: X/Twitter.
    Not available: LinkedIn, Instagram, TikTok (no public delete API).
    Facebook and YouTube will be added when those connectors ship.

    Args:
        params: DeletePostInput with platform and post_id.

    Returns:
        JSON confirming deletion or error details.
    """
    if params.platform not in PLATFORMS_WITH_DELETE:
        raise ValueError(
            f"Delete is not supported on {params.platform.value}. "
            f"Supported platforms for deletion: {', '.join(p.value for p in PLATFORMS_WITH_DELETE)}"
        )
    connector = _get_connector(params.platform)
    result = await connector.delete_post(params.post_id)
    if not result.get("success", True):
        raise ValueError(f"Delete failed: {result.get('error', 'Unknown error')}")
    return json.dumps(result, indent=2)


@mcp.tool(
    name="social_auth_status",
    annotations={
        "title": "Check Social Media Auth Status",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    },
)
async def social_auth_status(params: AuthStatusInput) -> str:
    """Check which social platforms have valid OAuth tokens stored in Keychain.

    Returns token status for each platform: connected, expired, or not configured.

    Args:
        params: AuthStatusInput with optional platform filter.

    Returns:
        JSON with auth status per platform.
    """
    platforms = [params.platform] if params.platform else list(Platform)
    statuses = {}

    for p in platforms:
        platform_name = p.value if isinstance(p, Platform) else p
        if platform_name == "x":
            x_fields = {
                "consumer_key": keychain_get("envious-social", "x-consumer-key") is not None,
                "consumer_secret": keychain_get("envious-social", "x-consumer-secret") is not None,
                "access_token": keychain_get("envious-social", "x-access-token") is not None,
                "access_secret": keychain_get("envious-social", "x-access-secret") is not None,
            }
            if all(x_fields.values()):
                statuses[platform_name] = {"status": "connected", "auth_type": "OAuth 1.0a", "expires": "never"}
            elif any(x_fields.values()):
                missing = [k for k, v in x_fields.items() if not v]
                statuses[platform_name] = {"status": "partial", "missing": missing}
            else:
                statuses[platform_name] = {"status": "not_configured"}
        elif platform_name in ("youtube", "linkedin"):
            has_token = keychain_get("envious-social", f"{platform_name}-access-token") is not None
            has_refresh = keychain_get("envious-social", f"{platform_name}-refresh-token") is not None
            if has_token and has_refresh:
                statuses[platform_name] = {"status": "connected", "auth_type": "OAuth 2.0", "refreshable": True}
            elif has_token:
                statuses[platform_name] = {"status": "connected", "auth_type": "OAuth 2.0", "refreshable": False}
            else:
                statuses[platform_name] = {"status": "not_configured"}
        elif platform_name in ("facebook", "instagram"):
            has_token = keychain_get("envious-social", f"{platform_name}-access-token") is not None
            if has_token:
                statuses[platform_name] = {
                    "status": "connected",
                    "auth_type": "OAuth 2.0 (long-lived)",
                    "expires": "~59 days from last auth",
                    "refreshable": False,
                }
            else:
                statuses[platform_name] = {"status": "not_configured"}
        elif platform_name == "tiktok":
            has_token = keychain_get("envious-social", "tiktok-access-token") is not None
            if has_token:
                statuses[platform_name] = {
                    "status": "connected",
                    "auth_type": "OAuth 2.0",
                    "expires": "23 hours",
                    "refreshable": True,
                }
            else:
                statuses[platform_name] = {"status": "not_configured"}
        else:
            statuses[platform_name] = {"status": "not_configured"}

    return json.dumps(statuses, indent=2)


@mcp.tool(
    name="social_store_tokens",
    annotations={
        "title": "Store OAuth Tokens in Keychain",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    },
)
async def social_store_tokens(params: StoreTokenInput) -> str:
    """Store OAuth tokens for a social platform in macOS Keychain.

    For X/Twitter: requires consumer_key, consumer_secret, access_token, access_secret.
    For OAuth 2.0 platforms: requires access_token, optionally refresh_token.

    Args:
        params: StoreTokenInput with platform and token fields.

    Returns:
        JSON confirming which tokens were stored.
    """
    stored = []
    failed = []
    platform = params.platform.value

    token_fields = [
        ("consumer_key", params.consumer_key, f"{platform}-consumer-key"),
        ("consumer_secret", params.consumer_secret, f"{platform}-consumer-secret"),
        ("access_token", params.access_token, f"{platform}-access-token"),
        ("access_secret", params.access_secret, f"{platform}-access-secret"),
        ("refresh_token", params.refresh_token, f"{platform}-refresh-token"),
    ]

    for field_name, value, keychain_account in token_fields:
        if value:
            if keychain_set("envious-social", keychain_account, value):
                stored.append(field_name)
            else:
                failed.append(field_name)

    result = {
        "platform": platform,
        "stored": stored,
        "keychain_service": "envious-social",
    }
    if failed:
        result["failed"] = failed
        result["error"] = f"Failed to store: {', '.join(failed)}. Check Keychain access permissions."
    return json.dumps(result, indent=2)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    mcp.run()
