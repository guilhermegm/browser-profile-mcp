Browser Profile MCP local helper

Copy this entire folder to a stable installation location, preserving any
existing .browser-mcp folder. Install Node.js 20+ and run:

  npm ci --omit=dev --ignore-scripts
  node bridge.js profile work

The profile command prints a pairing code and agent registration commands.
The coding agent starts mcp.js automatically after registration. Do not use
npm start for daily use. Never distribute a .browser-mcp credentials folder.
