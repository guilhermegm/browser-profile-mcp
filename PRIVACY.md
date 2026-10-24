# Privacy

Last updated: October 24, 2026.

Browser Profile MCP connects a Chrome extension to a Node.js bridge on the same computer. The bridge listens on `127.0.0.1`; this project does not operate a hosted browser-control service or include analytics, advertising, or data sales. The open-source project is maintained at [guilhermegm/browser-profile-mcp](https://github.com/guilhermegm/browser-profile-mcp).

## Information used for browser control

When an agent requests a browser tool, the extension may return tab titles and URLs, visible page text, accessibility information, or a screenshot. The local bridge forwards that information to the connected coding-agent client. That client may send it to its AI provider according to its own configuration and privacy policies. Using a local bridge does not mean all page data stays on the computer.

The extension also processes the agent's requested browser actions and input, including typed text, clicks, scrolling, navigation, and form interactions. Depending on the pages and inputs you choose, this information can contain personal identifiers, health or financial information, authentication values, messages, location details, and other sensitive website content. The tools do not automatically redact sensitive information. There is no passive recorder of your manual browsing or keystrokes, and no tool to export Chrome's stored history or cookie database.

This data is used to carry out browser tools requested through your paired agent. It is not used by this project for advertising, credit decisions, or unrelated profiling. Browser Profile MCP's use and transfer of information received from Google APIs adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use), including its Limited Use requirements.

## Local storage and retention

Pairing credentials, a randomly generated installation identity, connection preferences, clipboard-shortcut preference, and the last connection interruption are saved in the extension's local Chrome storage. Chrome Sync is not used. The side panel also remembers the setup profile name in local browser storage. The installation identity binds a pairing to that extension installation; it is not sent to a developer analytics service.

The bridge saves per-profile credentials and startup/connection logs in its installation's `.browser-mcp/` directory. Logs can include profile names, connection timestamps, and connection error details. These files are local runtime state and are excluded from the source repository and release downloads. The bridge does not intentionally write page text, screenshots, or tool conversations to its logs. Browser results and commands are processed in memory; the coding agent may separately retain them in its conversation history, logs, or provider services.

Saved pairing data and local logs remain until removed; there is no scheduled deletion of those files. Your operating system, backups, coding agent, and AI provider can retain their own copies under their own settings. Pairing credentials are local secrets stored in Chrome storage and restricted bridge files; they are not claimed to be encrypted at rest by this application.

## Connections and third parties

The extension and bridge authenticate each other and encrypt command payloads on the loopback connection. The bridge exposes no hosted account service. Setup can download the open-source bridge from GitHub Releases and dependencies from npm over HTTPS. GitHub and npm process those ordinary download requests under their own policies. Websites you open or interact with receive normal browser requests and inputs, using that Chrome profile's existing sessions.

Your selected coding-agent client and any AI provider it uses are separate services. Their retention, training settings, account requirements, and privacy policies apply to data you give them. Check those settings before allowing an agent to inspect sensitive pages. The developer does not receive browser tool results through a project-operated service.

## Your controls and deletion

System clipboard shortcuts are disabled by default. If enabled in the extension, they access the computer's shared clipboard. Typed text and browser actions operate in the actual paired Chrome profile and its existing website sessions.

Disconnect stops the extension connection. Redo setup removes the extension's saved pairing; it does not remove files from the local bridge installation or delete agent configuration. To remove the integration completely, remove its MCP entry from your agent, delete the bridge installation and its `.browser-mcp/` directory, and uninstall the extension from the Chrome profile.

Closing the side panel keeps the background connection available. Stop current actions cancels pending work but cannot undo actions a website has already received. Clearing extension data or uninstalling removes its local settings and installation identity. Deleting local integration files does not delete messages, submissions, or other changes already made on websites, or copies retained by your coding agent or provider.

## Contact

For privacy questions, use [GitHub Issues](https://github.com/guilhermegm/browser-profile-mcp/issues). Do not include private page content, pairing codes, or local credential files. For a vulnerability or sensitive security report, use [private vulnerability reporting](https://github.com/guilhermegm/browser-profile-mcp/security/advisories/new).
