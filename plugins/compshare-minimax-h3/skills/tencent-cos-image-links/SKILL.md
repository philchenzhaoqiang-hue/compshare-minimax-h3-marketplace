---
name: tencent-cos-image-links
description: Batch collect and validate direct public image URLs from Tencent Cloud COS folders for MiniMax H3. Use when the user wants to avoid copying COS object links one by one, provides a COS console bucket or folder, or asks for MiniMax-ready URLs from uploaded COS images. Do not treat COSBrowser share pages or temporary links as direct image URLs.
---

# Tencent COS Image Links

Produce a reusable list of public COS object URLs that MiniMax H3 can fetch directly.

## Workflow

1. Check for a Tencent COS connector, API, or CLI capability before using browser automation. If none can perform the lookup, use the available browser-control skill and prefer an already signed-in Tencent Cloud console tab.
2. Keep the lookup read-only. If authentication is required, let the user complete sign-in; never request or inspect passwords, verification codes, cookies, or session storage.
3. Determine the bucket name, region, and current object prefix from the console URL and visible breadcrumb. COS console `path` parameters can be encoded more than once; decode them until they represent the visible object prefix, then encode each URL path segment exactly once when constructing object URLs.
4. Read every object page in scope. Respect the displayed object count and page size, paginate when needed, and collect image object names in their visible order. Include PNG, JPG, and JPEG objects unless the user requests another filter.
5. Construct URLs in virtual-hosted form:

   `https://<bucket>.cos.<region>.myqcloud.com/<encoded-prefix>/<encoded-object-name>`

6. Validate every URL in parallel with an HTTP `HEAD` request. Accept only `200` responses whose `Content-Type` begins with `image/png` or `image/jpeg`. If a server rejects `HEAD`, retry that URL with a minimal ranged `GET`. Report invalid or inaccessible objects separately.
7. Save the validated URLs as a UTF-8 text file in the active workspace, one URL per line, using a descriptive filename such as `minimax-h3-image-urls.txt`. Open the result in Codex when helpful and report total, valid, and invalid counts.

## Constraints

- Never use a `cosbrowser.cloud.tencent.com/share/` page, extraction code, or expiring console temporary link as a MiniMax input URL. Those return HTML or expire.
- Do not change bucket, folder, or object permissions unless the user explicitly asks. If validation returns `403`, explain that public-read access or a sufficiently long-lived presigned URL is required. Prefer object-level public read over exposing an entire bucket.
- Do not expose account credentials, API keys, cookies, access tokens, or signed query parameters in logs or output.
- MiniMax H3 accepts at most nine reference images in one generation request. A larger URL inventory is still useful for selecting inputs across multiple requests.

