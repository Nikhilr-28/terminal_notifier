# Terminal Notifier

![Terminal Notifier](media/icon.png)

**Receive mobile-friendly status updates for terminal runs in VS Code.**

Terminal Notifier helps you start a command from VS Code, watch the live output in a compact panel, interact with simple prompts when needed, and receive a concise completion message when the run ends.

It is built for local development workflows where commands may take time: model training, evaluation scripts, data preprocessing, builds, tests, simulations, and other terminal runs that you do not want to babysit.

```text
Start a run
    ↓
Watch live output
    ↓
Send input if the program asks
    ↓
Receive a compact completion update
```

## What is new in v1.1.0

Terminal Notifier is no longer just a simple completion notifier. Version 1.1.0 adds a much stronger active-run workflow:

- Live output preview inside the Notifier panel.
- Scrollable active-run output that does not expand the whole UI.
- Active input box for simple interactive programs.
- Send, Send empty line, Stop, Open terminal, and Clear output controls.
- Persistent current directory per workspace.
- `cd` command handling that updates the Notifier current directory.
- Environment modes for common workflows:
  - None
  - Conda environment
  - Python executable
  - Custom prefix
- Better support for Python and ML workflows.
- Stronger stop behavior for long-running processes.
- Cleaner final notification formatting.

## Highlights

- Dedicated `Notifier` bottom-panel UI.
- Terminal bell shortcut for quick Run + Notify.
- Mobile-friendly completion messages.
- Telegram and Discord delivery options.
- Final Output and Full Terminal output modes.
- Live output preview while the command is running.
- Scrollable active run panel.
- Clear Output button for the UI preview.
- Local logs for every run.
- Workspace-specific command history.
- Current directory memory.
- Environment selection for Conda and Python executable workflows.
- No separate local backend server required.

## Main workflows

### 1. Notifier panel

Open the bottom panel tab named `Notifier`.

Use it to:

- Choose a notification channel.
- Configure the channel once.
- Test the channel.
- Set the current directory.
- Choose an environment mode.
- Enter a command.
- Watch live output.
- Send input to an active run.
- Stop an active run.
- Open the full terminal view.
- Open local logs.

This is the recommended workflow.

### 2. Terminal bell shortcut

Terminal Notifier also adds a bell shortcut in the Terminal panel.

Use it when your channel is already configured and you want a quick command prompt flow.

## Active run panel

When a command is running, Terminal Notifier shows an active-run section with:

- Current run state.
- Live output preview.
- Input box for simple prompts.
- Send button.
- Send empty line button.
- Stop button.
- Open terminal button.
- Clear output button.

The live output preview is scrollable. It is meant for context, not as a replacement for the full terminal log.

`Clear output` only clears the visible preview. It does not change the real run output, local logs, or the final completion message.

## Current directory

Terminal Notifier keeps a current directory per workspace.

You can:

- Edit the directory field.
- Use the workspace root button.
- Browse for a folder.
- Run `cd` commands from the command box.

Example:

```powershell
cd .\scripts
```

Terminal Notifier updates its current directory instead of running `cd` as a short-lived process.

This means the next command runs from the updated directory.

## Environment modes

Terminal Notifier supports four environment modes.

### None

Runs the command as-is from the selected current directory.

Example:

```powershell
python script.py
```

### Conda environment

Use this for non-interactive Conda jobs.

You enter only the environment name.

```text
python3.10env
```

Then run a normal command:

```powershell
python scripts\train.py --epochs 5
```

Terminal Notifier builds the Conda run command internally.

This is recommended for training, evaluation, and other non-interactive scripts.

### Python executable

Use this for interactive Python scripts or when you want a specific Python interpreter.

Example Python executable:

```text
C:\Users\you\anaconda3\envs\python3.10env\python.exe
```

Example command:

```powershell
scripts\inference.py --interactive
```

This mode is useful when the script uses `input()` prompts.

### Custom prefix

Use this only when you know exactly what prefix your command needs.

Example:

```powershell
poetry run
```

Then command:

```powershell
python train.py
```

The effective run becomes:

```powershell
poetry run python train.py
```

## Output modes

### Final Output

Recommended for long-running jobs.

Final Output sends the most relevant final lines of the run. It is designed for mobile readability and avoids sending huge progress logs when possible.

Best for:

- Training summaries.
- Final metrics.
- Validation results.
- Completion messages.
- Last error traceback.
- Short final reports.

Setting:

```json
{
  "terminalNotifier.finalOutputLineCount": 80
}
```

### Full Terminal

Full Terminal includes a broader capture of the run output up to the configured notification size limit.

Best for:

- Short scripts.
- Debug runs.
- Small build logs.
- Cases where the full printed output matters.

Setting:

```json
{
  "terminalNotifier.maxNotificationCharacters": 12000
}
```

If output is too long, the completion message is shortened and the full log remains available locally.

## Example completion message

```text
🔔 ✅ 2m 14s | exit 0

Mode:    Final Output
Dir:     A:\Projects\Model
Cmd:     python train.py --epochs 5

────────────────
epoch 4 val_acc=0.921
epoch 5 val_acc=0.928
best_val_acc=0.928
training_complete
```

## Telegram setup

Telegram setup only needs to be done once.

1. Open Telegram.
2. Create a bot using BotFather.
3. Copy the value BotFather gives you.
4. Send a message to your bot, such as `hello`.
5. Open the `Notifier` panel.
6. Select Telegram.
7. Paste the value into the Telegram field.
8. Click `Fetch Chat ID`.
9. Select the detected chat.
10. Click `Save`.
11. Click `Test`.

After the test succeeds, you can run commands and receive completion updates.

Keep the Telegram connection value private.

## Discord setup

Discord setup uses a channel connection URL.

1. Open Discord.
2. Open your server.
3. Choose the target channel.
4. Open channel settings.
5. Open Integrations.
6. Create a webhook.
7. Copy the channel URL.
8. Open the `Notifier` panel.
9. Select Discord.
10. Paste the URL.
11. Click `Save`.
12. Click `Test`.

After the test succeeds, the selected channel can receive completion updates.

Keep the Discord channel URL private.

## Command history

Terminal Notifier remembers recent commands per workspace.

Use:

```text
Ctrl + ↑
Ctrl + ↓
```

or:

```text
↑ Prev
↓ Next
```

Behavior:

- History is workspace-specific.
- Commands are saved automatically when run.
- Duplicate commands move to the top.
- Editing the command box resets the history cursor.

## Local logs

Every run saves local files under:

```text
.vscode/terminal-notifier/logs/
```

Logs are useful when:

- A completion message was shortened.
- You need full run output.
- You want to inspect a failed run.
- You want to compare earlier runs.

Recommended `.gitignore` entry:

```gitignore
.vscode/terminal-notifier/
```

## Recommended training setup

For training jobs such as:

```powershell
python train.py --epochs 5
```

Recommended settings:

```text
Environment: Conda environment or Python executable
Output mode: Final Output
```

Make sure your training script prints final metrics clearly:

```python
print(f"best_val_acc={best_val_acc}", flush=True)
print(f"final_test_acc={test_acc}", flush=True)
print("training_complete", flush=True)
```

This makes the completion message much more useful.

## Recommended interactive setup

For simple Python interactive scripts:

```text
Environment: Python executable
Output mode: Full Terminal
```

Example command:

```powershell
scripts\inference.py --interactive
```

Use the active-run input box to respond to prompts.

For complex full-screen terminal programs, use a normal terminal. Terminal Notifier supports simple stdin-style interactions, not full terminal emulation.

## Privacy and local data

Terminal Notifier stores channel settings locally through VS Code secure storage.

Generated logs stay in your workspace.

Do not commit:

- Local run logs.
- Private connection values.
- Sensitive command output.
- Generated payload files.

## Limitations

Terminal Notifier runs commands locally through VS Code.

That means:

- VS Code must stay open.
- Your computer must stay awake.
- Only commands started through Terminal Notifier are captured.
- Already-running terminals are not captured.
- Very long output may be shortened in the completion message.
- Full logs are saved locally.
- Simple interactive prompts are supported, but full terminal emulation is not the goal.

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

Maximum output characters included before shortening.

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

Run in an Extension Development Host:

```text
F5
```

## Packaging

Package locally:

```powershell
npx @vscode/vsce package
```

Install locally:

```powershell
code --install-extension .\terminal-notifier-1.1.0.vsix --force
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
