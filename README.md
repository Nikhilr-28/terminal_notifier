# Terminal Notifier

![Terminal Notifier](media/icon.png)

**Terminal Notifier** is a VS Code extension that lets you run long-running commands and receive **Telegram** or **Discord** notifications when the command finishes.

It is designed for developers, AI/ML researchers, students, and engineers who run scripts that take minutes or hours: model training, evaluation jobs, data preprocessing, npm builds, test suites, simulations, server scripts, and more.

The core idea is simple:

```text
Run command in VS Code
        ↓
Capture terminal output
        ↓
Detect success or failure
        ↓
Send mobile-friendly notification to Telegram or Discord
```

No backend server is required for Telegram or Discord. The extension sends notifications directly from VS Code and stores credentials locally using VS Code Secret Storage.

---

## Why Terminal Notifier?

Long-running terminal jobs are annoying to babysit.

You start a training run, leave for a break, and then wonder:

- Did the script finish?
- Did it crash?
- Did early stopping trigger?
- What were the final metrics?
- Was there a traceback?
- Should I go back to my laptop?

Terminal Notifier answers those questions by sending the final result directly to your phone or Discord channel.

---

## Features

### Notification channels

- Telegram bot notifications
- Discord webhook notifications
- Direct sending from the extension
- No local backend server required
- No Gmail app password required
- No SMTP setup required

### VS Code UI

Terminal Notifier gives you two ways to run commands:

#### 1. Notifier panel

A dedicated **Notifier** tab appears in the bottom VS Code panel.

Use it to:

- Select Telegram or Discord
- Save notification credentials
- Test the selected channel
- Enter a command
- Choose output mode
- Run with notification enabled
- Open local logs

#### 2. Terminal bell shortcut

A bell shortcut is also available from the Terminal panel.

Use this when you are already working in the terminal and want a fast `Run + Notify` flow.

If notification settings are already configured, the shortcut only asks for:

- Command
- Output mode

---

## Output modes

Terminal Notifier supports two output modes.

### Final Output

Sends the last configured number of output lines.

Best for:

- Final ML/DL metrics
- Validation accuracy
- Loss summaries
- Early stopping output
- Last traceback
- Final script result

Default: last `80` output lines.

You can change it in VS Code settings:

```json
{
  "terminalNotifier.finalOutputLineCount": 80
}
```

### Full Terminal

Sends captured command output up to the notification size limit.

Best for:

- Short scripts
- Build logs
- Debug commands
- Test runs
- Commands where the full output matters

You can change the max notification size:

```json
{
  "terminalNotifier.maxNotificationCharacters": 12000
}
```

If output is too long, the notification is truncated and the full local log remains saved in your workspace.

---

## Mobile-friendly notification format

Notifications are intentionally compact so they are useful on a phone.

Example success notification:

```text
🔔 ✅ Completed successfully | 0s | exit 0

Command:
  python train.py --epochs 20

Run:
  Working dir: A:\Projects\Model
  Mode: Final Output
  Duration: 2h 14m 9s
  Exit code: 0

Output:
  epoch 19 val_acc=0.921
  epoch 20 val_acc=0.928
  final acc=0.928
```

Example failure notification:

```text
🔔 ❌ Completed with error | 6m 22s | exit 1

Command:
  python train.py

Run:
  Working dir: A:\Projects\Model
  Mode: Final Output
  Duration: 6m 22s
  Exit code: 1

Output:
  starting training
  Traceback (most recent call last):
    File "train.py", line 42, in <module>
  RuntimeError: CUDA out of memory
```

---

## Telegram setup

Telegram is the recommended channel for phone notifications.

### Step 1: Create a Telegram bot

1. Open Telegram.
2. Search for `BotFather`.
3. Start a chat with BotFather.
4. Send:

```text
/newbot
```

5. Follow the prompts.
6. Copy the generated bot token.

The token looks similar to:

```text
1234567890:AAExampleTokenHere
```

Treat this token like a password. Do not commit it to Git or share it publicly.

### Step 2: Message your bot

Open your new bot in Telegram and send it any message, for example:

```text
hello
```

The bot must receive at least one message before Terminal Notifier can fetch your chat ID.

### Step 3: Configure Telegram in Terminal Notifier

1. Open VS Code.
2. Open the bottom panel.
3. Select the **Notifier** tab.
4. Select **Telegram**.
5. Paste your bot token into **Bot token**.
6. Click **Fetch Chat ID**.
7. Click the detected Chat ID row.
8. Click **Save**.
9. Click **Test**.

If setup is correct, you will receive a Telegram test notification.

### Step 4: Run a command

Example:

```powershell
python -c "print('epoch 1 acc=0.81'); print('epoch 2 acc=0.87'); print('final acc=0.95')"
```

Choose `Final Output`.

You should receive a Telegram notification when the command finishes.

---

## Discord setup

Discord uses a channel webhook URL.

### Step 1: Create a Discord webhook

1. Open Discord.
2. Open your server.
3. Choose the channel where notifications should be posted.
4. Open channel settings.
5. Go to **Integrations**.
6. Open **Webhooks**.
7. Create a new webhook.
8. Name it something like `Terminal Notifier`.
9. Copy the webhook URL.

The webhook URL should start with:

```text
https://discord.com/api/webhooks/
```

Treat the webhook URL like a password. Anyone with it can post to that Discord channel.

### Step 2: Configure Discord in Terminal Notifier

1. Open the **Notifier** panel in VS Code.
2. Select **Discord**.
3. Paste the webhook URL.
4. Click **Save**.
5. Click **Test**.

If setup is correct, you will receive a Discord test message in the selected channel.

### Step 3: Run a command

Example:

```powershell
python -c "print('start'); print('training complete'); print('final acc=0.97')"
```

Choose `Final Output`.

Terminal Notifier will send the result to your Discord channel when the command finishes.

---

## Command history

Terminal Notifier remembers commands per workspace.

Use:

```text
Ctrl + ↑
Ctrl + ↓
```

or use the visible buttons:

```text
↑ Prev
↓ Next
```

Behavior:

- Previous commands are remembered per project/workspace.
- Duplicate commands are moved to the top instead of repeated.
- The most recent 30 commands are saved.
- Secrets are not stored in command history unless you manually put them in a command.

---

## Local logs

Every run creates local logs under:

```text
.vscode/terminal-notifier/logs/
```

Logs are useful when:

- A notification was truncated.
- You want to inspect the full output.
- A command failed and you need details.
- You want to compare previous runs.

Generated logs should not be committed to Git.

Recommended `.gitignore` entry:

```gitignore
.vscode/terminal-notifier/
```

---

## Security and privacy

Terminal Notifier stores credentials locally using VS Code Secret Storage.

Stored values may include:

- Telegram bot token
- Telegram chat ID
- Discord webhook URL

Do not share:

- Telegram bot tokens
- Discord webhook URLs
- Local payload files containing sensitive output
- Training logs containing private data

If you accidentally expose a token or webhook, revoke it immediately and create a new one.

---

## Important limitations

Terminal Notifier runs commands locally through VS Code.

That means:

- VS Code must stay open.
- Your machine must stay awake.
- If your laptop sleeps, the command and notification may stop.
- The extension only captures commands started through Terminal Notifier.
- Very long output may be truncated in the notification.
- Full logs are saved locally.

For overnight ML/DL runs, make sure your system sleep settings will not interrupt the process.

---

## Example use cases

- ML/DL model training
- Hyperparameter experiments
- Dataset preprocessing
- Long Python scripts
- npm builds
- test suites
- local servers
- deployment commands
- simulation jobs
- batch processing
- research experiments

---

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

---

## Development

Install dependencies:

```powershell
npm install
```

Compile:

```powershell
npm run compile
```

Open in VS Code:

```powershell
code .
```

Run the extension:

```text
F5
```

This opens an Extension Development Host window.

---

## Packaging

Install VS Code extension tooling:

```powershell
npm install -g @vscode/vsce
```

Compile:

```powershell
npm run compile
```

Package:

```powershell
npx @vscode/vsce package
```

This creates a `.vsix` file.

Install locally:

```powershell
code --install-extension .\terminal-notifier-0.0.1.vsix --force
```

---

## Repository

GitHub:

```text
https://github.com/Nikhilr-28/terminal_notifier
```

Issues:

```text
https://github.com/Nikhilr-28/terminal_notifier/issues
```

---

## License

MIT
