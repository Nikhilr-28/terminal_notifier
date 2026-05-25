# Terminal Notifier

Terminal Notifier is a VS Code extension PoC that adds a terminal toolbar button for running long commands and sending email notifications when they finish.

## MVP behavior

- Adds a `Run + Notify` button to the VS Code Terminal panel.
- Saves recipient email for future runs.
- Runs command through an extension-controlled terminal.
- Captures stdout and stderr.
- Supports:
  - Final Output
  - Full Terminal
- Saves local logs under `.vscode/terminal-notifier/logs`.
- Sends report to a local backend email relay.

## Local backend

The backend lives in `backend/`.

Start dry-run backend:

```powershell
cd backend
npm install
copy .env.example .env
npm run dev