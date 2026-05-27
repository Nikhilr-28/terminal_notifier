import * as vscode from 'vscode';
import { spawn, exec, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const VIEW_ID = 'terminalNotifier.view';

const CHANNEL_SECRET_KEY = 'terminalNotifier.channel';
const TELEGRAM_BOT_TOKEN_KEY = 'terminalNotifier.telegramBotToken';
const TELEGRAM_CHAT_ID_KEY = 'terminalNotifier.telegramChatId';
const DISCORD_WEBHOOK_URL_KEY = 'terminalNotifier.discordWebhookUrl';

const COMMAND_HISTORY_KEY = 'terminalNotifier.commandHistory';
const COMMAND_HISTORY_LIMIT = 50;

const WORKING_DIRECTORY_KEY = 'terminalNotifier.workingDirectory';
const ENV_MODE_KEY = 'terminalNotifier.environmentMode';
const CONDA_ENV_NAME_KEY = 'terminalNotifier.condaEnvName';
const PYTHON_EXECUTABLE_KEY = 'terminalNotifier.pythonExecutable';
const CUSTOM_PREFIX_KEY = 'terminalNotifier.customPrefix';

const TELEGRAM_MESSAGE_LIMIT = 3500;
const DISCORD_MESSAGE_LIMIT = 1900;

type NotifyMode = 'Full Terminal' | 'Final Output';
type NotificationChannel = 'telegram' | 'discord';
type EnvironmentMode = 'none' | 'conda' | 'python' | 'custom';

interface ChannelConfig {
  channel: NotificationChannel;
  telegramBotToken?: string;
  telegramChatId?: string;
  discordWebhookUrl?: string;
}

interface SessionConfig {
  workingDirectory: string;
  environmentMode: EnvironmentMode;
  condaEnvName: string;
  pythonExecutable: string;
  customPrefix: string;
}

interface BuiltCommand {
  command: string;
  environmentDescription: string;
}

interface RunOptions {
  command: string;
  displayCommand: string;
  cwd: string;
  environmentDescription: string;
  mode: NotifyMode;
  channelConfig: ChannelConfig;
  logPath: string;
  payloadPath: string;
  finalOutputLineCount: number;
  maxNotificationCharacters: number;
  onDidFinish?: (exitCode: number | null) => void;
  outputCallback?: (text: string) => void;
}

interface RunResultBase {
  command: string;
  displayCommand: string;
  cwd: string;
  environmentDescription: string;
  mode: NotifyMode;
  channelConfig: ChannelConfig;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  logPath: string;
  payloadPath: string;
  finalLines: string[];
  hadStderr: boolean;
  failedToStart: boolean;
  errorMessage?: string;
}

interface RunResult extends RunResultBase {
  notificationSent: boolean;
  notificationError?: string;
}

interface TelegramUpdate {
  update_id?: number;
  chat_id?: number | string;
  chat_type?: string;
  chat_title?: string | null;
  username?: string | null;
  first_name?: string | null;
  text?: string | null;
  date?: number | null;
}

let activeRun: NotifyRunPseudoterminal | undefined;
let activeTerminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext) {
  const provider = new NotifierViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );

  statusBarItem.text = '$(bell) Notify';
  statusBarItem.tooltip = 'Run a command and notify when it finishes';
  statusBarItem.command = 'terminalNotifier.runAndNotify';
  statusBarItem.show();

  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('terminalNotifier.runAndNotify', async () => {
      await runAndNotifyPrompt(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('terminalNotifier.focusPanel', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.terminalNotifierPanel');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('terminalNotifier.openLogsFolder', async () => {
      const logsDir = getLogsDirectory(context);
      fs.mkdirSync(logsDir, { recursive: true });
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(logsDir));
    })
  );
}

export function deactivate() {}

class NotifierViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    webviewView.webview.options = {
      enableScripts: true
    };

    await this.render(webviewView);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        if (message.type === 'saveConfig') {
          const channelConfig = buildChannelConfigFromMessage(message);
          const sessionConfig = buildSessionConfigFromMessage(this.context, message);

          const sessionError = validateSessionConfig(sessionConfig);
          if (sessionError) {
            await postStatus(webviewView, 'error', sessionError);
            return;
          }

          const channelError = validateChannelConfig(channelConfig);
          if (channelError) {
            await postStatus(webviewView, 'error', channelError);
            return;
          }

          await saveChannelConfig(this.context, channelConfig);
          await saveSessionConfig(this.context, sessionConfig);

          await postStatus(webviewView, 'success', `Saved settings. CWD: ${sessionConfig.workingDirectory}`);
          return;
        }

        if (message.type === 'clearConfig') {
          // Prevent clearing while a run is live — render() replaces the entire
          // webview HTML which would destroy the JS context mid-run.
          if (activeRun?.isRunning()) {
            await postStatus(webviewView, 'error', 'Stop the active run before clearing config.');
            return;
          }

          await this.context.secrets.delete(CHANNEL_SECRET_KEY);
          await this.context.secrets.delete(TELEGRAM_BOT_TOKEN_KEY);
          await this.context.secrets.delete(TELEGRAM_CHAT_ID_KEY);
          await this.context.secrets.delete(DISCORD_WEBHOOK_URL_KEY);

          await this.render(webviewView);
          await postStatus(webviewView, 'success', 'Notification settings cleared. Command history and run settings were kept.');
          return;
        }

        if (message.type === 'useWorkspaceRoot') {
          const current = buildSessionConfigFromMessage(this.context, message);
          const root = getWorkspaceRoot();
          const next = {
            ...current,
            workingDirectory: root
          };

          await saveSessionConfig(this.context, next);

          await webviewView.webview.postMessage({
            type: 'sessionUpdated',
            workingDirectory: root
          });

          await postStatus(webviewView, 'success', 'Current directory set to workspace root.');
          return;
        }

        if (message.type === 'browseWorkingDirectory') {
          const currentSession = buildSessionConfigFromMessage(this.context, message);
          const selection = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Use Folder',
            defaultUri: vscode.Uri.file(currentSession.workingDirectory)
          });

          if (!selection || selection.length === 0) {
            return;
          }

          const selectedDirectory = selection[0].fsPath;
          const next = {
            ...currentSession,
            workingDirectory: selectedDirectory
          };

          await saveSessionConfig(this.context, next);

          await webviewView.webview.postMessage({
            type: 'sessionUpdated',
            workingDirectory: selectedDirectory
          });

          await postStatus(webviewView, 'success', `Current directory set to: ${selectedDirectory}`);
          return;
        }

        if (message.type === 'fetchTelegramUpdates') {
          const botToken = String(message.telegramBotToken ?? '').trim();

          if (!botToken) {
            await postStatus(webviewView, 'error', 'Paste your Telegram bot token first. Then message your bot once.');
            return;
          }

          const updates = await fetchTelegramUpdates(botToken);

          await webviewView.webview.postMessage({
            type: 'telegramUpdates',
            updates
          });

          await postStatus(
            webviewView,
            updates.length > 0 ? 'success' : 'info',
            updates.length > 0
              ? `Found ${updates.length} Telegram update(s). Click one to fill Chat ID.`
              : 'No updates found. Send "hello" to your Telegram bot, then try again.'
          );
          return;
        }

        if (message.type === 'testNotification') {
          const channelConfig = buildChannelConfigFromMessage(message);
          const sessionConfig = buildSessionConfigFromMessage(this.context, message);

          const sessionError = validateSessionConfig(sessionConfig);
          if (sessionError) {
            await postStatus(webviewView, 'error', sessionError);
            return;
          }

          const channelError = validateChannelConfig(channelConfig);
          if (channelError) {
            await postStatus(webviewView, 'error', channelError);
            return;
          }

          await saveChannelConfig(this.context, channelConfig);
          await saveSessionConfig(this.context, sessionConfig);

          const testText = buildTestNotificationText(channelConfig, sessionConfig);
          await sendDirectNotification(channelConfig, '[Terminal Notifier] Test notification', testText);

          await postStatus(webviewView, 'success', `${channelLabel(channelConfig.channel)} test notification sent.`);
          return;
        }

        if (message.type === 'openLogsFolder') {
          const logsDir = getLogsDirectory(this.context);
          fs.mkdirSync(logsDir, { recursive: true });
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(logsDir));
          return;
        }

        if (message.type === 'sendActiveInput') {
          const inputText = String(message.inputText ?? '');
          if (!activeRun || !activeRun.isRunning()) {
            await postStatus(webviewView, 'error', 'No active run is waiting for input.');
            return;
          }

          activeRun.sendInputLine(inputText);
          await postStatus(webviewView, 'success', inputText.trim() ? 'Input sent to active run.' : 'Empty line sent to active run.');
          return;
        }

        if (message.type === 'sendActiveEmptyLine') {
          if (!activeRun || !activeRun.isRunning()) {
            await postStatus(webviewView, 'error', 'No active run is waiting for input.');
            return;
          }

          activeRun.sendInputLine('');
          await postStatus(webviewView, 'success', 'Empty line sent to active run.');
          return;
        }

        if (message.type === 'stopActiveRun') {
          if (!activeRun || !activeRun.isRunning()) {
            await postStatus(webviewView, 'info', 'No active run to stop.');
            return;
          }

          activeRun.stop();
          await postStatus(webviewView, 'info', 'Stop signal sent to active run.');
          return;
        }

        if (message.type === 'openActiveTerminal') {
          activeTerminal?.show();
          return;
        }

        if (message.type === 'run') {
          const command = String(message.command ?? '').trim();
          const mode = message.mode === 'Full Terminal' ? 'Full Terminal' : 'Final Output';
          const channelConfig = buildChannelConfigFromMessage(message);
          const sessionConfig = buildSessionConfigFromMessage(this.context, message);

          if (!command) {
            await postStatus(webviewView, 'error', 'Command cannot be empty.');
            return;
          }

          const commandError = validateRunnableCommand(command, sessionConfig);
          if (commandError) {
            await postStatus(webviewView, 'error', commandError);
            return;
          }

          const sessionError = validateSessionConfig(sessionConfig);
          if (sessionError) {
            await postStatus(webviewView, 'error', sessionError);
            return;
          }

          await saveSessionConfig(this.context, sessionConfig);
          await rememberCommand(this.context, command);
          await postCommandHistory(webviewView, this.context);

          const cdResult = await tryHandleCdCommand(this.context, command, sessionConfig.workingDirectory);
          if (cdResult.handled) {
            await webviewView.webview.postMessage({
              type: 'sessionUpdated',
              workingDirectory: cdResult.workingDirectory
            });

            await postStatus(webviewView, cdResult.ok ? 'success' : 'error', cdResult.message);
            return;
          }

          const channelError = validateChannelConfig(channelConfig);
          if (channelError) {
            await postStatus(webviewView, 'error', channelError);
            return;
          }

          await saveChannelConfig(this.context, channelConfig);

          const built = buildExecutionCommand(command, sessionConfig);

          await postStatus(webviewView, 'info', `Running from ${sessionConfig.workingDirectory}`);

          const outputCallback = (text: string): void => {
            void webviewView.webview.postMessage({
              type: 'runOutput',
              text
            });
          };

          // Post activeRunStarted BEFORE starting the terminal so the webview
          // is ready to receive runOutput chunks. If we posted after, early output
          // from fast-starting scripts could arrive before the webview knew a run began.
          await webviewView.webview.postMessage({
            type: 'activeRunStarted',
            command,
            cwd: sessionConfig.workingDirectory
          });

          await startNotifyTerminal(
            this.context,
            {
              command,
              builtCommand: built,
              mode,
              channelConfig,
              sessionConfig,
              fromNotifier: true,
              outputCallback
            },
            async (exitCode) => {
              await webviewView.webview.postMessage({
                type: 'activeRunEnded',
                exitCode: exitCode
              });
            }
          );

          return;
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await postStatus(webviewView, 'error', text);
      }
    });
  }

  private async render(webviewView: vscode.WebviewView): Promise<void> {
    const channel = normalizeChannel(await this.context.secrets.get(CHANNEL_SECRET_KEY));
    const telegramBotToken = await this.context.secrets.get(TELEGRAM_BOT_TOKEN_KEY);
    const telegramChatId = await this.context.secrets.get(TELEGRAM_CHAT_ID_KEY);
    const discordWebhookUrl = await this.context.secrets.get(DISCORD_WEBHOOK_URL_KEY);
    const commandHistory = getCommandHistory(this.context);
    const sessionConfig = getSessionConfig(this.context);
    const workspaceRoot = getWorkspaceRoot();

    const config = vscode.workspace.getConfiguration('terminalNotifier');

    webviewView.webview.html = getWebviewHtml({
      channel,
      telegramBotToken: telegramBotToken ?? '',
      telegramChatId: telegramChatId ?? '',
      discordWebhookUrl: discordWebhookUrl ?? '',
      defaultMode: config.get<NotifyMode>('defaultMode', 'Final Output'),
      finalOutputLineCount: config.get<number>('finalOutputLineCount', 200),
      commandHistory,
      workingDirectory: sessionConfig.workingDirectory,
      workspaceRoot,
      environmentMode: sessionConfig.environmentMode,
      condaEnvName: sessionConfig.condaEnvName,
      pythonExecutable: sessionConfig.pythonExecutable,
      customPrefix: sessionConfig.customPrefix
    });
  }
}

async function postStatus(
  webviewView: vscode.WebviewView,
  level: 'success' | 'error' | 'info',
  text: string
): Promise<void> {
  await webviewView.webview.postMessage({
    type: 'status',
    level,
    text
  });
}

async function postCommandHistory(
  webviewView: vscode.WebviewView,
  context: vscode.ExtensionContext
): Promise<void> {
  await webviewView.webview.postMessage({
    type: 'commandHistoryUpdated',
    commandHistory: getCommandHistory(context)
  });
}

async function runAndNotifyPrompt(context: vscode.ExtensionContext): Promise<void> {
  const channelConfig = await getSavedChannelConfig(context);
  const validationError = validateChannelConfig(channelConfig);

  if (validationError) {
    await vscode.commands.executeCommand('workbench.view.extension.terminalNotifierPanel');
    vscode.window.showWarningMessage(`Configure Notifier first: ${validationError}`);
    return;
  }

  const sessionConfig = getSessionConfig(context);
  const command = await vscode.window.showInputBox({
    title: 'Terminal Notifier',
    prompt: `Command to run. CWD: ${sessionConfig.workingDirectory}`,
    placeHolder: 'python train.py --epochs 5',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value.trim()) {
        return 'Command cannot be empty.';
      }

      return validateRunnableCommand(value, sessionConfig);
    }
  });

  if (!command) {
    return;
  }

  await rememberCommand(context, command);

  const cdResult = await tryHandleCdCommand(context, command, sessionConfig.workingDirectory);
  if (cdResult.handled) {
    vscode.window.showInformationMessage(cdResult.message);
    return;
  }

  const config = vscode.workspace.getConfiguration('terminalNotifier');
  const defaultMode = config.get<NotifyMode>('defaultMode', 'Final Output');

  const modePick = await vscode.window.showQuickPick(
    [
      {
        label: 'Final Output',
        description: 'Last N lines and summary',
        value: 'Final Output' as NotifyMode
      },
      {
        label: 'Full Terminal',
        description: 'Captured output up to notification size limit',
        value: 'Full Terminal' as NotifyMode
      }
    ].sort((a, b) => {
      if (a.value === defaultMode) {
        return -1;
      }
      if (b.value === defaultMode) {
        return 1;
      }
      return 0;
    }),
    {
      title: 'Terminal Notifier',
      placeHolder: 'Choose output mode',
      ignoreFocusOut: true
    }
  );

  if (!modePick) {
    return;
  }

  const built = buildExecutionCommand(command, getSessionConfig(context));

  await startNotifyTerminal(context, {
    command,
    builtCommand: built,
    mode: modePick.value,
    channelConfig,
    sessionConfig: getSessionConfig(context)
  });
}

async function startNotifyTerminal(
  context: vscode.ExtensionContext,
  input: {
    command: string;
    builtCommand: BuiltCommand;
    mode: NotifyMode;
    channelConfig: ChannelConfig;
    sessionConfig: SessionConfig;
    fromNotifier?: boolean;
    outputCallback?: (text: string) => void;
  },
  onDidFinish?: (exitCode: number | null) => void | Promise<void>
): Promise<void> {
  const config = vscode.workspace.getConfiguration('terminalNotifier');

  const finalOutputLineCount = config.get<number>('finalOutputLineCount', 200);
  const maxNotificationCharacters = config.get<number>('maxNotificationCharacters', 12000);

  const cwd = input.sessionConfig.workingDirectory;
  const logsDir = getLogsDirectory(context);
  fs.mkdirSync(logsDir, { recursive: true });

  const timestamp = toSafeTimestamp(new Date());
  const logPath = path.join(logsDir, `run-${timestamp}.log`);
  const payloadPath = path.join(logsDir, `payload-${timestamp}.json`);

  let pty: NotifyRunPseudoterminal;
  pty = new NotifyRunPseudoterminal({
    command: input.builtCommand.command,
    displayCommand: input.command,
    cwd,
    environmentDescription: input.builtCommand.environmentDescription,
    mode: input.mode,
    channelConfig: input.channelConfig,
    logPath,
    payloadPath,
    finalOutputLineCount,
    maxNotificationCharacters,
    outputCallback: input.outputCallback,
    onDidFinish: (exitCode) => {
      if (activeRun === pty) {
        activeRun = undefined;
      }

      if (activeTerminal) {
        activeTerminal = undefined;
      }

      void Promise.resolve(onDidFinish?.(exitCode));
    }
  });

  activeRun = pty;

  const terminal = vscode.window.createTerminal({
    name: `Notify: ${shorten(input.command, 28)}`,
    pty
  });

  activeTerminal = terminal;

  // Only auto-focus the terminal when launched from the keyboard shortcut.
  // When launched from the Notifier panel, stay in the panel so the user
  // can see live output and interact via the Active run input.
  if (!input.fromNotifier) {
    terminal.show();
  }

  vscode.window.showInformationMessage(`Notifier started. CWD: ${cwd}`);
}

class NotifyRunPseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;

  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidClose: vscode.Event<number | void> = this.closeEmitter.event;

  private child?: ChildProcessWithoutNullStreams;
  private logStream?: fs.WriteStream;

  private startTime = new Date();
  private finalLines: string[] = [];
  private partialLine = '';
  private hadStderr = false;
  private finalized = false;
  private stopping = false;   // true once stop() has been called; prevents double-kill
  private failedToStart = false;
  private errorMessage: string | undefined;

  constructor(private readonly options: RunOptions) {}

  open(): void {
    void this.startProcess();
  }

  close(): void {
    if (this.child && !this.child.killed && !this.finalized) {
      this.writeLine('');
      this.writeLine('[Notifier] Terminal closed. Stopping process...');
      this.stop();
    }
  }

  isRunning(): boolean {
    // Treat 'stopping' as no longer running so a second stop press is a no-op
    return Boolean(this.child && !this.child.killed && !this.finalized && !this.stopping);
  }

  stop(): void {
    // Guard: already stopping or already done
    if (!this.child || this.finalized || this.stopping) {
      return;
    }
    this.stopping = true;
    this.writeLine('');
    this.writeLine('[Notifier] Stop requested — killing process tree...');
    const pid = this.child.pid;

    if (pid !== undefined && process.platform === 'win32') {
      // On Windows, child.kill() only kills the shell, not the Python subprocess tree.
      // taskkill /F /T kills the full tree rooted at pid.
      exec(`taskkill /F /T /PID ${pid}`, (err) => {
        if (err) {
          // taskkill failed — fall back to SIGTERM on the shell
          try { this.child?.kill('SIGTERM'); } catch (_) { /* ignore */ }
        }
      });
      // Safety net: if neither taskkill nor SIGTERM triggers 'close' within 5 s,
      // force-finalize so the UI doesn't stay in a permanent live state.
      setTimeout(() => {
        if (!this.finalized) {
          try { this.child?.kill(); } catch (_) { /* ignore */ }
          setTimeout(() => {
            if (!this.finalized) { void this.finalize(null, null); }
          }, 1000);
        }
      }, 5000);
    } else {
      // Unix: send SIGTERM to the whole process group, SIGKILL after 2 s.
      // Guard pid — it is undefined on very early failures before the OS assigns one.
      try {
        if (pid !== undefined) {
          process.kill(-pid, 'SIGTERM');
        } else {
          this.child.kill('SIGTERM');
        }
      } catch (_) {
        try { this.child.kill('SIGTERM'); } catch (__) { /* ignore */ }
      }
      setTimeout(() => {
        if (!this.finalized) {
          try { this.child?.kill('SIGKILL'); } catch (_) { /* ignore */ }
        }
      }, 2000);
    }
  }

  sendInputLine(value: string): void {
    if (!this.child || this.child.killed || this.finalized || !this.child.stdin.writable) {
      throw new Error('No active process stdin is available.');
    }

    const echo = `[input] ${value}`;
    this.writeLine(echo);
    // Also record into finalLines and forward to webview so the input
    // (including "quit") appears in both the notification and output tail.
    this.recordFinalLines(echo + '\n');
    this.options.outputCallback?.(echo + '\n');
    this.child.stdin.write(`${value}\n`);
  }

  handleInput(data: string): void {
    if (data === '\x03') {
      this.writeLine('');
      this.writeLine('[Notifier] Ctrl+C received. Stopping process...');
      this.stop();
      return;
    }

    if (this.child && !this.child.killed && this.child.stdin.writable) {
      const normalized = data.replace(/\r/g, '\n');
      this.child.stdin.write(normalized);

      // Pseudoterminals do not always echo typed input. Echo lightly for usability.
      this.writeRaw(data);
    }
  }

  private async startProcess(): Promise<void> {
    this.startTime = new Date();

    this.logStream = fs.createWriteStream(this.options.logPath, {
      flags: 'a',
      encoding: 'utf8'
    });

    this.writeHeader();

    try {
      const mergedCommand = `${this.options.command} 2>&1`;

      this.child = spawn(mergedCommand, {
        cwd: this.options.cwd,
        shell: true,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8'
        }
      });

      this.child.stdout.on('data', (chunk: Buffer) => {
        this.handleChunk(chunk.toString());
      });

      // stderr is merged into stdout via 2>&1 above; this listener would never fire.
      // hadStderr is still set via exitCode !== 0 in finalize().

      this.child.on('error', (error: Error) => {
        this.failedToStart = true;
        this.errorMessage = error.message;
        void this.finalize(null, null);
      });

      this.child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        void this.finalize(code, signal);
      });
    } catch (error) {
      this.failedToStart = true;
      this.errorMessage = error instanceof Error ? error.message : String(error);
      await this.finalize(null, null);
    }
  }

  private writeHeader(): void {
    const header = [
      '🔔 Terminal Notifier',
      `CWD: ${this.options.cwd}`,
      `Mode: ${this.options.mode} | Channel: ${channelLabel(this.options.channelConfig.channel)}`,
      this.options.environmentDescription ? `Environment: ${this.options.environmentDescription}` : undefined,
      `Log: ${this.options.logPath}`,
      '',
      `> ${this.options.displayCommand}`,
      '────────────────────────────────────────'
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');

    this.writeLineBlock(header);
    this.writeToLog(`${header}\n`);
  }

  private handleChunk(text: string): void {
    this.writeRaw(text);
    this.writeToLog(text);
    this.recordFinalLines(text);
    this.options.outputCallback?.(text);
  }

  private recordFinalLines(text: string): void {
    const combined = this.partialLine + text;
    const parts = combined.split(/\r?\n/);

    this.partialLine = parts.pop() ?? '';

    for (const line of parts) {
      if (line.trim().length === 0) {
        continue;
      }

      // Deduplicate consecutive identical lines.
      // This prevents double-entries when sendInputLine records '[input] X'
      // and the script also prints '[input] X' to stdout in the same turn.
      const last = this.finalLines[this.finalLines.length - 1];
      if (last !== undefined && last === line) {
        continue;
      }

      this.finalLines.push(line);

      while (this.finalLines.length > this.options.finalOutputLineCount) {
        this.finalLines.shift();
      }
    }
  }

  private flushPartialLine(): void {
    if (this.partialLine.trim().length > 0) {
      this.finalLines.push(this.partialLine);
      this.partialLine = '';

      while (this.finalLines.length > this.options.finalOutputLineCount) {
        this.finalLines.shift();
      }
    }
  }

  private async finalize(exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.finalized) {
      return;
    }

    this.finalized = true;
    this.flushPartialLine();

    const endTime = new Date();
    const durationMs = endTime.getTime() - this.startTime.getTime();

    const resultBase: RunResultBase = {
      command: this.options.command,
      displayCommand: this.options.displayCommand,
      cwd: this.options.cwd,
      environmentDescription: this.options.environmentDescription,
      mode: this.options.mode,
      channelConfig: this.options.channelConfig,
      startTime: this.startTime,
      endTime,
      durationMs,
      exitCode,
      signal,
      logPath: this.options.logPath,
      payloadPath: this.options.payloadPath,
      finalLines: this.finalLines,
      hadStderr: this.hadStderr || exitCode !== 0,
      failedToStart: this.failedToStart,
      errorMessage: this.errorMessage
    };

    const status =
      this.failedToStart
        ? 'Failed to start'
        : exitCode === 0
          ? 'Completed successfully'
          : 'Completed with error';

    const summary = [
      '',
      '────────────────────────────────────────',
      `Status: ${status}`,
      `Duration: ${formatDuration(durationMs)} | Exit code: ${exitCode}`,
      resultBase.hadStderr ? 'stderr/error output detected.' : undefined
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');

    this.writeLineBlock(summary);
    this.writeToLog(`${summary}\n`);

    await this.finishLogStream();

    let notificationSent = false;
    let notificationError: string | undefined;

    try {
      const notificationPayload = buildNotificationPayload(
        resultBase,
        this.options.maxNotificationCharacters
      );

      fs.writeFileSync(this.options.payloadPath, JSON.stringify(notificationPayload, null, 2), 'utf8');

      this.writeLine('');
      this.writeLine('[Notifier] Sending notification...');

      await sendDirectNotification(
        this.options.channelConfig,
        notificationPayload.subject,
        notificationPayload.message
      );

      notificationSent = true;
      this.writeLine(`[Notifier] ${channelLabel(this.options.channelConfig.channel)} notification sent.`);
    } catch (error) {
      notificationSent = false;
      notificationError = error instanceof Error ? error.message : String(error);

      this.writeLine(`[Notifier] Notification failed: ${notificationError}`);
      this.writeLine(`[Notifier] Payload saved: ${this.options.payloadPath}`);
    }

    const finalResult: RunResult = {
      ...resultBase,
      notificationSent,
      notificationError
    };

    const localReport = buildLocalReport(finalResult);
    const localReportPath = this.options.payloadPath.replace(/\.json$/i, '.txt');
    fs.writeFileSync(localReportPath, localReport, 'utf8');

    const toastMessage = notificationSent
      ? `Command ${status.toLowerCase()}. Notification sent.`
      : `Command ${status.toLowerCase()}. Notification failed.`;

    vscode.window.showInformationMessage(
      toastMessage,
      'Open Log',
      'Open Payload',
      'Open Logs Folder'
    ).then(async (choice) => {
      if (choice === 'Open Log') {
        await openFile(this.options.logPath);
      } else if (choice === 'Open Payload') {
        await openFile(localReportPath);
      } else if (choice === 'Open Logs Folder') {
        await vscode.commands.executeCommand(
          'revealFileInOS',
          vscode.Uri.file(path.dirname(this.options.logPath))
        );
      }
    });

    this.writeLine('[Notifier] Done.');
    this.options.onDidFinish?.(exitCode);
    this.closeEmitter.fire(exitCode ?? 1);
  }

  private writeRaw(text: string): void {
    this.writeEmitter.fire(toTerminalText(text));
  }

  private writeLine(text: string): void {
    this.writeEmitter.fire(`${toTerminalText(text)}\r\n`);
  }

  private writeLineBlock(text: string): void {
    this.writeEmitter.fire(`${toTerminalText(text)}\r\n`);
  }

  private writeToLog(text: string): void {
    this.logStream?.write(text);
  }

  private finishLogStream(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.logStream) {
        resolve();
        return;
      }

      this.logStream.end(resolve);
    });
  }
}

function buildExecutionCommand(command: string, sessionConfig: SessionConfig): BuiltCommand {
  const trimmedCommand = command.trim();

  if (sessionConfig.environmentMode === 'none') {
    return {
      command: trimmedCommand,
      environmentDescription: ''
    };
  }

  if (sessionConfig.environmentMode === 'conda') {
    const envName = sessionConfig.condaEnvName.trim();
    return {
      command: `conda run --no-capture-output -n ${quoteShellArg(envName)} ${trimmedCommand}`,
      environmentDescription: `Conda env: ${envName}`
    };
  }

  if (sessionConfig.environmentMode === 'python') {
    const pythonExecutable = sessionConfig.pythonExecutable.trim();
    const pythonCommand = stripLeadingPythonCommand(trimmedCommand);

    return {
      command: `${quoteShellArg(pythonExecutable)} ${pythonCommand}`,
      environmentDescription: `Python executable: ${pythonExecutable}`
    };
  }

  const customPrefix = sessionConfig.customPrefix.trim();
  return {
    command: `${customPrefix} ${trimmedCommand}`,
    environmentDescription: `Custom prefix: ${customPrefix}`
  };
}

function stripLeadingPythonCommand(command: string): string {
  const trimmed = command.trim();

  const quotedPythonMatch = trimmed.match(/^"[^"]*python(?:\.exe)?"\s+(.+)$/i);
  if (quotedPythonMatch) {
    return quotedPythonMatch[1].trim();
  }

  const pythonMatch = trimmed.match(/^(python|python\.exe|py)\s+(.+)$/i);
  if (pythonMatch) {
    return pythonMatch[2].trim();
  }

  return trimmed;
}

function buildNotificationPayload(
  result: RunResultBase,
  maxNotificationCharacters: number
): {
  subject: string;
  message: string;
  channel: NotificationChannel;
  target: string;
  run: Record<string, unknown>;
} {
  const fullLog = safeReadFile(result.logPath);
  const commandOnlyOutput = extractCommandOutputFromLog(fullLog);

  const status =
    result.failedToStart
      ? 'Failed to start'
      : result.exitCode === 0
        ? 'Completed successfully'
        : 'Completed with error';

  let selectedOutput =
    result.mode === 'Final Output'
      ? cleanFinalOutputLines(result.finalLines.join('\n'))
      : cleanNotificationOutput(commandOnlyOutput);

  if (!selectedOutput.trim()) {
    selectedOutput = '[No output captured]';
  }

  let truncated = false;

  if (selectedOutput.length > maxNotificationCharacters) {
    truncated = true;
    selectedOutput =
      selectedOutput.slice(0, maxNotificationCharacters) +
      `\n\n[Output truncated. Full log is saved locally.]`;
  }

  const subject = `[Terminal Notifier] ${status}`;

  const message = buildMobileNotificationText({
    status,
    command: result.displayCommand,
    cwd: result.cwd,
    environmentDescription: result.environmentDescription,
    mode: result.mode,
    duration: formatDuration(result.durationMs),
    exitCode: result.exitCode,
    output: selectedOutput,
    truncated
  });

  return {
    subject,
    message,
    channel: result.channelConfig.channel,
    target: getPayloadTarget(result.channelConfig),
    run: {
      status,
      command: result.displayCommand,
      executedCommand: result.command,
      cwd: result.cwd,
      environmentDescription: result.environmentDescription,
      mode: result.mode,
      channel: result.channelConfig.channel,
      startedAt: result.startTime.toISOString(),
      finishedAt: result.endTime.toISOString(),
      duration: formatDuration(result.durationMs),
      exitCode: result.exitCode,
      signal: result.signal ?? 'none',
      hadStderr: result.hadStderr,
      failedToStart: result.failedToStart,
      errorMessage: result.errorMessage ?? null,
      logPath: result.logPath,
      outputWasTruncated: truncated
    }
  };
}

function buildMobileNotificationText(args: {
  status: string;
  command: string;
  cwd: string;
  environmentDescription: string;
  mode: NotifyMode;
  duration: string;
  exitCode: number | null;
  output: string;
  truncated: boolean;
}): string {
  const statusIcon = args.exitCode === 0 ? '\u2705' : '\u274c';
  const divider = '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500';

  // Clean [input] markers for readable notification body.
  // Handles three cases:
  //   "[input] foo"         → "You: foo"
  //   "You: [input] foo"    → "You: foo"  (Python prompt + echoed input on same line)
  //   "Image path ...: [input] foo" → "Image path ...: foo"  (file prompts)
  const cleanedOutput = args.output
    .split('\n')
    .map(line => {
      if (line.startsWith('[input] ')) { return 'You: ' + line.slice('[input] '.length); }
      if (line.includes('[input] '))   { return line.replace(/\[input\] /g, ''); }
      return line;
    })
    // Remove any consecutive duplicate lines that survive after cleaning
    // (e.g. both "You: [input] X" and "[input] X" cleaning to the same "You: X")
    .filter((line, i, arr) => i === 0 || line !== arr[i - 1])
    .join('\n')
    .trim();

  // Shared metadata header (same structure for both modes; output content differs).
  const envLine   = args.environmentDescription ? `Env:     ${args.environmentDescription}` : undefined;
  const headerLines = [
    `\ud83d\udd14 ${statusIcon} ${args.duration} | exit ${args.exitCode}`,
    '',
    `Mode:    ${args.mode}`,
    `Dir:     ${args.cwd}`,
    envLine,
    `Cmd:     ${args.command}`,
    '',
    divider
  ].filter((line): line is string => line !== undefined);

  const footerLines: string[] = [];
  if (args.truncated) {
    footerLines.push('', '[Output truncated — full log saved locally.]');
  }

  return [...headerLines, cleanedOutput, ...footerLines].join('\n');
}

function buildTestNotificationText(channelConfig: ChannelConfig, sessionConfig: SessionConfig): string {
  const environmentDescription = buildEnvironmentDescription(sessionConfig);

  return [
    `🔔 ✅ Test notification | ${channelLabel(channelConfig.channel)}`,
    '',
    'Run:',
    indentBlock([
      `Working dir: ${sessionConfig.workingDirectory}`,
      environmentDescription ? `Environment: ${environmentDescription}` : undefined
    ].filter((line): line is string => line !== undefined).join('\n')),
    '',
    'Output:',
    indentBlock('Terminal Notifier is configured correctly.')
  ].join('\n');
}

async function sendDirectNotification(
  channelConfig: ChannelConfig,
  subject: string,
  message: string
): Promise<void> {
  if (channelConfig.channel === 'telegram') {
    await sendTelegramNotification(channelConfig, subject, message);
    return;
  }

  await sendDiscordNotification(channelConfig, subject, message);
}

async function sendTelegramNotification(
  channelConfig: ChannelConfig,
  _subject: string,
  message: string
): Promise<void> {
  const botToken = channelConfig.telegramBotToken;
  const chatId = channelConfig.telegramChatId;

  if (!botToken) {
    throw new Error('Telegram bot token is missing.');
  }

  if (!chatId) {
    throw new Error('Telegram chat ID is missing.');
  }

  const chunks = chunkText(message, TELEGRAM_MESSAGE_LIMIT);

  for (let i = 0; i < chunks.length; i++) {
    const text = chunks.length === 1
      ? chunks[i]
      : `[${i + 1}/${chunks.length}]\n${chunks[i]}`;

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      })
    });

    const body = await response.json().catch(() => ({})) as {
      ok?: boolean;
      description?: string;
    };

    if (!response.ok || body.ok === false) {
      throw new Error(body.description || `Telegram sendMessage failed with status ${response.status}.`);
    }
  }
}

async function sendDiscordNotification(
  channelConfig: ChannelConfig,
  subject: string,
  message: string
): Promise<void> {
  const webhookUrl = channelConfig.discordWebhookUrl;

  if (!webhookUrl) {
    throw new Error('Discord webhook URL is missing.');
  }

  const safeContent = sanitizeDiscordContent(message);
  const chunks = chunkText(`**${escapeDiscordMarkdown(subject)}**\n${safeContent}`, DISCORD_MESSAGE_LIMIT);

  for (let i = 0; i < chunks.length; i++) {
    const content = chunks.length === 1
      ? chunks[i]
      : `**Terminal Notifier [${i + 1}/${chunks.length}]**\n${chunks[i]}`;

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username: 'Terminal Notifier',
        content
      })
    });

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(`Discord webhook failed with status ${response.status}: ${responseText}`);
    }
  }
}

async function fetchTelegramUpdates(botToken: string): Promise<TelegramUpdate[]> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`);
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    result?: Array<Record<string, unknown>>;
    description?: string;
  };

  if (!response.ok || body.ok === false) {
    throw new Error(body.description || `Telegram getUpdates failed with status ${response.status}.`);
  }

  return (body.result ?? []).map((update) => {
    const message = (update.message || update.channel_post || {}) as Record<string, unknown>;
    const chat = (message.chat || {}) as Record<string, unknown>;
    const from = (message.from || {}) as Record<string, unknown>;

    return {
      update_id: update.update_id as number | undefined,
      chat_id: chat.id as number | string | undefined,
      chat_type: chat.type as string | undefined,
      chat_title: chat.title as string | null | undefined,
      username: from.username as string | null | undefined,
      first_name: from.first_name as string | null | undefined,
      text: message.text as string | null | undefined,
      date: message.date as number | null | undefined
    };
  });
}

function buildLocalReport(result: RunResult): string {
  const status =
    result.failedToStart
      ? 'Failed to start'
      : result.exitCode === 0
        ? 'Completed successfully'
        : 'Completed with error';

  return [
    'Terminal Notifier Local Report',
    '',
    `Status: ${status}`,
    `Channel: ${channelLabel(result.channelConfig.channel)}`,
    `Notification sent: ${result.notificationSent ? 'yes' : 'no'}`,
    result.notificationError ? `Notification error: ${result.notificationError}` : undefined,
    `Command: ${result.displayCommand}`,
    `Executed command: ${result.command}`,
    `Working directory: ${result.cwd}`,
    result.environmentDescription ? `Environment: ${result.environmentDescription}` : undefined,
    `Mode: ${result.mode}`,
    `Started: ${result.startTime.toISOString()}`,
    `Finished: ${result.endTime.toISOString()}`,
    `Duration: ${formatDuration(result.durationMs)}`,
    `Exit code: ${result.exitCode}`,
    `Signal: ${result.signal ?? 'none'}`,
    `Had stderr: ${result.hadStderr ? 'yes' : 'no'}`,
    `Log path: ${result.logPath}`,
    `Payload path: ${result.payloadPath}`,
    '',
    '========== FINAL LINES =========',
    result.finalLines.join('\n') || '[No final lines captured]'
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function getWebviewHtml(state: {
  channel: NotificationChannel;
  telegramBotToken: string;
  telegramChatId: string;
  discordWebhookUrl: string;
  defaultMode: NotifyMode;
  finalOutputLineCount: number;
  commandHistory: string[];
  workingDirectory: string;
  workspaceRoot: string;
  environmentMode: EnvironmentMode;
  condaEnvName: string;
  pythonExecutable: string;
  customPrefix: string;
}): string {
  const telegramChecked  = state.channel === 'telegram' ? 'checked' : '';
  const discordChecked   = state.channel === 'discord'  ? 'checked' : '';
  const finalChecked     = state.defaultMode === 'Final Output'  ? 'checked' : '';
  const fullChecked      = state.defaultMode === 'Full Terminal' ? 'checked' : '';
  const envNoneChecked   = state.environmentMode === 'none'   ? 'checked' : '';
  const envCondaChecked  = state.environmentMode === 'conda'  ? 'checked' : '';
  const envPythonChecked = state.environmentMode === 'python' ? 'checked' : '';
  const envCustomChecked = state.environmentMode === 'custom' ? 'checked' : '';
  const escapedTelegramBotToken  = escapeHtml(state.telegramBotToken);
  const escapedTelegramChatId    = escapeHtml(state.telegramChatId);
  const escapedDiscordWebhookUrl = escapeHtml(state.discordWebhookUrl);
  const escapedWorkingDirectory  = escapeHtml(state.workingDirectory);
  const escapedWorkspaceRoot     = escapeHtml(state.workspaceRoot);
  const escapedCondaEnvName      = escapeHtml(state.condaEnvName);
  const escapedPythonExecutable  = escapeHtml(state.pythonExecutable);
  const escapedCustomPrefix      = escapeHtml(state.customPrefix);
  const commandHistoryJson       = safeJsonForHtml(state.commandHistory);
  const startPage = (state.telegramBotToken || state.discordWebhookUrl) ? 2 : 1;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  padding: 8px 8px 16px;
  font-family: var(--vscode-font-family);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font-size: 12px;
}

/* ── pages ── */
.page { display: none; }
.page.active { display: flex; flex-direction: column; gap: 7px; }

/* ── top bar ── */
.top {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 6px;
}
.top-center { text-align: center; }
.top-right  { justify-self: end; }
.icon {
  width: 24px; height: 24px; border-radius: 6px;
  display: grid; place-items: center;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: 1px solid #42a5f5; flex: 0 0 auto; font-size: 13px;
}
h1 { font-size: 14px; font-weight: 700; }

/* ── two-col grid ── */
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  align-items: start;
}
.two-col.stretch { align-items: stretch; }

/* ── cards ── */
.card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 9px;
  background: var(--vscode-sideBar-background);
  padding: 9px;
}
.card-title {
  font-size: 10px; letter-spacing: .06em;
  text-transform: uppercase; opacity: .65;
  font-weight: 700; margin-bottom: 7px;
}

/* ── channel cards (page 1) ── */
.channels { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 8px; }
.ch-card {
  display: flex; gap: 6px; align-items: center;
  padding: 7px; border: 1px solid #42a5f5; border-radius: 7px;
  cursor: pointer; background: var(--vscode-editor-background);
}
.ch-card.active { outline: 1.5px solid var(--vscode-focusBorder); }
.ch-card input { width: auto; }
.ch-name { font-weight: 700; font-size: 12px; }
.ch-sub  { font-size: 10px; opacity: .58; }

/* ── forms ── */
.field-label { display: block; font-size: 11px; opacity: .8; margin: 4px 0 1px; }
.row-inp { display: grid; grid-template-columns: 1fr auto; gap: 5px; }
input, textarea {
  width: 100%;
  border: 1px solid var(--vscode-input-border);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border-radius: 7px; padding: 5px 7px;
  font: inherit; outline: none;
}
textarea {
  min-height: 52px; resize: vertical;
  font-family: var(--vscode-editor-font-family); font-size: 11.5px; line-height: 1.3;
}
.panel { display: none; }
.panel.active { display: block; }

/* ── radio pills ── */
.radio-row { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0 3px; }
.radio {
  display: flex; align-items: center; gap: 4px;
  font-size: 12px; border: 1px solid #42a5f5;
  border-radius: 6px; padding: 3px 7px;
  cursor: pointer; background: var(--vscode-editor-background);
}
.radio input { width: auto; }

/* ── buttons ── */
.btn-row { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 7px; }
button {
  border: 1px solid #42a5f5; border-radius: 7px;
  padding: 5px 9px; font: inherit; font-size: 12px;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  cursor: pointer; font-weight: 600;
}
button:hover { background: var(--vscode-button-hoverBackground); border-color: #80d8ff; }
button.sec {
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground);
}
button.sec:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.ghost { background: transparent; color: var(--vscode-foreground); }
button.sm { padding: 2px 6px; font-size: 10px; border-radius: 5px; }
button.full { width: 100%; font-size: 13px; padding: 7px; margin-top: 6px; }

/* ── hint / status ── */
.hint { font-size: 10px; opacity: .58; line-height: 1.35; margin-top: 3px; }
.status {
  margin-top: 6px; padding: 5px 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 7px; display: none;
  white-space: pre-wrap; line-height: 1.3; font-size: 11px;
}
.status.show { display: block; }
.status.ok   { border-color: var(--vscode-testing-iconPassed); }
.status.err  { border-color: var(--vscode-testing-iconFailed); }
.status.info { border-color: var(--vscode-focusBorder); }

/* ── help card (page 1 right) ── */
.help-card {
  border: 1px solid var(--vscode-panel-border); border-radius: 9px;
  background: var(--vscode-sideBarSectionHeader-background, var(--vscode-sideBar-background));
  padding: 9px; font-size: 11px; line-height: 1.5;
}
.help-title { font-size: 10px; text-transform: uppercase; opacity: .65; font-weight: 700; margin-bottom: 7px; }
.help-panel { display: none; }
.help-panel.active { display: block; }
ol.steps { padding-left: 18px; }
ol.steps li { margin-bottom: 5px; }
code {
  font-family: var(--vscode-editor-font-family, monospace); font-size: 10px;
  background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px;
}

/* ── channel badge (page 2) ── */
/* ch-inline: badge + change button — sits in top-left cell */
.ch-inline {
  display: flex; align-items: center; gap: 5px;
}
.ch-label {
  font-size: 11px; font-weight: 700; opacity: .85;
}

/* ── active run card — border state colours ── */
.run-card {
  border: 3px solid var(--vscode-panel-border);
  border-radius: 9px;
  background: var(--vscode-sideBar-background);
  padding: 9px;
  display: flex; flex-direction: column; gap: 5px;
  transition: border-color .25s;
}
.run-card.live { border-color: #2e7d32; }
.run-card.err  { border-color: #b71c1c; }

/* ── live badge ── */
.live-bar { display: flex; align-items: center; gap: 6px; min-height: 18px; }
.live-badge {
  display: none; font-size: 10px; font-weight: 700;
  background: #1b5e20; color: #a5d6a7;
  border-radius: 4px; padding: 1px 6px;
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse { 0%,100%{opacity:1}50%{opacity:.5} }
.live-badge.show { display: inline-block; }

/* ── output tail ── */
.out-labels { display: flex; align-items: center; justify-content: space-between; }
.out-tail-label { font-size: 10px; opacity: .55; text-transform: uppercase; letter-spacing: .04em; }
.out-tail {
  background: var(--vscode-terminal-background, var(--vscode-editor-background));
  color: var(--vscode-terminal-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-panel-border); border-radius: 7px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px; padding: 6px 8px;
  height: 200px;
  overflow-y: scroll;
  white-space: pre-wrap; word-break: break-all;
  line-height: 1.4;
}
.out-ph { opacity: .4; font-style: italic; font-family: var(--vscode-font-family); }

/* ── input + run-actions ── */
.input-label { font-size: 10px; opacity: .7; margin: 4px 0 2px; }
.run-actions { display: flex; gap: 4px; flex-wrap: wrap; }

/* ── cmd header ── */
.cmd-header { display: flex; align-items: center; justify-content: space-between; margin: 5px 0 2px; }
.cmd-header .field-label { margin: 0; }
.hist-btns { display: flex; gap: 3px; }

/* ── telegram updates ── */
.updates {
  display: none; margin-top: 5px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 7px; max-height: 100px; overflow-y: auto;
}
.updates.show { display: block; }
.upd-row {
  padding: 5px 7px; border-bottom: 1px solid var(--vscode-panel-border);
  cursor: pointer; font-size: 11px;
}
.upd-row:last-child { border-bottom: 0; }
.upd-row:hover { background: var(--vscode-list-hoverBackground); }
.muted { opacity: .6; }
.mono { font-family: var(--vscode-editor-font-family, monospace); }
</style>
</head>
<body>

<!-- ══════════ PAGE 1: Notify Setup ══════════ -->
<div id="page1" class="page">
  <div class="top">
    <div class="icon">&#128276;</div>
    <h1>Notify Setup</h1>
  </div>

  <div class="two-col">
    <!-- Left: config form -->
    <div class="card">
      <div class="card-title">Channel</div>
      <div class="channels">
        <label class="ch-card" data-ch="telegram">
          <input type="radio" name="channel" value="telegram" ${telegramChecked}/>
          <div><div class="ch-name">Telegram</div><div class="ch-sub">Bot token</div></div>
        </label>
        <label class="ch-card" data-ch="discord">
          <input type="radio" name="channel" value="discord" ${discordChecked}/>
          <div><div class="ch-name">Discord</div><div class="ch-sub">Webhook</div></div>
        </label>
      </div>

      <div id="tgPanel" class="panel">
        <label class="field-label">Bot token</label>
        <div class="row-inp">
          <input id="telegramBotToken" type="password"
                 value="${escapedTelegramBotToken}" placeholder="110:AAFg..."/>
          <button id="toggleToken" class="ghost sm">Show</button>
        </div>
        <label class="field-label">Chat ID</label>
        <div class="row-inp">
          <input id="telegramChatId" value="${escapedTelegramChatId}" placeholder="1288248328"/>
          <button id="fetchUpdates" class="sec sm">Fetch</button>
        </div>
        <div id="updates" class="updates"></div>
      </div>

      <div id="dcPanel" class="panel">
        <label class="field-label">Webhook URL</label>
        <div class="row-inp">
          <input id="discordWebhookUrl" type="password"
                 value="${escapedDiscordWebhookUrl}"
                 placeholder="https://discord.com/api/webhooks/..."/>
          <button id="toggleWebhook" class="ghost sm">Show</button>
        </div>
      </div>

      <div class="btn-row">
        <button id="saveConfig">Save</button>
        <button id="clearConfig" class="sec">Clear</button>
        <button id="testConfig" class="sec">Test</button>
      </div>
      <div id="statusP1" class="status"></div>

      <div style="display:flex;justify-content:flex-end;margin-top:8px">
        <button id="goRun">Run &rarr;</button>
      </div>
    </div>

    <!-- Right: setup guide -->
    <div class="help-card">
      <div class="help-title">Setup guide</div>

      <div id="helpNone" class="help-panel active">
        <div style="opacity:.55">Select a channel to see setup instructions.</div>
      </div>

      <div id="helpTg" class="help-panel">
        <strong>Telegram Bot</strong>
        <ol class="steps">
          <li>Search <code>@BotFather</code> on Telegram</li>
          <li>Send <code>/newbot</code>, follow prompts</li>
          <li>Copy the <strong>bot token</strong> it gives you</li>
          <li>Send any message <strong>to your bot</strong></li>
          <li>Click <strong>Fetch</strong> to auto-fill Chat ID</li>
          <li><strong>Save</strong> then <strong>Test</strong></li>
        </ol>
        <div class="hint" style="margin-top:6px">Token format: <code>110:AAFg...</code></div>
      </div>

      <div id="helpDc" class="help-panel">
        <strong>Discord Webhook</strong>
        <ol class="steps">
          <li>Open your Discord server</li>
          <li>Server Settings &rarr; Integrations &rarr; Webhooks</li>
          <li>Click <strong>New Webhook</strong>, pick a channel</li>
          <li>Click <strong>Copy Webhook URL</strong></li>
          <li>Paste it here, <strong>Save</strong>, then <strong>Test</strong></li>
        </ol>
        <div class="hint" style="margin-top:6px">URL: <code>discord.com/api/webhooks/...</code></div>
      </div>

      <div id="helpMode" style="margin-top:10px;padding-top:8px;border-top:1px solid var(--vscode-panel-border)">
        <div class="help-title">Output modes</div>
        <div style="margin-bottom:5px"><strong>Final Output</strong> — only the meaningful
        results (responses, detections, metrics). Strips all framework boot noise and
        progress bars. Best for interactive scripts and training runs.</div>
        <div><strong>Full Terminal</strong> — the complete captured output, lightly filtered
        (removes conda/VS noise). Best when you need to debug a crash or see raw logs.</div>
      </div>
    </div>
  </div>
</div>

<!-- ══════════ PAGE 2: Run ══════════ -->
<div id="page2" class="page">
  <div class="top">
    <div class="ch-inline" id="chInline">
      <span id="chBadge" class="ch-label">&#128276; via Telegram</span>
      <button id="changeChannel" class="ghost sm">&larr; Change</button>
    </div>
    <div class="top-center">
      <h1>Terminal Notifier</h1>
    </div>
    <div class="top-right"><!-- spacer --></div>
  </div>

  <div class="two-col stretch">
    <!-- Left: run config -->
    <div class="card" style="display:flex;flex-direction:column;gap:2px">
      <div class="card-title">Run config</div>

      <label class="field-label">Directory</label>
      <input id="workingDirectory" class="mono"
             value="${escapedWorkingDirectory}" placeholder="${escapedWorkspaceRoot}"/>
      <div class="btn-row" style="margin-top:2px">
        <button id="useRoot" class="sec sm">Root</button>
        <button id="browseDir" class="sec sm">Browse</button>
      </div>

      <label class="field-label">Environment</label>
      <div class="radio-row">
        <label class="radio"><input type="radio" name="envMode" value="none"   ${envNoneChecked}/>None</label>
        <label class="radio"><input type="radio" name="envMode" value="conda"  ${envCondaChecked}/>Conda</label>
        <label class="radio"><input type="radio" name="envMode" value="python" ${envPythonChecked}/>Python</label>
        <label class="radio"><input type="radio" name="envMode" value="custom" ${envCustomChecked}/>Custom</label>
      </div>

      <div id="condaPanel" class="panel">
        <input id="condaEnvName" class="mono" value="${escapedCondaEnvName}" placeholder="python3.10env"/>
        <div class="hint">conda run --no-capture-output -n &lt;env&gt;</div>
      </div>
      <div id="pythonPanel" class="panel">
        <input id="pythonExecutable" class="mono" value="${escapedPythonExecutable}"
               placeholder="C:\\envs\\myenv\\python.exe"/>
        <div class="hint">Best for interactive scripts with input()</div>
      </div>
      <div id="customPanel" class="panel">
        <input id="customPrefix" class="mono" value="${escapedCustomPrefix}" placeholder="custom prefix"/>
      </div>

      <label class="field-label">Output mode</label>
      <div class="radio-row">
        <label class="radio"><input type="radio" name="mode" value="Final Output"  ${finalChecked}/>Final</label>
        <label class="radio"><input type="radio" name="mode" value="Full Terminal" ${fullChecked}/>Full</label>
      </div>

      <div class="cmd-header">
        <label class="field-label">Command</label>
        <div class="hist-btns">
          <button id="prevCmd" class="ghost sm" title="Previous">&#8679;</button>
          <button id="nextCmd" class="ghost sm" title="Next">&#8681;</button>
        </div>
      </div>
      <textarea id="command" placeholder="scripts\\inference.py --interactive"></textarea>

      <button id="runBtn" class="full">&#128276; Run + Notify</button>
      <button id="openLogs" class="sec full" style="margin-top:3px">Logs</button>
    </div>

    <!-- Right: active run -->
    <div class="run-card" id="runCard">
      <div class="card-title">Output screen</div>

      <div class="live-bar">
        <span id="liveBadge" class="live-badge">&#9679; LIVE</span>
      </div>

      <!-- Output tail fills available space; sits at bottom of the card -->
      <div class="out-labels">
        <span class="out-tail-label">Output</span>
        <button id="clearOutput" class="ghost sm" title="Clear display (does not affect notification)">&#10006; Clear</button>
      </div>
      <div id="outTail" class="out-tail">
        <span class="out-ph" id="outPh">No active run.</span>
      </div>

      <div class="input-label">Send input to script:</div>
      <div class="row-inp">
        <input id="activeInput" class="mono" placeholder="Type here, press Enter"/>
        <button id="sendInput" class="sec">Send</button>
      </div>

      <div class="run-actions">
        <button id="sendEmpty" class="sec sm">&#8629; Empty line</button>
        <button id="stopRun"   class="sec sm">&#9632; Stop</button>
        <button id="openTerm"  class="ghost sm">&#9699; Terminal</button>
      </div>
      <div class="hint">Use input box when script waits at You: / Image path:&thinsp;/&thinsp;any input().</div>
      <div id="statusP2" class="status"></div>
    </div>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();

  // ── Pages ──
  let curPage = ${startPage};
  const p1 = document.getElementById('page1');
  const p2 = document.getElementById('page2');

  function showPage(n) {
    curPage = n;
    p1.classList.toggle('active', n === 1);
    p2.classList.toggle('active', n === 2);
    if (n === 2) { updateBadge(); }
    if (n === 1) { updateHelp(); }
  }
  showPage(curPage);

  document.getElementById('goRun').addEventListener('click', () => showPage(2));
  document.getElementById('changeChannel').addEventListener('click', () => showPage(1));

  // ── Helpers ──
  function getChannel()  { const s = document.querySelector('input[name="channel"]:checked');  return s ? s.value : 'telegram'; }
  function getMode()     { const s = document.querySelector('input[name="mode"]:checked');     return s ? s.value : 'Final Output'; }
  function getEnvMode()  { const s = document.querySelector('input[name="envMode"]:checked');  return s ? s.value : 'none'; }

  function updateBadge() {
    const ch = getChannel();
    document.getElementById('chBadge').textContent =
      ch === 'discord' ? '\\uD83D\\uDD14 via Discord' : '\\uD83D\\uDD14 via Telegram';
  }

  function updateHelp() {
    const ch = getChannel();
    document.getElementById('helpNone').classList.toggle('active', ch !== 'telegram' && ch !== 'discord');
    document.getElementById('helpTg').classList.toggle('active', ch === 'telegram');
    document.getElementById('helpDc').classList.toggle('active', ch === 'discord');
  }

  function updatePanels() {
    const ch  = getChannel();
    const env = getEnvMode();
    document.getElementById('tgPanel').classList.toggle('active', ch === 'telegram');
    document.getElementById('dcPanel').classList.toggle('active', ch === 'discord');
    document.querySelectorAll('[data-ch]').forEach(el => {
      el.classList.toggle('active', el.dataset.ch === ch);
    });
    document.getElementById('condaPanel').classList.toggle('active',  env === 'conda');
    document.getElementById('pythonPanel').classList.toggle('active', env === 'python');
    document.getElementById('customPanel').classList.toggle('active', env === 'custom');
    updateHelp();
  }

  document.querySelectorAll('input[name="channel"]').forEach(i => i.addEventListener('change', updatePanels));
  document.querySelectorAll('input[name="envMode"]').forEach(i => i.addEventListener('change', updatePanels));

  // ── Status ──
  const statusP1 = document.getElementById('statusP1');
  const statusP2 = document.getElementById('statusP2');
  function showStatus(level, text) {
    const el = curPage === 1 ? statusP1 : statusP2;
    el.className = 'status show ' + level;
    el.textContent = text;
  }

  // ── Run card border state ──
  const runCard = document.getElementById('runCard');
  function setRunBorder(state) {
    runCard.classList.remove('live', 'err');
    if (state) { runCard.classList.add(state); }
  }

  // ── Output tail (fixed scroll, no growth) ──
  const outTailEl = document.getElementById('outTail');
  const outPhEl   = document.getElementById('outPh');
  const liveBadge = document.getElementById('liveBadge');
  const MAX_LINES = 200;
  let tailBuffer  = '';

  function stripAnsi(s) {
    return s
      .replace(/\\u001b\\[[0-9;]*[mGKHFJA-Za-z]/g, '')
      .replace(/\\u001b[()][AB012]/g, '');
  }

  function appendTail(raw) {
    const clean = stripAnsi(raw).replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
    tailBuffer += clean;
    const all = tailBuffer.split('\\n');
    if (all.length > MAX_LINES + 1) {
      tailBuffer = all.slice(-(MAX_LINES + 1)).join('\\n');
    }
    // Preserve user scroll position unless they're near the bottom
    const atBottom = outTailEl.scrollHeight - outTailEl.scrollTop - outTailEl.clientHeight < 40;
    outTailEl.textContent = tailBuffer.split('\\n').slice(-MAX_LINES).join('\\n');
    if (atBottom) { outTailEl.scrollTop = outTailEl.scrollHeight; }
  }

  function setLive(on) {
    liveBadge.classList.toggle('show', on);
    if (on) {
      tailBuffer = '';
      outPhEl.style.display = 'none';
      outTailEl.textContent = '';
      setRunBorder('live');
    } else {
      // Always reset border to template when run ends, is stopped, or errors
      setRunBorder(null);
    }
  }

  // Clear button — clears display and resets border. Does NOT touch finalLines in TS.
  document.getElementById('clearOutput').addEventListener('click', () => {
    tailBuffer = '';
    outTailEl.textContent = '';
    outPhEl.style.display = 'none';
    setRunBorder(null);
    liveBadge.classList.remove('show');
  });

  // ── Command history ──
  let history   = ${commandHistoryJson};
  let histCur   = -1;
  let draftCmd  = '';

  function pushHistory(cmd) {
    const t = cmd.trim();
    if (!t) { return; }
    history = [t, ...history.filter(x => x !== t)].slice(0, 50);
    histCur = -1; draftCmd = '';
  }
  function recall(dir) {
    if (!history.length) { showStatus('info', 'No history yet.'); return; }
    const el = document.getElementById('command');
    if (histCur === -1) { draftCmd = el.value; }
    if (dir < 0) {
      if (histCur < history.length - 1) { histCur++; }
    } else {
      if (histCur > 0) { histCur--; }
      else { histCur = -1; el.value = draftCmd; el.focus(); return; }
    }
    el.value = history[histCur] || '';
    el.focus();
  }

  // ── Payload ──
  function payload(type) {
    return {
      type,
      channel:           getChannel(),
      telegramBotToken:  document.getElementById('telegramBotToken').value,
      telegramChatId:    document.getElementById('telegramChatId').value,
      discordWebhookUrl: document.getElementById('discordWebhookUrl').value,
      workingDirectory:  document.getElementById('workingDirectory').value,
      environmentMode:   getEnvMode(),
      condaEnvName:      document.getElementById('condaEnvName').value,
      pythonExecutable:  document.getElementById('pythonExecutable').value,
      customPrefix:      document.getElementById('customPrefix').value
    };
  }

  // ── Show/hide token ──
  function togglePw(inputId, btnId) {
    const el = document.getElementById(inputId);
    const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    document.getElementById(btnId).textContent = show ? 'Hide' : 'Show';
  }
  document.getElementById('toggleToken').addEventListener('click',   () => togglePw('telegramBotToken', 'toggleToken'));
  document.getElementById('toggleWebhook').addEventListener('click', () => togglePw('discordWebhookUrl', 'toggleWebhook'));

  // ── Page 1 buttons ──
  document.getElementById('saveConfig').addEventListener('click',  () => vscode.postMessage(payload('saveConfig')));
  document.getElementById('clearConfig').addEventListener('click', () => vscode.postMessage({ type: 'clearConfig' }));
  document.getElementById('testConfig').addEventListener('click',  () => { showStatus('info', 'Sending test...'); vscode.postMessage(payload('testNotification')); });
  document.getElementById('fetchUpdates').addEventListener('click',() => { showStatus('info', 'Fetching...'); vscode.postMessage(payload('fetchTelegramUpdates')); });

  // ── Page 2 buttons ──
  document.getElementById('useRoot').addEventListener('click',   () => vscode.postMessage(payload('useWorkspaceRoot')));
  document.getElementById('browseDir').addEventListener('click', () => vscode.postMessage(payload('browseWorkingDirectory')));
  document.getElementById('openLogs').addEventListener('click',  () => vscode.postMessage({ type: 'openLogsFolder' }));
  document.getElementById('stopRun').addEventListener('click',   () => vscode.postMessage({ type: 'stopActiveRun' }));
  document.getElementById('openTerm').addEventListener('click',  () => vscode.postMessage({ type: 'openActiveTerminal' }));
  document.getElementById('prevCmd').addEventListener('click',   () => recall(-1));
  document.getElementById('nextCmd').addEventListener('click',   () => recall(1));

  document.getElementById('runBtn').addEventListener('click', () => {
    const cmd = document.getElementById('command').value;
    pushHistory(cmd);
    vscode.postMessage({ ...payload('run'), command: cmd, mode: getMode() });
  });

  function sendInput(text) {
    vscode.postMessage({ type: 'sendActiveInput', inputText: text });
    if (text.trim()) { appendTail('[You] ' + text + '\\n'); }
  }
  document.getElementById('sendInput').addEventListener('click', () => {
    const el = document.getElementById('activeInput');
    sendInput(el.value); el.value = '';
  });
  document.getElementById('sendEmpty').addEventListener('click', () => {
    vscode.postMessage({ type: 'sendActiveEmptyLine' });
    appendTail('[You] (empty)\\n');
  });
  document.getElementById('activeInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); const el = document.getElementById('activeInput'); sendInput(el.value); el.value = ''; }
  });
  document.getElementById('command').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.altKey) && e.key === 'ArrowUp')   { e.preventDefault(); recall(-1); }
    if ((e.ctrlKey || e.altKey) && e.key === 'ArrowDown') { e.preventDefault(); recall(1);  }
  });
  document.getElementById('command').addEventListener('input', () => { histCur = -1; });

  // ── Telegram updates ──
  const updatesEl = document.getElementById('updates');
  function renderUpdates(updates) {
    updatesEl.innerHTML = '';
    if (!updates.length) { updatesEl.className = 'updates'; return; }
    updatesEl.className = 'updates show';
    updates.forEach(u => {
      const row = document.createElement('div');
      row.className = 'upd-row';
      const id = String(u.chat_id || ''), name = String(u.first_name || u.username || 'Chat'), txt = String(u.text || '');
      row.innerHTML = '<strong>Chat ID: </strong>' + esc(id) + ' <span class="muted">(' + esc(name) + (txt ? ' &middot; ' + esc(txt) : '') + ')</span>';
      row.addEventListener('click', () => { document.getElementById('telegramChatId').value = id; showStatus('ok', 'Filled Chat ID: ' + id); });
      updatesEl.appendChild(row);
    });
  }

  function esc(v) { return String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); }

  // ── Message handler ──
  window.addEventListener('message', ev => {
    const msg = ev.data;
    if (msg.type === 'status')              { showStatus(msg.level || 'info', msg.text || ''); }
    if (msg.type === 'sessionUpdated')      { if (msg.workingDirectory) { document.getElementById('workingDirectory').value = msg.workingDirectory; } }
    if (msg.type === 'commandHistoryUpdated') { history = msg.commandHistory || []; histCur = -1; draftCmd = ''; }
    if (msg.type === 'activeRunStarted')    {
      showPage(2); setLive(true);
      showStatus('info', 'Run started. Use input box to respond to prompts.');
    }
    if (msg.type === 'activeRunEnded')      {
      setLive(false);  // removes 'live' border, resets to template
      const ok = msg.exitCode === 0;
      if (!ok) { setRunBorder('err'); }  // show red on error; stays until next run or Clear
      showStatus(ok ? 'ok' : 'err', ok ? 'Completed successfully.' : ('Completed with error. Exit: ' + msg.exitCode));
    }
    if (msg.type === 'runOutput')           { appendTail(msg.text || ''); }
    if (msg.type === 'telegramUpdates')     { renderUpdates(msg.updates || []); }
  });

  updatePanels();
</script>
</body>
</html>`;
}



function buildChannelConfigFromMessage(message: Record<string, unknown>): ChannelConfig {
  const channel = normalizeChannel(message.channel);

  return {
    channel,
    telegramBotToken: String(message.telegramBotToken ?? '').trim(),
    telegramChatId: String(message.telegramChatId ?? '').trim(),
    discordWebhookUrl: String(message.discordWebhookUrl ?? '').trim()
  };
}

function buildSessionConfigFromMessage(
  context: vscode.ExtensionContext,
  message: Record<string, unknown>
): SessionConfig {
  const existing = getSessionConfig(context);
  const workingDirectoryInput = String(message.workingDirectory ?? existing.workingDirectory).trim();
  const environmentMode = normalizeEnvironmentMode(message.environmentMode ?? existing.environmentMode);

  return {
    workingDirectory: resolveDirectoryInput(workingDirectoryInput || existing.workingDirectory),
    environmentMode,
    condaEnvName: String(message.condaEnvName ?? existing.condaEnvName).trim(),
    pythonExecutable: String(message.pythonExecutable ?? existing.pythonExecutable).trim(),
    customPrefix: String(message.customPrefix ?? existing.customPrefix).trim()
  };
}

async function saveChannelConfig(context: vscode.ExtensionContext, config: ChannelConfig): Promise<void> {
  await context.secrets.store(CHANNEL_SECRET_KEY, config.channel);

  if (config.telegramBotToken) {
    await context.secrets.store(TELEGRAM_BOT_TOKEN_KEY, config.telegramBotToken);
  }

  if (config.telegramChatId) {
    await context.secrets.store(TELEGRAM_CHAT_ID_KEY, config.telegramChatId);
  }

  if (config.discordWebhookUrl) {
    await context.secrets.store(DISCORD_WEBHOOK_URL_KEY, config.discordWebhookUrl);
  }
}

async function saveSessionConfig(context: vscode.ExtensionContext, config: SessionConfig): Promise<void> {
  await context.workspaceState.update(WORKING_DIRECTORY_KEY, config.workingDirectory);
  await context.workspaceState.update(ENV_MODE_KEY, config.environmentMode);
  await context.workspaceState.update(CONDA_ENV_NAME_KEY, config.condaEnvName);
  await context.workspaceState.update(PYTHON_EXECUTABLE_KEY, config.pythonExecutable);
  await context.workspaceState.update(CUSTOM_PREFIX_KEY, config.customPrefix);
}

async function getSavedChannelConfig(context: vscode.ExtensionContext): Promise<ChannelConfig> {
  return {
    channel: normalizeChannel(await context.secrets.get(CHANNEL_SECRET_KEY)),
    telegramBotToken: await context.secrets.get(TELEGRAM_BOT_TOKEN_KEY),
    telegramChatId: await context.secrets.get(TELEGRAM_CHAT_ID_KEY),
    discordWebhookUrl: await context.secrets.get(DISCORD_WEBHOOK_URL_KEY)
  };
}

function getSessionConfig(context: vscode.ExtensionContext): SessionConfig {
  const workspaceRoot = getWorkspaceRoot();
  const rawDirectory = context.workspaceState.get<string>(WORKING_DIRECTORY_KEY, workspaceRoot);
  const workingDirectory = fs.existsSync(rawDirectory) ? rawDirectory : workspaceRoot;

  return {
    workingDirectory,
    environmentMode: normalizeEnvironmentMode(context.workspaceState.get<string>(ENV_MODE_KEY, 'none')),
    condaEnvName: context.workspaceState.get<string>(CONDA_ENV_NAME_KEY, ''),
    pythonExecutable: context.workspaceState.get<string>(PYTHON_EXECUTABLE_KEY, ''),
    customPrefix: context.workspaceState.get<string>(CUSTOM_PREFIX_KEY, '')
  };
}

function validateChannelConfig(config: ChannelConfig): string | undefined {
  if (config.channel === 'telegram') {
    if (!config.telegramBotToken) {
      return 'Telegram bot token is required.';
    }

    if (!config.telegramChatId) {
      return 'Telegram chat ID is required.';
    }
  }

  if (config.channel === 'discord') {
    if (!config.discordWebhookUrl) {
      return 'Discord webhook URL is required.';
    }

    const isDiscordWebhook =
      config.discordWebhookUrl.startsWith('https://discord.com/api/webhooks/') ||
      config.discordWebhookUrl.startsWith('https://discordapp.com/api/webhooks/');

    if (!isDiscordWebhook) {
      return 'Discord webhook URL should start with https://discord.com/api/webhooks/.';
    }
  }

  return undefined;
}

function validateSessionConfig(config: SessionConfig): string | undefined {
  if (!config.workingDirectory) {
    return 'Current directory is required.';
  }

  if (!fs.existsSync(config.workingDirectory)) {
    return `Current directory does not exist: ${config.workingDirectory}`;
  }

  if (!fs.statSync(config.workingDirectory).isDirectory()) {
    return `Current directory is not a folder: ${config.workingDirectory}`;
  }

  if (config.environmentMode === 'conda' && !config.condaEnvName.trim()) {
    return 'Conda env name is required when Environment is Conda.';
  }

  if (config.environmentMode === 'python') {
    if (!config.pythonExecutable.trim()) {
      return 'Python executable path is required when Environment is Python exe.';
    }

    if (!fs.existsSync(config.pythonExecutable)) {
      return `Python executable does not exist: ${config.pythonExecutable}`;
    }
  }

  if (config.environmentMode === 'custom' && !config.customPrefix.trim()) {
    return 'Custom prefix is required when Environment is Custom.';
  }

  return undefined;
}

function validateRunnableCommand(command: string, sessionConfig: SessionConfig): string | undefined {
  const normalized = command.trim().toLowerCase();

  if (/^conda\s+(activate|deactivate)\b/.test(normalized)) {
    return 'Do not use conda activate/deactivate here. Select Environment = Conda and enter only the env name.';
  }

  if (sessionConfig.environmentMode === 'custom') {
    const prefix = sessionConfig.customPrefix.trim().toLowerCase();
    if (/conda\s+(activate|deactivate)\b/.test(prefix)) {
      return 'Custom prefix cannot use conda activate/deactivate. Use Conda mode instead.';
    }
  }

  return undefined;
}

function normalizeChannel(value: unknown): NotificationChannel {
  return value === 'discord' ? 'discord' : 'telegram';
}

function normalizeEnvironmentMode(value: unknown): EnvironmentMode {
  if (value === 'conda' || value === 'python' || value === 'custom') {
    return value;
  }

  return 'none';
}

function channelLabel(channel: NotificationChannel): string {
  return channel === 'discord' ? 'Discord' : 'Telegram';
}

function buildEnvironmentDescription(config: SessionConfig): string {
  if (config.environmentMode === 'conda') {
    return `Conda env: ${config.condaEnvName}`;
  }

  if (config.environmentMode === 'python') {
    return `Python executable: ${config.pythonExecutable}`;
  }

  if (config.environmentMode === 'custom') {
    return `Custom prefix: ${config.customPrefix}`;
  }

  return '';
}

function getPayloadTarget(config: ChannelConfig): string {
  if (config.channel === 'telegram') {
    return config.telegramChatId || '[telegram chat id missing]';
  }

  return config.discordWebhookUrl ? '[discord webhook configured]' : '[discord webhook missing]';
}

function getCommandHistory(context: vscode.ExtensionContext): string[] {
  return context.workspaceState.get<string[]>(COMMAND_HISTORY_KEY, []);
}

async function rememberCommand(
  context: vscode.ExtensionContext,
  command: string
): Promise<void> {
  const trimmed = command.trim();

  if (!trimmed) {
    return;
  }

  const existing = getCommandHistory(context);

  const next = [
    trimmed,
    ...existing.filter((item) => item !== trimmed)
  ].slice(0, COMMAND_HISTORY_LIMIT);

  await context.workspaceState.update(COMMAND_HISTORY_KEY, next);
}

async function tryHandleCdCommand(
  context: vscode.ExtensionContext,
  command: string,
  currentDirectory: string
): Promise<{
  handled: boolean;
  ok: boolean;
  message: string;
  workingDirectory: string;
}> {
  const trimmed = command.trim();
  const match = trimmed.match(/^(cd|chdir)\s*(.*)$/i);

  if (!match) {
    return {
      handled: false,
      ok: false,
      message: '',
      workingDirectory: currentDirectory
    };
  }

  let target = match[2].trim();

  if (!target || target === '~') {
    target = os.homedir();
  }

  target = stripWrappingQuotes(target);

  const resolved = path.isAbsolute(target)
    ? path.normalize(target)
    : path.resolve(currentDirectory, target);

  if (!fs.existsSync(resolved)) {
    return {
      handled: true,
      ok: false,
      message: `Directory does not exist: ${resolved}`,
      workingDirectory: currentDirectory
    };
  }

  if (!fs.statSync(resolved).isDirectory()) {
    return {
      handled: true,
      ok: false,
      message: `Not a directory: ${resolved}`,
      workingDirectory: currentDirectory
    };
  }

  const existing = getSessionConfig(context);
  await saveSessionConfig(context, {
    ...existing,
    workingDirectory: resolved
  });

  return {
    handled: true,
    ok: true,
    message: `Current directory changed to: ${resolved}`,
    workingDirectory: resolved
  };
}

function getWorkspaceRoot(): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  return workspaceFolder?.uri.fsPath ?? os.homedir();
}

function resolveDirectoryInput(value: string): string {
  const stripped = stripWrappingQuotes(value.trim());

  if (!stripped) {
    return getWorkspaceRoot();
  }

  if (path.isAbsolute(stripped)) {
    return path.normalize(stripped);
  }

  return path.resolve(getWorkspaceRoot(), stripped);
}

function getLogsDirectory(context: vscode.ExtensionContext): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

  if (workspaceFolder) {
    return path.join(workspaceFolder.uri.fsPath, '.vscode', 'terminal-notifier', 'logs');
  }

  return path.join(context.globalStorageUri.fsPath, 'logs');
}

async function openFile(filePath: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(doc);
}

function safeReadFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function extractCommandOutputFromLog(fullLog: string): string {
  const marker = '────────────────────────────────────────';

  const firstMarkerIndex = fullLog.indexOf(marker);

  if (firstMarkerIndex === -1) {
    return fullLog;
  }

  const afterFirstMarker = fullLog.slice(firstMarkerIndex + marker.length);
  const secondMarkerIndex = afterFirstMarker.indexOf(marker);

  if (secondMarkerIndex === -1) {
    return afterFirstMarker.trim();
  }

  return afterFirstMarker.slice(0, secondMarkerIndex).trim();
}

function cleanNotificationOutput(output: string): string {
  return output
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();

      if (!trimmed) {
        return false;
      }

      // Windows conda/VS noise
      if (/^[a-zA-Z]:\\.*>SET\s+/i.test(trimmed)) { return false; }
      if (/^[a-zA-Z]:\\.*>set\s+/i.test(trimmed)) { return false; }
      if (/^[a-zA-Z]:\\.*>CALL\s+.*conda\\activate\.d\\/i.test(trimmed)) { return false; }
      if (/Did not find VSINSTALLDIR/i.test(trimmed)) { return false; }
      if (/Windows SDK version found as:/i.test(trimmed)) { return false; }
      if (/The system cannot find the path specified\./i.test(trimmed)) { return false; }

      return true;
    })
    .join('\n');
}

// More aggressive filter used only for Final Output notifications.
// Strips ML-framework boot noise (TF/gRPC/oneDNN warnings) so only the
// actual application output (prompts, responses, detections) reaches the
// notification body.
// cleanFinalOutputLines: aggressive filter for Final Output mode.
// Two-pass approach:
//   Pass 1 — blocklist: drop known-noise patterns (warnings, tqdm, gRPC)
//   Pass 2 — allowlist: if signal lines are present, keep ONLY those;
//                       otherwise fall back to blocklist-only output so
//                       we never send a completely empty notification.
// cleanFinalOutputLines: aggressive filter for Final Output mode.
// Two-pass approach:
//   Pass 1 — blocklist: drop known-noise patterns (warnings, tqdm, gRPC)
//   Pass 2 — context-aware allowlist with [Response] body tracking:
//             after a [Response] line, all subsequent non-empty lines are
//             kept as the response body until the next bracket-tag or empty line.
function cleanFinalOutputLines(output: string): string {
  const baseLines = cleanNotificationOutput(output).split(/\r?\n/);

  // ── Pass 1: blocklist ──
  const filtered = baseLines.filter((line) => {
    const t = line.trim();

    if (/^I\d{4}\s+\d{2}:\d{2}:/.test(t)) { return false; }
    if (/WARNING:\s+All log messages before absl/i.test(t)) { return false; }
    if (/absl::InitializeLog/i.test(t)) { return false; }
    if (/^WARNING:tensorflow:/i.test(t)) { return false; }
    if (/^WARNING:absl:/i.test(t)) { return false; }
    if (/oneDNN custom operations/i.test(t)) { return false; }
    if (/TF_ENABLE_ONEDNN_OPTS/i.test(t)) { return false; }
    if (/floating-point round-off errors/i.test(t)) { return false; }
    if (/different computation orders/i.test(t)) { return false; }
    if (/To turn them off, set the environment variable/i.test(t)) { return false; }
    if (/tf_keras.*deprecated/i.test(t)) { return false; }
    if (/The name tf\./.test(t)) { return false; }
    if (/Please use tf\.compat/i.test(t)) { return false; }

    // tqdm / progress bars
    if (/[|\u2588\u2591\u258f\u258e\u258d\u258c\u258b\u258a\u2589]/.test(line) && /\d+%/.test(t)) { return false; }
    if (/\d+it\/s/.test(t) || /\dit\/s\]/.test(t)) { return false; }

    return true;
  });

  // ── Pass 2: context-aware allowlist ──
  const isSignal = (t: string): boolean => {
    if (/^\[\w[\w\s]*\]/.test(t)) { return true; }      // [Init], [Vision], [Response] etc.
    if (/^={3,}|^-{10,}/.test(t)) { return true; }         // section headers/dividers
    if (/^Epoch\s+\d+\/\d+/i.test(t)) { return true; }   // Epoch X/Y
    if (/\b(loss|acc|val_acc|val_loss|train_loss|f1|precision|recall)\s*[=:]/i.test(t)) { return true; }
    if (/\b(train|val|test)\s*:\s*\d+/.test(t)) { return true; }
    if (/Class counts/i.test(t)) { return true; }
    if (/Checkpoint saved/i.test(t)) { return true; }
    if (/Model\s*:/i.test(t)) { return true; }
    if (/Device\s*:/i.test(t)) { return true; }
    if (/Batch size/i.test(t)) { return true; }
    if (/^You:\s*/.test(t)) { return true; }               // script's You: prompt
    if (/^\[input\]/.test(t)) { return true; }             // user inputs
    if (/^Image path/i.test(t)) { return true; }
    return false;
  };

  const result: string[] = [];
  let inResponseBody = false;

  for (const line of filtered) {
    const t = line.trim();

    if (!t) {
      // Empty line ends a response body block
      inResponseBody = false;
      continue;
    }

    // [Response] tag: keep it and enter response-body mode to capture following lines
    if (/^\[Response\]/i.test(t)) {
      inResponseBody = true;
      result.push(line);
      // If the response text is on the SAME line as [Response], we're done with the tag itself
      // (the text after the tag is included in `line` and already pushed)
      continue;
    }

    // Any other bracket tag resets response-body mode
    if (/^\[\w[\w\s]*\]/.test(t)) {
      inResponseBody = false;
      result.push(line);
      continue;
    }

    // Response body lines (plain prose following [Response])
    if (inResponseBody) {
      result.push(line);
      continue;
    }

    // All other signal lines
    if (isSignal(t)) {
      result.push(line);
    }
  }

  return (result.length > 0 ? result : filtered).join('\n');
}
function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);

    if (splitAt < Math.floor(maxLength * 0.5)) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function indentBlock(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join('\n');
}

function toSafeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function toTerminalText(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

function shorten(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function quoteShellArg(value: string): string {
  if (!value) {
    return '""';
  }

  if (/^[A-Za-z0-9_./:\\-]+$/.test(value)) {
    return value;
  }

  return `"${value.replaceAll('"', '\\"')}"`;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function escapeDiscordMarkdown(value: string): string {
  return value.replaceAll('@', '@\u200b');
}

function sanitizeDiscordContent(value: string): string {
  return value.replaceAll('@', '@\u200b');
}