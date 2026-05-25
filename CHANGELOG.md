# Changelog

All notable changes to Terminal Notifier will be documented in this file.

## [0.0.1] - 2026-05-25

### Added

- Initial Marketplace-ready MVP release.
- Added a dedicated `Notifier` bottom panel UI.
- Added a terminal bell shortcut for quick `Run + Notify` access.
- Added direct Telegram notification support.
- Added direct Discord webhook notification support.
- Added Telegram setup flow:
  - Bot token input.
  - Chat ID input.
  - Fetch Chat ID helper.
  - Test notification.
- Added Discord setup flow:
  - Webhook URL input.
  - Show/Hide webhook URL toggle.
  - Test notification.
- Added two notification output modes:
  - `Final Output`
  - `Full Terminal`
- Added local command execution through an extension-controlled terminal.
- Added stdout and stderr capture.
- Added process exit code detection.
- Added improved Python stdout/stderr ordering with unbuffered Python execution.
- Added mobile-friendly notification formatting.
- Added local run logs and payload files under `.vscode/terminal-notifier/logs`.
- Added workspace-specific command history.
- Added command recall using:
  - `Ctrl + ↑`
  - `Ctrl + ↓`
  - `↑ Prev`
  - `↓ Next`
- Added VS Code Secret Storage support for:
  - Telegram bot tokens.
  - Telegram chat IDs.
  - Discord webhook URLs.
- Added direct notification delivery without a local backend server.

### Changed

- Removed the old local backend runtime requirement for Telegram and Discord.
- Simplified the Notifier panel UI for a cleaner, scroll-friendly workflow.
- Reduced terminal notifier output clutter.
- Updated notification payloads for compact mobile readability.

### Notes

- Email, SMS, WhatsApp, and hosted relay support are not included in this version.
- VS Code must remain open while commands are running.
- The machine must stay awake while local commands are running.
- Long outputs may be truncated in notifications, but full local logs are saved.