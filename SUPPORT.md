# Support

This document explains how to get help with Terminal Notifier and how to troubleshoot common issues.

Terminal Notifier is a VS Code extension that runs commands and sends Telegram or Discord notifications when those commands finish.

---

## Quick checklist

Before opening an issue, check the basics:

1. VS Code is open.
2. Your computer is awake.
3. The command was started through Terminal Notifier.
4. Your notification channel is configured.
5. You clicked `Test` and confirmed the notification channel works.
6. Your internet connection is active.
7. The command works when run manually in a normal terminal.
8. Logs exist under `.vscode/terminal-notifier/logs`.

---

## Where to get help

Open an issue on GitHub:

```text
https://github.com/Nikhilr-28/terminal_notifier/issues
```

Please include:

- VS Code version
- Operating system
- Terminal Notifier version
- Notification channel used: Telegram or Discord
- Output mode used: Final Output or Full Terminal
- Steps to reproduce
- Error message
- Relevant local log snippet

Do not include secrets.

Never post:

- Telegram bot tokens
- Discord webhook URLs
- Private training logs
- Sensitive local paths if you do not want them public

---

## Telegram troubleshooting

### Telegram test notification does not arrive

Check the following:

1. The bot token is correct.
2. You messaged the bot at least once.
3. You clicked `Fetch Chat ID`.
4. You selected the detected Chat ID row.
5. You clicked `Save`.
6. You clicked `Test`.

The Telegram bot must receive a message before its chat ID can be detected.

Send this to your bot:

```text
hello
```

Then return to VS Code and click:

```text
Fetch Chat ID
```

### Bot token looks correct but still fails

Try this:

1. Open Telegram.
2. Open BotFather.
3. Regenerate the bot token.
4. Paste the new token into Terminal Notifier.
5. Save.
6. Fetch Chat ID again.
7. Test again.

If you regenerated the token, the old token is invalid.

### Fetch Chat ID returns no updates

Possible causes:

- You did not message the bot yet.
- You messaged the wrong bot.
- The token belongs to a different bot.
- Telegram has not returned the update yet.

Fix:

1. Open your bot.
2. Send a new message:

```text
hello
```

3. Wait a few seconds.
4. Click `Fetch Chat ID` again.

### Telegram says chat not found

Possible causes:

- Wrong chat ID.
- Bot token and chat ID belong to different bots.
- The bot was blocked.
- The bot was deleted.

Fix:

1. Send a new message to the bot.
2. Fetch the chat ID again.
3. Save.
4. Test.

---

## Discord troubleshooting

### Discord test notification does not arrive

Check the following:

1. The webhook URL is correct.
2. The webhook was not deleted.
3. The Discord channel still exists.
4. The webhook has permission to post in the channel.
5. You clicked `Save`.
6. You clicked `Test`.

The webhook URL should start with:

```text
https://discord.com/api/webhooks/
```

Some older URLs may start with:

```text
https://discordapp.com/api/webhooks/
```

### Webhook URL is invalid

Create a new webhook:

1. Open Discord.
2. Open your server.
3. Select the target channel.
4. Open channel settings.
5. Go to `Integrations`.
6. Open `Webhooks`.
7. Create a new webhook.
8. Copy the new webhook URL.
9. Paste it into Terminal Notifier.
10. Save and test.

### Discord rejected the message

Possible causes:

- Message too long.
- Webhook deleted.
- Webhook URL copied incorrectly.
- Channel permissions changed.

Fix:

1. Use `Final Output` mode instead of `Full Terminal`.
2. Reduce `terminalNotifier.maxNotificationCharacters`.
3. Create a new webhook.
4. Save and test again.

---

## Command execution troubleshooting

### Command does not run

Try running the command manually in a normal VS Code terminal first.

If it fails there, it will likely fail through Terminal Notifier too.

Check:

- Is the command spelled correctly?
- Is Python or Node available in PATH?
- Is the virtual environment activated globally or available from the workspace?
- Are relative paths correct?
- Is the workspace folder correct?
- Does the command require interactive input?

Terminal Notifier is best for non-interactive commands.

### Command works manually but not through Terminal Notifier

Try:

1. Use an absolute path.
2. Open the correct workspace folder.
3. Check the generated log under:

```text
.vscode/terminal-notifier/logs/
```

4. Confirm your shell environment is available to VS Code.
5. Restart VS Code and try again.

### Python output appears out of order

Terminal Notifier sets:

```text
PYTHONUNBUFFERED=1
```

and merges stderr into stdout for better ordering.

If output still looks strange, the script or framework may buffer its own logs.

Try adding explicit flushes in Python:

```python
print("message", flush=True)
```

### Command waits forever

The command may be asking for input.

Terminal Notifier is designed for long-running non-interactive jobs. Avoid commands that require prompts such as:

- password input
- interactive confirmations
- menu selections
- manual stdin responses

---

## Notification content troubleshooting

### Notification is too long

Use `Final Output` mode.

You can also lower:

```json
{
  "terminalNotifier.maxNotificationCharacters": 12000
}
```

### I need more final lines

Increase:

```json
{
  "terminalNotifier.finalOutputLineCount": 120
}
```

### Full output was truncated

This is expected when the output exceeds the notification size limit.

Check the full local log:

```text
.vscode/terminal-notifier/logs/
```

### Mobile notification preview has no line breaks

Some mobile notification previews collapse line breaks. Open the actual Telegram or Discord message to see the formatted content.

Terminal Notifier formats messages with indentation for readability inside the app, but the operating system notification preview may still compress it.

---

## Command history troubleshooting

### Ctrl + Up / Ctrl + Down does not work

Try the visible buttons:

```text
↑ Prev
↓ Next
```

Some systems or extensions may capture keyboard shortcuts before the webview receives them.

### Command history is empty

Command history is saved after you run commands through Terminal Notifier.

Run one command first, then try:

```text
Ctrl + ↑
```

### Command history is different in another project

This is expected.

Terminal Notifier stores command history per workspace, so each project has its own history.

---

## Logs and payloads

Terminal Notifier saves run data under:

```text
.vscode/terminal-notifier/logs/
```

Files may include:

```text
run-*.log
payload-*.json
payload-*.txt
```

Use these files to debug:

- failed commands
- failed notifications
- truncated output
- process exit codes

Do not commit this folder.

Recommended `.gitignore` entry:

```gitignore
.vscode/terminal-notifier/
```

---

## Security guidance

### Protect Telegram tokens

A Telegram bot token gives access to your bot.

If exposed:

1. Open BotFather.
2. Revoke or regenerate the token.
3. Update Terminal Notifier with the new token.

### Protect Discord webhooks

A Discord webhook URL allows posting to that channel.

If exposed:

1. Delete the webhook in Discord.
2. Create a new webhook.
3. Update Terminal Notifier with the new URL.

### Do not share sensitive logs

Command output may contain:

- dataset paths
- API keys
- model names
- stack traces
- usernames
- private project paths
- research details

Review logs before sharing them publicly.

---

## Known limitations

Terminal Notifier currently has these limitations:

- VS Code must remain open.
- Your computer must stay awake.
- The command must be started through Terminal Notifier.
- Already-running terminal commands are not captured.
- Interactive commands are not ideal.
- Very long notifications are truncated.
- Telegram and Discord require internet access.
- The extension does not currently provide email, SMS, or WhatsApp support.

---

## Recommended setup for long ML/DL jobs

For long training runs:

1. Plug in your laptop.
2. Disable sleep while training.
3. Use `Final Output` mode.
4. Print final metrics clearly.
5. Save checkpoints inside your script.
6. Test the notification channel before starting a long run.
7. Check local logs after completion if needed.

Example final training prints:

```python
print(f"best_val_acc={best_val_acc}", flush=True)
print(f"final_test_acc={test_acc}", flush=True)
print("training_complete", flush=True)
```

This makes the mobile notification much more useful.

---

## Issue template suggestion

When reporting a bug, include this format:

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

Remove secrets before posting.

---

## Repository

```text
https://github.com/Nikhilr-28/terminal_notifier
```

## Issues

```text
https://github.com/Nikhilr-28/terminal_notifier/issues
```
