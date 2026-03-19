# Social Platform Auth & Posting Reference

Extracted from Postiz source code analysis (2026-03-19).

## Twitter / X

- **Auth:** OAuth 1.0a (hybrid — v1 for media, v2 for posting)
- **Scopes:** None declared. App-level "Read and Write" permission in developer dashboard
- **Token expiry:** Never. OAuth 1.0a tokens are permanent unless revoked
- **Token storage format:** `accessToken:accessSecret` (colon-joined)
- **Refresh:** Not needed
- **Developer portal:** https://developer.twitter.com/en/portal/dashboard
- **App type:** MUST select "Native App" — "Web App" causes error 32
- **Callback:** `/integrations/social/x`
- **Media upload:** Direct buffer upload via v1 API (`upload.twitter.com/1.1/media/upload.json`), chunked INIT/APPEND/FINALIZE
- **Posting:** v2 API (`api.x.com/2/tweets`)
- **Rate limit:** 300 posts per 3 hours
- **Text limit:** 200 chars standard, 4000 chars premium
- **Pricing:** Pay-per-use, $0.01/post (as of 2026-03-19)
- **Gotchas:** Duplicate text within a timeframe is rejected

## YouTube

- **Auth:** OAuth 2.0 (Authorization Code with `access_type=offline`, `prompt=consent`)
- **Scopes:** `userinfo.email`, `userinfo.profile`, `youtube`, `youtube.upload`, `youtube.force-ssl`, `youtubepartner`, `yt-analytics.readonly`, `yt-analytics-monetary.readonly`
- **Token expiry:** Access ~1hr, refresh token long-lived
- **Refresh:** Fully implemented via Google OAuth2 client `refreshAccessToken()`
- **Developer portal:** Google Cloud Console — enable YouTube Data API v3, YouTube Analytics API, YouTube Reporting API
- **App type:** OAuth 2.0 "Web application"
- **Callback:** `/integrations/social/youtube`
- **Media upload:** Streaming upload via YouTube Data API `videos.insert`
- **Gotchas:** Refresh token only issued on first auth (need `prompt=consent` to force reissuance). Brand accounts need up to 5hrs for propagation

## Facebook

- **Auth:** OAuth 2.0 (Authorization Code → short-lived token → `fb_exchange_token` → long-lived token)
- **Scopes:** `pages_show_list`, `business_management`, `pages_manage_posts`, `pages_manage_engagement`, `pages_read_engagement`, `read_insights`
- **Token expiry:** 59 days (long-lived token)
- **Refresh:** NOT implemented — must re-auth after 59 days
- **Developer portal:** https://developers.facebook.com/apps — App type "Other" → "Business"
- **Products needed:** "Login with Facebook for Business"
- **App mode:** MUST be set to "Live" — Development mode posts only visible to you
- **Callback:** `/integrations/social/facebook`
- **Media upload:** Photos: `POST /v20.0/{page_id}/photos` with `published: false`, collect IDs, attach via `attached_media[]`. Videos: `POST /v20.0/{page_id}/videos` with file URL
- **Gotchas:** Shares credentials with Instagram. Business verification required for advanced permissions

## LinkedIn

- **Auth:** OAuth 2.0 (Authorization Code Grant)
- **Scopes:** `openid`, `profile`, `w_member_social`, `r_basicprofile`, `rw_organization_admin`, `w_organization_social`, `r_organization_social`
- **Token expiry:** Varies
- **Refresh:** Fully implemented. POST to `https://www.linkedin.com/oauth/v2/accessToken` with `grant_type=refresh_token`
- **Developer portal:** https://www.linkedin.com/developers/apps
- **Products needed:** "Sign In with LinkedIn using OpenID Connect", "Share on LinkedIn", "Advertising API" (requires form)
- **Callback:** `/integrations/social/linkedin` (personal), `/integrations/social/linkedin-page` (pages)
- **Media upload:** Multi-step chunked upload: initialize via `/rest/images|videos?action=initializeUpload`, PUT chunks in 2MB segments, finalize with ETags
- **Character limit:** 3000 chars
- **Gotchas:** Advertising API approval REQUIRED for token refresh. Without it, refresh tokens break. Supports personal (`urn:li:person`) and company (`urn:li:organization`) posting

## Instagram

- **Auth:** OAuth 2.0 via Facebook Graph API (same flow as Facebook)
- **Scopes:** `instagram_basic`, `pages_show_list`, `pages_read_engagement`, `business_management`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`
- **Token expiry:** ~60 days (via `fb_exchange_token`)
- **Refresh:** NOT implemented — re-auth required after ~60 days
- **Developer portal:** Same Meta app as Facebook — no separate app needed
- **Callback:** `/integrations/social/instagram` (business), `/integrations/social/instagram-standalone` (standalone)
- **Media upload:** Two-stage: POST to `/v20.0/{ig_user_id}/media` with media URL → poll `status_code` every 30s → POST `/v20.0/{ig_user_id}/media_publish`
- **Post types:** Single image/video, carousel, stories (single item only)
- **Gotchas:** 25 posts/day hard cap. Aspect ratio 4:5 to 1.91:1. Caption limit 2200 chars. Requires professional/business account. Carousels don't support collaborators. Stories can't be carousels

## TikTok

- **Auth:** OAuth 2.0 (Authorization Code via Login Kit)
- **Scopes:** `video.list`, `user.info.basic`, `video.publish`, `video.upload`, `user.info.profile`, `user.info.stats`
- **Token expiry:** 23 hours (most aggressive)
- **Refresh:** Fully implemented with token rotation. POST to `https://open.tiktokapis.com/v2/oauth/token/` with `grant_type=refresh_token`. New refresh token returned each time — MUST persist it
- **Developer portal:** https://developers.tiktok.com/apps — requires public HTTPS website, ToS, Privacy Policy
- **Products needed:** "Login Kit", "Content Posting API" with "Direct Post" enabled
- **Callback:** HTTPS mandatory — no HTTP allowed
- **Media upload:** Pull-based — TikTok fetches from a public HTTPS URL you provide. Cannot upload from localhost. Need R2/S3/CDN
- **Caption limit:** 2000 chars
- **Gotchas:** Client ID = 16 chars, secret = 32 chars. Text-only posts NOT supported — must include video/photos. Two post methods: DIRECT_POST (feed) or UPLOAD (inbox first). Media domain ownership verification required
