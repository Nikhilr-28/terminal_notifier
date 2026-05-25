# Terminal Notifier

![Terminal Notifier](media/icon.png)

Terminal Notifier is a VS Code extension for running long terminal commands and receiving a completion alert when the command finishes.

It is useful for training runs, evaluation scripts, data processing jobs, builds, tests, simulations, and other local commands that take enough time that you do not want to keep watching the terminal.

```text
Run a command
      ↓
Capture the output
      ↓
Detect success or failure
      ↓
Send a concise completion alert
```

## Highlights

- Run commands from a dedicated Notifier panel.
- Run commands from a Terminal panel bell shortcut.
- Send alerts to Telegram.
- Send alerts to Discord.
- Choose how much output to include.
- Capture command success and failure.
- Keep local logs for each run.
- Reuse previous commands with command history.
- Store channel settings locally in VS Code secure storage.
- No separate local server is required.

## Ways to run

Terminal Notifier gives you two workflows.

### Notifier panel

Open the bottom panel tab named `Notifier`.

Use it to:

- Select a notification channel.
- Configure the selected channel.
- Send a test alert.
- Enter a command.
- Pick an output mode.
- Run the command with completion notification enabled.
- Open the local logs folder.

### Terminal bell shortcut

The extension also contributes a bell shortcut in the Terminal panel.

Use it when your notification channel is already configured and you want a quick command prompt flow.

## Output modes

### Final Output

Sends the last configured number of output lines.

This is the recommended mode for long-running jobs because the final lines usually contain the useful result: final metrics, completion messages, or the last error.

Default final line count:

```json
{
  "terminalNotifier.finalOutputLineCount": 80
}
```

### Full Terminal

Sends captured command output up to the configured notification size limit.

This is useful for shorter jobs where the full output matters.

Default notification character limit:

```json
{
  "terminalNotifier.maxNotificationCharacters": 12000
}
```

If output is too long, the notification is shortened and the full output remains available in the local log.

## Notification format

Notifications are intentionally compact for mobile and chat apps.

Example success alert:

```text
🔔 ✅ Completed successfully | 2m 14s | exit 0

Command:
  python train.py --epochs 20

Run:
  Working dir: A:\Projects\Model
  Mode: Final Output
  Duration: 2m 14s
  Exit code: 0

Output:
  epoch 19 val_acc=0.921
  epoch 20 val_acc=0.928
  final acc=0.928
```

Example error alert:

```text
🔔 ❌ Completed with error | 11s | exit 1

Command:
  python train.py

Run:
  Working dir: A:\Projects\Model
  Mode: Final Output
  Duration: 11s
  Exit code: 1

Output:
  starting training
  Traceback (most recent call last):
    ...
  RuntimeError: Example failure
```

## Telegram setup

Telegram setup only needs to be done once.

### 1. Create a Telegram bot

1. Open Telegram.
2. Search for `BotFather`.
3. Start a chat with BotFather.
4. Send the command to create a new bot.
5. Follow the prompts.
6. Copy the bot access value that BotFather gives you.

Keep this value private.

### 2. Message your bot

Open your new bot in Telegram and send it a short message such as:

```text
hello
```

The bot needs one message before Terminal Notifier can detect the chat.

### 3. Configure Terminal Notifier

1. Open VS Code.
2. Open the `Notifier` panel.
3. Select `Telegram`.
4. Paste the bot value into `Bot token`.
5. Click `Fetch Chat ID`.
6. Click the detected chat row.
7. Click `Save`.
8. Click `Test`.

If setup is correct, you will receive a test alert.

### 4. Run a command

Example:

```powershell
python -c "print('epoch 1 acc=0.81'); print('epoch 2 acc=0.87'); print('final acc=0.95')"
```

Choose `Final Output`, then run.

## Discord setup

Discord setup uses a channel incoming webhook.

### 1. Create a Discord webhook

1. Open Discord.
2. Open your server.
3. Select the channel where alerts should appear.
4. Open channel settings.
5. Go to `Integrations`.
6. Open `Webhooks`.
7. Create a new webhook.
8. Name it `Terminal Notifier` or any name you prefer.
9. Copy the webhook URL.

Keep the webhook URL private.

### 2. Configure Terminal Notifier

1. Open the `Notifier` panel.
2. Select `Discord`.
3. Paste the webhook URL.
4. Click `Save`.
5. Click `Test`.

If setup is correct, the selected Discord channel will receive a test alert.

### 3. Run a command

Example:

```powershell
python -c "print('start'); print('training complete'); print('final acc=0.97')"
```

Choose `Final Output`, then run.

## Command history

Terminal Notifier remembers recent commands per workspace.

Use:

```text
Ctrl + ↑
Ctrl + ↓
```

or the buttons:

```text
↑ Prev
↓ Next
```

Behavior:

- History is workspace-specific.
- Duplicate commands are moved to the top.
- The most recent 30 commands are remembered.
- Editing the command box resets the history cursor.

## Local logs

Every run saves local files under:

```text
.vscode/terminal-notifier/logs/
```

These logs help when:

- A notification was shortened.
- A command failed.
- You want to inspect the full output.
- You want to compare earlier runs.

Recommended `.gitignore` entry:

```gitignore
.vscode/terminal-notifier/
```

## Privacy

Terminal Notifier stores notification settings locally through VS Code secure storage.

Do not commit local logs or configuration values if they contain private information.

## Limitations

Terminal Notifier runs commands locally through VS Code.

That means:

- VS Code must stay open.
- Your computer must stay awake.
- Commands must be started through Terminal Notifier to be captured.
- Already-running terminals are not captured.
- Interactive commands are not ideal.
- Long output may be shortened in the notification.
- Full local logs are saved for review.

## Recommended use for long jobs

For long ML, AI, data, and build jobs:

1. Use `Final Output` mode.
2. Print final metrics clearly.
3. Make sure the machine will not sleep.
4. Test your notification channel before starting an overnight job.
5. Check local logs if the notification is shortened.

Example final prints:

```python
print(f"best_val_acc={best_val_acc}", flush=True)
print(f"final_test_acc={test_acc}", flush=True)
print("training_complete", flush=True)
```

## Extension settings

### `terminalNotifier.finalOutputLineCount`

Number of final output lines sent in `Final Output` mode.

Default:

```json
{
  "terminalNotifier.finalOutputLineCount": 80
}
```

### `terminalNotifier.maxNotificationCharacters`

Maximum output characters sent in a notification before truncation.

Default:

```json
{
  "terminalNotifier.maxNotificationCharacters": 12000
}
```

### `terminalNotifier.defaultMode`

Default output mode.

Default:

```json
{
  "terminalNotifier.defaultMode": "Final Output"
}
```

Allowed values:

```text
Final Output
Full Terminal
```

## Development

Install dependencies:

```powershell
npm install
```

Compile:

```powershell
npm run compile
```

Run the extension in a development host:

```text
F5
```

## Packaging

Package locally:

```powershell
npx @vscode/vsce package
```

Install the package locally:

```powershell
code --install-extension .\terminal-notifier-0.1.1.vsix --force
```

## Repository

```text
https://github.com/Nikhilr-28/terminal_notifier
```

## Issues

```text
https://github.com/Nikhilr-28/terminal_notifier/issues
```

## License

MIT
