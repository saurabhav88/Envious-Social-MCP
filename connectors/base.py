"""Base connector interface for social platforms."""

from typing import Optional, List, Dict, Any


class BaseConnector:
    """Abstract base for platform connectors.

    Each connector implements:
    - post(): Create a post with optional media and reply threading
    - upload_media(): Upload a media file and return a reference
    - verify_auth(): Check if stored tokens are valid
    """

    platform: str = "base"

    async def post(
        self,
        text: str,
        media_paths: Optional[List[str]] = None,
        reply_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        raise NotImplementedError

    async def upload_media(
        self,
        file_path: str,
        media_type: Optional[str] = None,
    ) -> Dict[str, Any]:
        raise NotImplementedError

    async def delete_post(self, post_id: str) -> Dict[str, Any]:
        raise NotImplementedError(f"Delete is not supported on {self.platform}")

    async def verify_auth(self) -> Dict[str, Any]:
        raise NotImplementedError
