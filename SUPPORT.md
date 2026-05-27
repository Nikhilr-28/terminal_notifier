# Support

This document covers setup help, expected behavior, and troubleshooting for Terminal Notifier.

Repository:

```text
https://github.com/Nikhilr-28/terminal_notifier
```

Issues:

```text
https://github.com/Nikhilr-28/terminal_notifier/issues
```

Please remove private values and sensitive output before posting an issue.

## Quick checklist

Before reporting a problem, check:

1. VS Code is open.
2. Your computer is awake.
3. The command was started through Terminal Notifier.
4. The selected channel test works.
5. The current directory is correct.
6. The selected environment mode is correct.
7. The command works in a normal terminal.
8. A local log exists under `.vscode/terminal-notifier/logs`.

## What to include in an issue

Use this format:

```text
OS:
VS Code version:
Terminal Notifier version:
Notification channel:
Environment mode:
Current directory:
Output mode:
Command:
Expected behavior:
Actual behavior:
Relevant log snippet:
```

Do not include private connection values or sensitive project output.

## Active run help

### I cannot see what the command is asking

Use the active-run output box in the Notifier panel.

It shows recent live output from the running command. The box is scrollable and does not grow indefinitely.

If you need the full output, click `Open terminal` or open the local log.

### I sent input but nothing happened

Check:

1. The command is still running.
2. The program is actually waiting for input.
3. You clicked `Send` or pressed Enter in the active input box.
4. You used `Send empty line` when the program expects a blank response.

Terminal Notifier supports simple stdin-style prompts such as Python `input()`. It is not a full terminal emulator.

### I need to skip an input prompt

Click:

```text
Send empty line
```

This sends a newline without text.

### Clear Output removed my visible output

`Clear Output` only clears the Notifier preview.

It does not clear:

- the real terminal output
- local logs
- final completion output
- saved payload files

Use it when you want a clean live preview while a run continues.

### Stop did not behave as expected

The Stop button attempts to stop the active process and its child process tree.

On Windows, this may use a process-tree termination strategy. Some programs may need a moment to stop, especially if they are using GPU resources or child processes.

If a process does not stop:

1. Click `Open terminal`.
2. Try stopping from the terminal.
3. Use Task Manager if needed.
4. Check the local log to see what process continued.

If this happens repeatedly, open an issue with the command and environment mode.

## Current directory help

### My command cannot find a file

Check the current directory field.

If your script is here:

```text
A:\Project\scripts\inference.py
```

you can use either:

```text
Current directory:
A:\Project

Command:
python scripts\inference.py
```

or:

```text
Current directory:
A:\Project\scripts

Command:
python inference.py
```

### `cd` does not print output

That is expected.

Terminal Notifier handles `cd` internally by updating the current directory. It does not spawn a separate process for `cd`.

Example:

```powershell
cd .\scripts
```

After this, the current directory field should update.

### The current directory is different in another project

This is expected.

Terminal Notifier stores the current directory per workspace.

## Environment help

### Which environment mode should I use?

Use this guide:

```text
None
  Use for commands that already work without an environment helper.

Conda environment
  Use for non-interactive Conda jobs such as training or evaluation.

Python executable
  Use for interactive Python scripts or when you want a specific interpreter.

Custom prefix
  Use for tools such as poetry, uv, npm wrappers, or project-specific launchers.
```

### Conda environment mode

Enter only the environment name.

Example:

```text
python3.10env
```

Then command:

```powershell
python scripts\train.py --epochs 5
```

Do not enter `conda activate` or `conda deactivate`.

Those are shell-session operations and are not the right fit for this runner.

### Python executable mode

Use the full path to the Python interpreter.

Example:

```text
C:\Users\you\anaconda3\envs\python3.10env\python.exe
```

Then command:

```powershell
scripts\inference.py --interactive
```

This is recommended for simple interactive Python scripts.

### Custom prefix mode

Use this for project-specific launchers.

Example prefix:

```text
poetry run
```

Example command:

```powershell
python train.py
```

## Notification help

### The notification is too long

Use `Final Output` mode.

You can also lower:

```json
{
  "terminalNotifier.maxNotificationCharacters": 8000
}
```

### I need more final lines

Increase:

```json
{
  "terminalNotifier.finalOutputLineCount": 120
}
```

### The notification was split into multiple messages

This can happen when the output is long.

Use `Final Output` mode for long-running jobs. Full logs remain local.

### Mobile preview has no line breaks

Some operating systems compress notification previews.

Open the actual Telegram or Discord message to see the formatted content.

## Channel setup help

### Telegram test does not arrive

Try:

1. Confirm the value from BotFather was copied correctly.
2. Send a message to your bot.
3. Click `Fetch Chat ID`.
4. Select the detected chat.
5. Click `Save`.
6. Click `Test`.

The bot must receive at least one message before chat detection works.

### Discord test does not arrive

Try:

1. Confirm the channel connection URL is complete.
2. Confirm the channel still exists.
3. Confirm the connection was not deleted.
4. Paste the URL again.
5. Click `Save`.
6. Click `Test`.

## Command history help

### Ctrl + Up or Ctrl + Down does not work

Some keyboard shortcuts may be captured by the OS or other extensions.

Use the buttons:

```text
↑ Prev
↓ Next
```

### History is empty

History is saved after commands are run through Terminal Notifier.

Run one command first.

### History differs between projects

This is expected.

History is stored per workspace.

## Logs

Terminal Notifier saves local files under:

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

- full command output
- shortened notifications
- failed commands
- stop behavior
- exit codes

Do not commit generated logs.

## Safe usage

- Use Terminal Notifier only in trusted workspaces.
- Do not run commands you do not understand.
- Review logs before sharing them.
- Keep channel connection values private.
- Keep your computer awake for long jobs.
- Do not commit generated logs.

## Known limitations

- VS Code must remain open.
- Your computer must stay awake.
- Already-running terminals are not captured.
- Only commands started through Terminal Notifier are captured.
- Full-screen terminal applications are not the target use case.
- Very long output may be shortened in completion messages.
- Full output remains available in local logs.

## Recommended setup for training jobs

1. Use `Final Output`.
2. Use Conda environment or Python executable mode.
3. Print final metrics clearly.
4. Save checkpoints from inside your script.
5. Test the notification channel first.
6. Keep the machine awake.

Example:

```powershell
python train.py --epochs 5
```

Helpful final prints:

```python
print(f"best_val_acc={best_val_acc}", flush=True)
print(f"final_test_acc={test_acc}", flush=True)
print("training_complete", flush=True)
```

## Recommended setup for interactive Python scripts

1. Use Python executable mode.
2. Use Full Terminal mode.
3. Watch the active output box.
4. Send responses through the active input box.
5. Use Send empty line to skip optional prompts.

Example:

```powershell
scripts\inference.py --interactive
```
