# Support

This document covers setup help and troubleshooting for Terminal Notifier.

If you need help, open an issue:

```text
https://github.com/Nikhilr-28/terminal_notifier/issues
```

Please do not post private notification settings or sensitive command output in public issues.

## Quick checklist

Before reporting a bug, check this first:

1. VS Code is open.
2. Your computer is awake.
3. The command was started through Terminal Notifier.
4. Your notification channel is saved.
5. The `Test` button works for the selected channel.
6. Your internet connection is active.
7. The command works in a normal terminal.
8. A local log was created under `.vscode/terminal-notifier/logs`.

## What to include in an issue

Please include:

```text
OS:
VS Code version:
Terminal Notifier version:
Notification channel:
Output mode:
Command used:
Expected behavior:
Actual behavior:
Error message:
Relevant log snippet:
```

Remove private values before posting.

## Telegram help

### Test alert does not arrive

Try this sequence:

1. Confirm the bot value was copied correctly.
2. Open the bot in Telegram.
3. Send the bot a short message.
4. Return to the Notifier panel.
5. Click `Fetch Chat ID`.
6. Select the detected chat row.
7. Click `Save`.
8. Click `Test`.

The bot must receive at least one message before the chat can be detected.

### Fetch Chat ID shows no results

Common causes:

- The bot has not received a message yet.
- The message was sent to a different bot.
- The saved bot value belongs to another bot.
- Telegram has not returned the update yet.

Try sending a new message to the bot, wait a few seconds, then fetch again.

### Telegram reports a chat problem

Common causes:

- The chat ID does not match the selected bot.
- The bot was blocked.
- The bot was deleted.
- A new bot value was generated but the old one is still saved.

Fix:

1. Send a fresh message to the bot.
2. Fetch the chat ID again.
3. Save.
4. Test.

## Discord help

### Test alert does not arrive

Check:

1. The webhook URL was pasted completely.
2. The webhook still exists in Discord.
3. The selected channel still exists.
4. The webhook is attached to the channel you expect.
5. You clicked `Save`.
6. You clicked `Test`.

### Discord reports a webhook problem

Try creating a new webhook:

1. Open Discord.
2. Open the target server and channel.
3. Open channel settings.
4. Open `Integrations`.
5. Open `Webhooks`.
6. Create a new webhook.
7. Copy the new URL.
8. Paste it into Terminal Notifier.
9. Save.
10. Test.

### Message is too long

Use `Final Output` mode.

You can also reduce:

```json
{
  "terminalNotifier.maxNotificationCharacters": 8000
}
```

## Command execution help

### Command does not start

Try running the same command in a normal VS Code terminal.

If it fails there, Terminal Notifier will likely fail too.

Check:

- Command spelling.
- Current workspace folder.
- Relative paths.
- PATH availability.
- Python or Node environment availability.
- Whether the command requires interactive input.

Terminal Notifier is best for non-interactive commands.

### Command works in a normal terminal but not in Terminal Notifier

Try:

1. Use absolute paths.
2. Open the correct workspace folder.
3. Restart VS Code.
4. Check the generated local log.
5. Confirm required tools are available from VS Code.

### Command waits forever

The command may be waiting for user input.

Avoid commands that ask for:

- passwords
- confirmations
- menu selections
- interactive prompts

### Python output appears out of order

Terminal Notifier sets unbuffered Python output and merges error output into normal output to improve ordering.

Some frameworks still buffer their own logs.

For Python scripts, use:

```python
print("message", flush=True)
```

## Notification content help

### Notification preview has no line breaks

Some operating system notification previews compress line breaks.

Open the actual Telegram or Discord message to see the formatted content.

### Output is missing

Check:

1. Whether the command printed anything.
2. Whether `Final Output` mode was selected.
3. Whether the final output line count is too low.
4. The local log file.

Increase:

```json
{
  "terminalNotifier.finalOutputLineCount": 120
}
```

### Output was shortened

This is expected when output exceeds the notification limit.

Check the full local log:

```text
.vscode/terminal-notifier/logs/
```

## Command history help

### Ctrl + Up / Ctrl + Down does not work

Some systems or extensions may capture these shortcuts.

Use the visible buttons instead:

```text
↑ Prev
↓ Next
```

### History is empty

History is saved after commands are run through Terminal Notifier.

Run one command first, then try history recall.

### History differs between projects

This is expected.

Command history is saved per workspace.

## Logs

Terminal Notifier saves local logs under:

```text
.vscode/terminal-notifier/logs/
```

Typical files:

```text
run-*.log
payload-*.json
payload-*.txt
```

Use logs to inspect:

- full output
- failed commands
- failed notifications
- exit codes
- truncated notifications

Do not commit generated logs.

## Safe usage

- Review logs before sharing them.
- Do not paste private values in public issue reports.
- Do not run commands you do not trust.
- Use Terminal Notifier only in trusted workspaces.
- Keep your computer awake for long-running jobs.

## Known limitations

- VS Code must remain open.
- The computer must stay awake.
- Already-running terminals are not captured.
- The extension captures commands started through Terminal Notifier.
- Interactive commands are not ideal.
- Long notifications may be shortened.
- Full output is kept in local logs.
- Telegram and Discord require internet access.

## Recommended setup for long jobs

For long training, build, and processing jobs:

1. Plug in your laptop.
2. Disable sleep while the job runs.
3. Use `Final Output` mode.
4. Print clear final metrics.
5. Save checkpoints inside your script.
6. Test the channel before starting a long job.
7. Check local logs after completion.

Example final prints:

```python
print(f"best_val_acc={best_val_acc}", flush=True)
print(f"final_test_acc={test_acc}", flush=True)
print("training_complete", flush=True)
```

## Repository

```text
https://github.com/Nikhilr-28/terminal_notifier
```
