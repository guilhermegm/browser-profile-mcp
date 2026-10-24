# Privacy

Browser Profile MCP connects a Chrome extension to a Node.js bridge on the same computer. The bridge listens on `127.0.0.1`; this project does not operate a hosted browser-control service or include analytics.

When an agent requests a browser tool, the extension may return tab titles and URLs, visible page text, accessibility information, or a screenshot. The local bridge forwards that information to the connected coding-agent client. That client may send it to its AI provider according to its own configuration and privacy policies. Using a local bridge does not mean all page data stays on the computer.

Pairing information and connection preferences are saved in the extension's local Chrome storage. The bridge saves per-profile credentials and startup logs in its installation's `.browser-mcp/` directory. These files are local runtime state and are excluded from the source repository and release downloads.

System clipboard shortcuts are disabled by default. If enabled in the extension, they access the computer's shared clipboard. Typed text and browser actions operate in the actual paired Chrome profile and its existing website sessions.

Disconnect stops the extension connection. Redo setup removes the extension's saved pairing; it does not remove files from the local bridge installation or delete agent configuration. To remove the integration completely, remove its MCP entry from your agent, delete the bridge installation and its `.browser-mcp/` directory, and uninstall the extension from the Chrome profile.
