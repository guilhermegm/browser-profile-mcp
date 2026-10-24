# Security

Report vulnerabilities privately through [GitHub security advisories](https://github.com/guilhermegm/browser-profile-mcp/security/advisories/new). Include the affected version, reproduction steps, and impact. Use disposable profiles and test accounts when preparing a reproduction.

Do not put pairing codes, `.browser-mcp/` files, environment files, account data, or private page content into public issues. A pairing code grants access to its browser profile; treat it as a credential. If a code has been exposed, create a replacement pairing with `--reset`, update the extension, and reconnect your agent sessions.

The supported security update line is the current published release. Keep the extension and local bridge on the same version.

The bridge binds to loopback and uses authenticated encrypted connections. These protect the connection; they do not sandbox a coding agent that can read local credential files. Browser actions use real website sessions. A connected agent can read pages and perform actions in its paired profile, subject to the agent client's tool controls.

Release packages contain source files and dependency manifests, never runtime credentials or installed dependencies. SHA256SUMS accompanies downloads. See [PRIVACY.md](PRIVACY.md) for the data flow.
