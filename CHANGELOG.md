# Changelog

All notable changes to Terminal Notifier will be documented in this file.

## [1.1.0] - 2026-05-27

### Added

- Added active-run controller inside the Notifier panel.
- Added live output preview for running commands.
- Added scrollable active output area.
- Added active input box for simple stdin-style prompts.
- Added `Send`, `Send empty line`, `Stop`, `Open terminal`, and `Clear output` controls.
- Added current directory field in the Notifier UI.
- Added workspace-specific current directory memory.
- Added internal `cd` handling so directory changes persist across Notifier runs.
- Added environment modes:
  - None
  - Conda environment
  - Python executable
  - Custom prefix
- Added Python executable mode for interactive Python workflows.
- Added stronger stop handling for long-running local processes.
- Added clearer active-run status borders for running, success, and error states.
- Added cleaner Final Output handling for long jobs.
- Added better formatting for mobile-friendly completion messages.
- Added improved support for ML, AI, training, evaluation, and script workflows.

### Changed

- Reworked the Notifier panel into a more complete run-control experience.
- Improved the distinction between `Final Output` and `Full Terminal`.
- Made command history automatic when commands are run.
- Improved current directory visibility.
- Reduced noisy output in completion messages where possible while preserving local logs.
- Made buttons more visually distinct in the Notifier UI.
- Updated Marketplace documentation for the public v1.1.0 release.

### Fixed

- Fixed `cd` commands not persisting across runs.
- Fixed environment workflows that depended on shell activation state.
- Fixed interactive Python scripts failing when a direct Python executable is used.
- Fixed inability to send simple interactive input from the Notifier panel.
- Fixed active-run output causing the UI to grow too much.
- Fixed clear-output behavior so it only affects the visible preview.
- Fixed stop behavior so long-running commands can be terminated more reliably.

### Notes

- Terminal Notifier does not capture already-running terminals.
- Terminal Notifier is not intended to replace a full terminal emulator.
- VS Code must remain open and the computer must stay awake while local commands run.
- Full output remains available in local logs even when completion messages are shortened.

## [0.1.1] - 2026-05-25

### Added

- Initial public Marketplace release.
- Added dedicated `Notifier` bottom panel UI.
- Added terminal bell shortcut for quick `Run + Notify` access.
- Added Telegram notification channel.
- Added Discord notification channel.
- Added test notification flow.
- Added two output modes:
  - `Final Output`
  - `Full Terminal`
- Added local command execution through an extension-controlled terminal.
- Added stdout and stderr capture.
- Added process exit code detection.
- Added mobile-friendly notification formatting.
- Added local run logs under `.vscode/terminal-notifier/logs`.
- Added workspace-specific command history.
- Added command recall using:
  - `Ctrl + ↑`
  - `Ctrl + ↓`
  - `↑ Prev`
  - `↓ Next`
- Added local secure storage for channel settings.
- Added direct notification delivery without a separate local backend server.

### Changed

- Removed the old local backend runtime requirement.
- Simplified the Notifier panel UI for a cleaner workflow.
- Updated notification payloads for compact mobile readability.

### Notes

- Email, SMS, WhatsApp, and hosted relay support are not included.
- The machine must stay awake while local commands are running.
