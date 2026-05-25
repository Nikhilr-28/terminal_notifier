import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const VIEW_ID = 'terminalNotifier.view';

const CHANNEL_SECRET_KEY = 'terminalNotifier.channel';
const TELEGRAM_BOT_TOKEN_KEY = 'terminalNotifier.telegramBotToken';
const TELEGRAM_CHAT_ID_KEY = 'terminalNotifier.telegramChatId';
const DISCORD_WEBHOOK_URL_KEY = 'terminalNotifier.discordWebhookUrl';

const COMMAND_HISTORY_KEY = 'terminalNotifier.commandHistory';
const COMMAND_HISTORY_LIMIT = 30;

const TELEGRAM_MESSAGE_LIMIT = 3500;
const DISCORD_MESSAGE_LIMIT = 1900;

type NotifyMode = 'Full Terminal' | 'Final Output';
type NotificationChannel = 'telegram' | 'discord';

interface ChannelConfig {
  channel: NotificationChannel;
  telegramBotToken?: string;
  telegramChatId?: string;
  discordWebhookUrl?: string;
}

interface RunOptions {
  command: string;
  cwd: string;
  mode: NotifyMode;
  channelConfig: ChannelConfig;
  logPath: string;
  payloadPath: string;
  finalOutputLineCount: number;
  maxNotificationCharacters: number;
}

interface RunResultBase {
  command: string;
  cwd: string;
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

export function activate(context: vscode.ExtensionContext) {
  const provider = new NotifierViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider)
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
          await saveChannelConfig(this.context, channelConfig);

          await webviewView.webview.postMessage({
            type: 'status',
            level: 'success',
            text: `Saved ${channelLabel(channelConfig.channel)} settings.`
          });

          return;
        }

        if (message.type === 'clearConfig') {
          await this.context.secrets.delete(CHANNEL_SECRET_KEY);
          await this.context.secrets.delete(TELEGRAM_BOT_TOKEN_KEY);
          await this.context.secrets.delete(TELEGRAM_CHAT_ID_KEY);
          await this.context.secrets.delete(DISCORD_WEBHOOK_URL_KEY);
          await this.context.workspaceState.update(COMMAND_HISTORY_KEY, []);

          await this.render(webviewView);

          await webviewView.webview.postMessage({
            type: 'status',
            level: 'success',
            text: 'Settings and command history cleared.'
          });

          return;
        }

        if (message.type === 'fetchTelegramUpdates') {
          const botToken = String(message.telegramBotToken ?? '').trim();

          if (!botToken) {
            await webviewView.webview.postMessage({
              type: 'status',
              level: 'error',
              text: 'Paste your Telegram bot token first. Then message your bot once.'
            });
            return;
          }

          const updates = await fetchTelegramUpdates(botToken);

          await webviewView.webview.postMessage({
            type: 'telegramUpdates',
            updates
          });

          await webviewView.webview.postMessage({
            type: 'status',
            level: updates.length > 0 ? 'success' : 'info',
            text: updates.length > 0
              ? `Found ${updates.length} Telegram update(s). Click one to fill Chat ID.`
              : 'No updates found. Send "hello" to your Telegram bot, then try again.'
          });

          return;
        }

        if (message.type === 'testNotification') {
          const channelConfig = buildChannelConfigFromMessage(message);

          const validationError = validateChannelConfig(channelConfig);
          if (validationError) {
            await webviewView.webview.postMessage({
              type: 'status',
              level: 'error',
              text: validationError
            });
            return;
          }

          await saveChannelConfig(this.context, channelConfig);

          const testText = buildTestNotificationText(channelConfig);
          await sendDirectNotification(channelConfig, '[Terminal Notifier] Test notification', testText);

          await webviewView.webview.postMessage({
            type: 'status',
            level: 'success',
            text: `${channelLabel(channelConfig.channel)} test notification sent.`
          });

          return;
        }

        if (message.type === 'openLogsFolder') {
          const logsDir = getLogsDirectory(this.context);
          fs.mkdirSync(logsDir, { recursive: true });
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(logsDir));
          return;
        }

        if (message.type === 'run') {
          const command = String(message.command ?? '').trim();
          const mode = message.mode === 'Full Terminal' ? 'Full Terminal' : 'Final Output';
          const channelConfig = buildChannelConfigFromMessage(message);

          if (!command) {
            await webviewView.webview.postMessage({
              type: 'status',
              level: 'error',
              text: 'Command cannot be empty.'
            });
            return;
          }

          const validationError = validateChannelConfig(channelConfig);
          if (validationError) {
            await webviewView.webview.postMessage({
              type: 'status',
              level: 'error',
              text: validationError
            });
            return;
          }

          await saveChannelConfig(this.context, channelConfig);
          await rememberCommand(this.context, command);

          await webviewView.webview.postMessage({
            type: 'status',
            level: 'info',
            text: `Starting command. Channel: ${channelLabel(channelConfig.channel)}.`
          });

          await startNotifyTerminal(this.context, {
            command,
            mode,
            channelConfig
          });

          return;
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);

        await webviewView.webview.postMessage({
          type: 'status',
          level: 'error',
          text
        });
      }
    });
  }

  private async render(webviewView: vscode.WebviewView): Promise<void> {
    const channel = normalizeChannel(await this.context.secrets.get(CHANNEL_SECRET_KEY));
    const telegramBotToken = await this.context.secrets.get(TELEGRAM_BOT_TOKEN_KEY);
    const telegramChatId = await this.context.secrets.get(TELEGRAM_CHAT_ID_KEY);
    const discordWebhookUrl = await this.context.secrets.get(DISCORD_WEBHOOK_URL_KEY);
    const commandHistory = getCommandHistory(this.context);

    const config = vscode.workspace.getConfiguration('terminalNotifier');

    webviewView.webview.html = getWebviewHtml({
      channel,
      telegramBotToken: telegramBotToken ?? '',
      telegramChatId: telegramChatId ?? '',
      discordWebhookUrl: discordWebhookUrl ?? '',
      defaultMode: config.get<NotifyMode>('defaultMode', 'Final Output'),
      finalOutputLineCount: config.get<number>('finalOutputLineCount', 80),
      commandHistory
    });
  }
}

async function runAndNotifyPrompt(context: vscode.ExtensionContext): Promise<void> {
  const channelConfig = await getSavedChannelConfig(context);
  const validationError = validateChannelConfig(channelConfig);

  if (validationError) {
    await vscode.commands.executeCommand('workbench.view.extension.terminalNotifierPanel');
    vscode.window.showWarningMessage(`Configure Notifier first: ${validationError}`);
    return;
  }

  const command = await vscode.window.showInputBox({
    title: 'Terminal Notifier',
    prompt: `Command to run. Channel: ${channelLabel(channelConfig.channel)}.`,
    placeHolder: 'python train.py --epochs 20',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value.trim()) {
        return 'Command cannot be empty.';
      }
      return undefined;
    }
  });

  if (!command) {
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

  await rememberCommand(context, command);

  await startNotifyTerminal(context, {
    command,
    mode: modePick.value,
    channelConfig
  });
}

async function startNotifyTerminal(
  context: vscode.ExtensionContext,
  input: {
    command: string;
    mode: NotifyMode;
    channelConfig: ChannelConfig;
  }
): Promise<void> {
  const config = vscode.workspace.getConfiguration('terminalNotifier');

  const finalOutputLineCount = config.get<number>('finalOutputLineCount', 80);
  const maxNotificationCharacters = config.get<number>('maxNotificationCharacters', 12000);

  const cwd = getWorkingDirectory();
  const logsDir = getLogsDirectory(context);
  fs.mkdirSync(logsDir, { recursive: true });

  const timestamp = toSafeTimestamp(new Date());
  const logPath = path.join(logsDir, `run-${timestamp}.log`);
  const payloadPath = path.join(logsDir, `payload-${timestamp}.json`);

  const pty = new NotifyRunPseudoterminal({
    command: input.command,
    cwd,
    mode: input.mode,
    channelConfig: input.channelConfig,
    logPath,
    payloadPath,
    finalOutputLineCount,
    maxNotificationCharacters
  });

  const terminal = vscode.window.createTerminal({
    name: `Notify: ${shorten(input.command, 28)}`,
    pty
  });

  terminal.show();

  vscode.window.showInformationMessage(
    `Notifier started. Channel: ${channelLabel(input.channelConfig.channel)}.`
  );
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
      this.child.kill();
    }
  }

  handleInput(data: string): void {
    if (data === '\x03') {
      this.writeLine('');
      this.writeLine('[Notifier] Ctrl+C received. Stopping process...');
      if (this.child && !this.child.killed) {
        this.child.kill();
      }
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
          PYTHONUNBUFFERED: '1'
        }
      });

      this.child.stdout.on('data', (chunk: Buffer) => {
        this.handleChunk(chunk.toString());
      });

      this.child.stderr.on('data', (chunk: Buffer) => {
        this.hadStderr = true;
        this.handleChunk(chunk.toString());
      });

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
      `Channel: ${channelLabel(this.options.channelConfig.channel)} | Mode: ${this.options.mode}`,
      `Log: ${this.options.logPath}`,
      '',
      'Running command...',
      '────────────────────────────────────────'
    ].join('\n');

    this.writeLineBlock(header);
    this.writeToLog(`${header}\n`);
  }

  private handleChunk(text: string): void {
    this.writeRaw(text);
    this.writeToLog(text);
    this.recordFinalLines(text);
  }

  private recordFinalLines(text: string): void {
    const combined = this.partialLine + text;
    const parts = combined.split(/\r?\n/);

    this.partialLine = parts.pop() ?? '';

    for (const line of parts) {
      if (line.trim().length === 0) {
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

  private async finalize(
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    if (this.finalized) {
      return;
    }

    this.finalized = true;
    this.flushPartialLine();

    const endTime = new Date();
    const durationMs = endTime.getTime() - this.startTime.getTime();

    const resultBase: RunResultBase = {
      command: this.options.command,
      cwd: this.options.cwd,
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
      ? result.finalLines.join('\n')
      : commandOnlyOutput;

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
    command: result.command,
    cwd: result.cwd,
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
      command: result.command,
      cwd: result.cwd,
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
  mode: NotifyMode;
  duration: string;
  exitCode: number | null;
  output: string;
  truncated: boolean;
}): string {
  const statusIcon = args.exitCode === 0 ? '✅' : '❌';

  return [
    `🔔 ${statusIcon} ${args.status} | ${args.duration} | exit ${args.exitCode}`,
    '',
    'Command:',
    indentBlock(args.command),
    '',
    'Run:',
    indentBlock([
      `Working dir: ${args.cwd}`,
      `Mode: ${args.mode}`,
      `Duration: ${args.duration}`,
      `Exit code: ${args.exitCode}`
    ].join('\n')),
    '',
    'Output:',
    indentBlock(args.output),
    args.truncated ? '\nNote: Output was truncated. Full log is saved locally.' : undefined
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function buildTestNotificationText(channelConfig: ChannelConfig): string {
  return [
    `🔔 ✅ Test notification | ${channelLabel(channelConfig.channel)}`,
    '',
    'Channel:',
    indentBlock(channelLabel(channelConfig.channel)),
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
    `Command: ${result.command}`,
    `Working directory: ${result.cwd}`,
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
}): string {
  const telegramChecked = state.channel === 'telegram' ? 'checked' : '';
  const discordChecked = state.channel === 'discord' ? 'checked' : '';
  const finalChecked = state.defaultMode === 'Final Output' ? 'checked' : '';
  const fullChecked = state.defaultMode === 'Full Terminal' ? 'checked' : '';

  const escapedTelegramBotToken = escapeHtml(state.telegramBotToken);
  const escapedTelegramChatId = escapeHtml(state.telegramChatId);
  const escapedDiscordWebhookUrl = escapeHtml(state.discordWebhookUrl);
  const commandHistoryJson = safeJsonForHtml(state.commandHistory);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 12px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-size: 13px;
    }

    .wrap {
      max-width: 980px;
      margin: 0 auto;
    }

    .top {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }

    .icon {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      flex: 0 0 auto;
    }

    h1 {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
    }

    .grid {
      display: grid;
      grid-template-columns: minmax(280px, 330px) 1fr;
      gap: 10px;
      align-items: start;
    }

    .card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      background: var(--vscode-sideBar-background);
      padding: 10px;
    }

    .section-title {
      margin: 0 0 8px;
      font-size: 11px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      opacity: 0.75;
      font-weight: 700;
    }

    .channels {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 10px;
    }

    .channel-card {
      display: flex;
      gap: 7px;
      align-items: center;
      padding: 9px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 9px;
      cursor: pointer;
      background: var(--vscode-editor-background);
      min-height: 42px;
    }

    .channel-card.active {
      border-color: var(--vscode-focusBorder);
      outline: 1px solid var(--vscode-focusBorder);
    }

    .channel-card input {
      margin: 0;
      width: auto;
    }

    .channel-name {
      font-weight: 700;
      font-size: 13px;
    }

    .channel-note {
      font-size: 11px;
      opacity: 0.65;
      margin-top: 1px;
    }

    label {
      display: block;
      margin: 8px 0 4px;
      font-size: 12px;
      opacity: 0.86;
    }

    .label-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin: 8px 0 4px;
    }

    .label-row label {
      margin: 0;
    }

    .history-actions {
      display: flex;
      gap: 6px;
    }

    input, textarea {
      width: 100%;
      border: 1px solid var(--vscode-input-border);
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border-radius: 8px;
      padding: 8px 9px;
      font: inherit;
      outline: none;
    }

    textarea {
      min-height: 92px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family);
      line-height: 1.4;
    }

    .row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 7px;
    }

    .panel {
      display: none;
    }

    .panel.active {
      display: block;
    }

    .mode-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin: 4px 0 8px;
    }

    .radio {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
    }

    .radio input {
      width: auto;
    }

    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 10px;
    }

    button {
      border: 1px solid transparent;
      border-radius: 8px;
      padding: 8px 11px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
      font: inherit;
      font-weight: 600;
    }

    button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    button.ghost {
      background: transparent;
      color: var(--vscode-foreground);
      border-color: var(--vscode-panel-border);
    }

    button.small {
      padding: 4px 7px;
      font-size: 11px;
      border-radius: 6px;
    }

    .hint {
      font-size: 11px;
      opacity: 0.68;
      line-height: 1.35;
      margin-top: 6px;
    }

    .status {
      margin-top: 10px;
      padding: 9px 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 9px;
      display: none;
      white-space: pre-wrap;
      line-height: 1.35;
    }

    .status.show { display: block; }
    .status.success { border-color: var(--vscode-testing-iconPassed); }
    .status.error { border-color: var(--vscode-testing-iconFailed); }
    .status.info { border-color: var(--vscode-focusBorder); }

    .updates {
      display: none;
      margin-top: 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      overflow: hidden;
      max-height: 150px;
      overflow-y: auto;
    }

    .updates.show { display: block; }

    .update-row {
      padding: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      cursor: pointer;
      font-size: 12px;
    }

    .update-row:last-child { border-bottom: 0; }

    .update-row:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .muted {
      opacity: 0.65;
    }

    @media (max-width: 780px) {
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="icon">🔔</div>
      <h1>Terminal Notifier</h1>
    </div>

    <div class="grid">
      <div class="card">
        <div class="section-title">Channel</div>

        <div class="channels">
          <label class="channel-card" data-channel-card="telegram">
            <input type="radio" name="channel" value="telegram" ${telegramChecked} />
            <div>
              <div class="channel-name">Telegram</div>
              <div class="channel-note">Phone alerts</div>
            </div>
          </label>

          <label class="channel-card" data-channel-card="discord">
            <input type="radio" name="channel" value="discord" ${discordChecked} />
            <div>
              <div class="channel-name">Discord</div>
              <div class="channel-note">Webhook</div>
            </div>
          </label>
        </div>

        <div id="telegramPanel" class="panel">
          <label for="telegramBotToken">Bot token</label>
          <div class="row">
            <input id="telegramBotToken" type="password" value="${escapedTelegramBotToken}" placeholder="1234567890:AA..." />
            <button id="toggleToken" class="ghost" type="button">Show</button>
          </div>

          <label for="telegramChatId">Chat ID</label>
          <input id="telegramChatId" value="${escapedTelegramChatId}" placeholder="1288248328" />

          <div class="actions">
            <button id="fetchTelegramUpdates" class="secondary">Fetch Chat ID</button>
            <button id="testTelegram" class="secondary">Test</button>
          </div>

          <div class="hint">Message your bot once, then fetch Chat ID.</div>
          <div id="updates" class="updates"></div>
        </div>

        <div id="discordPanel" class="panel">
          <label for="discordWebhookUrl">Webhook URL</label>
          <input id="discordWebhookUrl" type="password" value="${escapedDiscordWebhookUrl}" placeholder="https://discord.com/api/webhooks/..." />

          <div class="actions">
            <button id="testDiscord" class="secondary">Test</button>
          </div>

          <div class="hint">Paste a Discord channel webhook URL.</div>
        </div>

        <div class="actions">
          <button id="saveConfig">Save</button>
          <button id="clearConfig" class="secondary">Clear</button>
        </div>
      </div>

      <div class="card">
        <div class="section-title">Run</div>

        <label>Output mode</label>
        <div class="mode-row">
          <label class="radio">
            <input type="radio" name="mode" value="Final Output" ${finalChecked} />
            Final Output
          </label>
          <label class="radio">
            <input type="radio" name="mode" value="Full Terminal" ${fullChecked} />
            Full Terminal
          </label>
        </div>

        <div class="label-row">
          <label for="command">Command</label>
          <div class="history-actions">
            <button id="prevCommand" class="ghost small" type="button">↑ Prev</button>
            <button id="nextCommand" class="ghost small" type="button">↓ Next</button>
          </div>
        </div>
        <textarea id="command" placeholder="python train.py --epochs 20"></textarea>

        <div class="actions">
          <button id="run">🔔 Run + Notify</button>
          <button id="openLogs" class="secondary">Logs</button>
        </div>

        <div class="hint">
          Final Output sends the last ${state.finalOutputLineCount} lines. Use Ctrl+↑ / Ctrl+↓ to browse saved commands.
        </div>

        <div id="status" class="status"></div>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    let commandHistory = ${commandHistoryJson};
    let historyCursor = -1;
    let draftCommand = '';

    const statusEl = document.getElementById('status');
    const updatesEl = document.getElementById('updates');

    const telegramPanel = document.getElementById('telegramPanel');
    const discordPanel = document.getElementById('discordPanel');

    const telegramBotToken = document.getElementById('telegramBotToken');
    const telegramChatId = document.getElementById('telegramChatId');
    const discordWebhookUrl = document.getElementById('discordWebhookUrl');
    const command = document.getElementById('command');

    function getChannel() {
      const selected = document.querySelector('input[name="channel"]:checked');
      return selected ? selected.value : 'telegram';
    }

    function getMode() {
      const selected = document.querySelector('input[name="mode"]:checked');
      return selected ? selected.value : 'Final Output';
    }

    function payload(type) {
      return {
        type,
        channel: getChannel(),
        telegramBotToken: telegramBotToken.value,
        telegramChatId: telegramChatId.value,
        discordWebhookUrl: discordWebhookUrl.value
      };
    }

    function showStatus(level, text) {
      statusEl.className = 'status show ' + level;
      statusEl.textContent = text;
    }

    function updatePanels() {
      const channel = getChannel();

      telegramPanel.classList.toggle('active', channel === 'telegram');
      discordPanel.classList.toggle('active', channel === 'discord');

      document.querySelectorAll('[data-channel-card]').forEach(card => {
        card.classList.toggle('active', card.dataset.channelCard === channel);
      });
    }

    function addCommandToLocalHistory(value) {
      const trimmed = value.trim();

      if (!trimmed) {
        return;
      }

      commandHistory = [
        trimmed,
        ...commandHistory.filter(item => item !== trimmed)
      ].slice(0, 30);

      historyCursor = -1;
      draftCommand = '';
    }

    function recallCommand(direction) {
      if (!commandHistory.length) {
        showStatus('info', 'No saved commands yet.');
        return;
      }

      if (historyCursor === -1) {
        draftCommand = command.value;
      }

      if (direction < 0) {
        if (historyCursor < commandHistory.length - 1) {
          historyCursor += 1;
        }
      } else {
        if (historyCursor > 0) {
          historyCursor -= 1;
        } else {
          historyCursor = -1;
          command.value = draftCommand;
          command.focus();
          command.setSelectionRange(command.value.length, command.value.length);
          return;
        }
      }

      command.value = commandHistory[historyCursor] || '';
      command.focus();
      command.setSelectionRange(command.value.length, command.value.length);
    }

    document.querySelectorAll('input[name="channel"]').forEach(input => {
      input.addEventListener('change', updatePanels);
    });

    document.getElementById('toggleToken').addEventListener('click', () => {
      const show = telegramBotToken.type === 'password';
      telegramBotToken.type = show ? 'text' : 'password';
      document.getElementById('toggleToken').textContent = show ? 'Hide' : 'Show';
    });

    document.getElementById('saveConfig').addEventListener('click', () => {
      vscode.postMessage(payload('saveConfig'));
    });

    document.getElementById('clearConfig').addEventListener('click', () => {
      commandHistory = [];
      historyCursor = -1;
      draftCommand = '';
      vscode.postMessage({ type: 'clearConfig' });
    });

    document.getElementById('fetchTelegramUpdates').addEventListener('click', () => {
      showStatus('info', 'Fetching Telegram updates...');
      vscode.postMessage(payload('fetchTelegramUpdates'));
    });

    document.getElementById('testTelegram').addEventListener('click', () => {
      showStatus('info', 'Sending Telegram test...');
      vscode.postMessage({
        ...payload('testNotification'),
        channel: 'telegram'
      });
    });

    document.getElementById('testDiscord').addEventListener('click', () => {
      showStatus('info', 'Sending Discord test...');
      vscode.postMessage({
        ...payload('testNotification'),
        channel: 'discord'
      });
    });

    document.getElementById('openLogs').addEventListener('click', () => {
      vscode.postMessage({ type: 'openLogsFolder' });
    });

    document.getElementById('prevCommand').addEventListener('click', () => {
      recallCommand(-1);
    });

    document.getElementById('nextCommand').addEventListener('click', () => {
      recallCommand(1);
    });

    command.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.altKey) && event.key === 'ArrowUp') {
        event.preventDefault();
        recallCommand(-1);
      }

      if ((event.ctrlKey || event.altKey) && event.key === 'ArrowDown') {
        event.preventDefault();
        recallCommand(1);
      }
    });

    command.addEventListener('input', () => {
      historyCursor = -1;
    });

    document.getElementById('run').addEventListener('click', () => {
      addCommandToLocalHistory(command.value);

      vscode.postMessage({
        ...payload('run'),
        command: command.value,
        mode: getMode()
      });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;

      if (message.type === 'status') {
        showStatus(message.level || 'info', message.text || '');
      }

      if (message.type === 'telegramUpdates') {
        renderTelegramUpdates(message.updates || []);
      }
    });

    function renderTelegramUpdates(updates) {
      updatesEl.innerHTML = '';

      if (!updates.length) {
        updatesEl.className = 'updates';
        return;
      }

      updatesEl.className = 'updates show';

      updates.forEach(update => {
        const row = document.createElement('div');
        row.className = 'update-row';

        const chatId = update.chat_id || '';
        const name = update.first_name || update.username || update.chat_title || 'Telegram chat';
        const text = update.text || '';

        row.innerHTML =
          '<strong>Chat ID:</strong> ' + escapeHtml(String(chatId)) +
          '<br/><span class="muted">' + escapeHtml(String(name)) +
          (text ? ' · "' + escapeHtml(String(text)) + '"' : '') +
          '</span>';

        row.addEventListener('click', () => {
          telegramChatId.value = String(chatId);
          showStatus('success', 'Filled Chat ID: ' + chatId);
        });

        updatesEl.appendChild(row);
      });
    }

    function escapeHtml(value) {
      return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    }

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

async function getSavedChannelConfig(context: vscode.ExtensionContext): Promise<ChannelConfig> {
  return {
    channel: normalizeChannel(await context.secrets.get(CHANNEL_SECRET_KEY)),
    telegramBotToken: await context.secrets.get(TELEGRAM_BOT_TOKEN_KEY),
    telegramChatId: await context.secrets.get(TELEGRAM_CHAT_ID_KEY),
    discordWebhookUrl: await context.secrets.get(DISCORD_WEBHOOK_URL_KEY)
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

    if (!config.discordWebhookUrl.startsWith('https://discord.com/api/webhooks/')) {
      return 'Discord webhook URL should start with https://discord.com/api/webhooks/.';
    }
  }

  return undefined;
}

function normalizeChannel(value: unknown): NotificationChannel {
  return value === 'discord' ? 'discord' : 'telegram';
}

function channelLabel(channel: NotificationChannel): string {
  return channel === 'discord' ? 'Discord' : 'Telegram';
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

function getWorkingDirectory(): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  return workspaceFolder?.uri.fsPath ?? os.homedir();
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