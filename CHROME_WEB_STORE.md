# Chrome Web Store submission

Prepared for **Browser Profile MCP v0.5.3**. The listing copy, graphics, real panel captures, privacy declarations, and reviewer instructions are available below. Nothing has been submitted to the store.

## Files to upload or paste

| Dashboard field | File or value |
| --- | --- |
| Extension package | `dist/browser-profile-mcp-extension-v0.5.3.zip`, also available in [release v0.5.3](https://github.com/guilhermegm/browser-profile-mcp/releases/tag/v0.5.3) |
| Name | Browser Profile MCP |
| Description, category, language, URLs | [listing.txt](branding/cws/listing.txt) |
| Store icon, 128 × 128 | [store-icon-128.png](branding/cws/store-icon-128.png) |
| Screenshot 1, 1280 × 800 | [Setup](branding/cws/screenshots/01-setup-1280x800.png) |
| Screenshot 2, 1280 × 800 | [Start your agent](branding/cws/screenshots/02-start-agent-1280x800.png) |
| Screenshot 3, 1280 × 800 | [Connected and controls](branding/cws/screenshots/03-connection-controls-1280x800.png) |
| Small promotional tile, 440 × 280 | [promo-small-440x280.png](branding/cws/promo-small-440x280.png) |
| Marquee, 1400 × 560 | [promo-marquee-1400x560.png](branding/cws/promo-marquee-1400x560.png) |
| Single purpose, permission reasons, remote code, data types | [privacy-declarations.txt](branding/cws/privacy-declarations.txt) |
| Privacy policy URL | <https://github.com/guilhermegm/browser-profile-mcp/blob/main/PRIVACY.md> |
| Test/reviewer instructions | [reviewer-instructions.txt](branding/cws/reviewer-instructions.txt) |
| Support URL | <https://github.com/guilhermegm/browser-profile-mcp/issues> |

Upload **only the extension ZIP** in the package field. The bridge and complete CWS kit are separate downloads, not extension packages. A video is optional and has not been produced.

## Submit

1. Create or open the item in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole), then upload the extension ZIP.
2. Fill the listing from `listing.txt`; upload the icon, the three screenshots above, and the optional promotional tiles. Use the detailed-description text between its marked boundaries.
3. Complete Privacy practices from `privacy-declarations.txt`. This includes requested page data even though the bridge runs locally. Read and personally attest to the dashboard's data-use certification statements. Enter the public privacy policy URL.
4. Paste `reviewer-instructions.txt` into the reviewer/test-instructions field. Reviewers can use their own coding agent or the included SDK procedure without an AI account. Never enter a real user pairing code or developer credentials.
5. Set the publisher account's real contact details, desired distribution countries, and visibility. These account choices are not invented by the repository. Ensure the linked privacy policy reflects the submitted version and is publicly accessible.
6. Before clicking Submit for review, confirm a fresh-install flow through the intended Codex/Claude Code client and a harmless page action. The captures establish a real extension/bridge connection, not complete provider-client validation.

## What the images show

The three store images contain original pixels captured from this extension installed in a disposable headless Chromium profile, with explanatory captions alongside the panel. The first is unpaired. The second has a newly created disposable pairing and waits for an agent. The third shows a real local stdio MCP SDK client attached after listing a harmless local tab, with Connection settings expanded. No AI-provider login, real account, existing Chrome profile, clipboard, or saved user pairing is used.

The capture does not fabricate Connected state, redraw the interface, or insert a pairing code into an image. [capture-info.json](branding/cws/screenshots/capture-info.json) records the method and its limits. Reproduce it with `npm run capture:cws` after installing development dependencies and Playwright Chromium. It is an explicit asset-capture command; `npm test` does not launch it. It does not run the browser test suite or request browser/OS permissions.

The older files in `branding/cws/capture-templates/` remain marked drafts for possible future action demonstrations. They are excluded from the CWS kit and must not be uploaded. The portrait README previews are a separate documentation asset.

## Build the handoff ZIP

Run `npm run build:cws` to produce `dist/browser-profile-mcp-cws-kit-v0.5.3.zip`. It contains the extension ZIP, the three landscape screenshots, icon, optional tiles, listing copy, privacy declarations, reviewer instructions, policy, licenses, and checksums. No draft layouts, runtime credentials, or Node dependencies are included. The extension and bridge downloads remain those of the matching release.

Packaging requires Python 3 with the dependencies in `branding/requirements.txt`, plus the project's Node.js dependencies. Recapturing the panels also requires Playwright Chromium; packaging uses the captures already in the repository.

## Validation limits

The store capture used the production extension, a separate temporary helper installation, a real saved pairing, and a real SDK tab-listing call. It did not test account subscriptions, agent-specific registration, Chrome restarts, multi-profile behavior, or page clicks. The broader opt-in browser test suite remains incomplete and is not claimed as a release pass. CWS approval is determined by Google's review.

Requirements checked October 24, 2026: [listing fields](https://developer.chrome.com/docs/webstore/cws-dashboard-listing), [image dimensions](https://developer.chrome.com/docs/webstore/images), [privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), and [local data disclosure](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).
