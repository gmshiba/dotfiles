"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const child_process = require("child_process");
const fs = require("fs");
const path = require("path");
const vscode_1 = require("vscode");
const vscode_languageclient_1 = require("vscode-languageclient");
const configuration_1 = require("./configuration");
const signatureHelpProvider_1 = require("./providers/signatureHelpProvider");
const rustup_1 = require("./rustup");
const spinner_1 = require("./spinner");
const tasks_1 = require("./tasks");
const child_process_1 = require("./utils/child_process");
const observable_1 = require("./utils/observable");
const workspace_1 = require("./utils/workspace");
const wslpath_1 = require("./utils/wslpath");
function activate(context) {
    return __awaiter(this, void 0, void 0, function* () {
        context.subscriptions.push(...[
            configureLanguage(),
            ...registerCommands(),
            vscode_1.workspace.onDidChangeWorkspaceFolders(whenChangingWorkspaceFolders),
            vscode_1.window.onDidChangeActiveTextEditor(onDidChangeActiveTextEditor),
        ]);
        // Manually trigger the first event to start up server instance if necessary,
        // since VSCode doesn't do that on startup by itself.
        onDidChangeActiveTextEditor(vscode_1.window.activeTextEditor);
        // Migrate the users of multi-project setup for RLS to disable the setting
        // entirely (it's always on now)
        const config = vscode_1.workspace.getConfiguration();
        if (typeof config.get('rust-client.enableMultiProjectSetup', null) === 'boolean') {
            vscode_1.window
                .showWarningMessage('The multi-project setup for RLS is always enabled, so the `rust-client.enableMultiProjectSetup` setting is now redundant', { modal: false }, { title: 'Remove' })
                .then(value => {
                if (value && value.title === 'Remove') {
                    return config.update('rust-client.enableMultiProjectSetup', null, vscode_1.ConfigurationTarget.Global);
                }
                return;
            });
        }
    });
}
exports.activate = activate;
function deactivate() {
    return __awaiter(this, void 0, void 0, function* () {
        return Promise.all([...workspaces.values()].map(ws => ws.stop()));
    });
}
exports.deactivate = deactivate;
/** Tracks dynamically updated progress for the active client workspace for UI purposes. */
let progressObserver;
function onDidChangeActiveTextEditor(editor) {
    if (!editor || !editor.document) {
        return;
    }
    const { languageId, uri } = editor.document;
    const workspace = clientWorkspaceForUri(uri, {
        initializeIfMissing: languageId === 'rust' || languageId === 'toml',
    });
    if (!workspace) {
        return;
    }
    activeWorkspace = workspace;
    const updateProgress = (progress) => {
        if (progress.state === 'progress') {
            spinner_1.startSpinner(`[${workspace.folder.name}] ${progress.message}`);
        }
        else {
            const readySymbol = progress.state === 'standby' ? '$(debug-stop)' : '$(debug-start)';
            spinner_1.stopSpinner(`[${workspace.folder.name}] ${readySymbol}`);
        }
    };
    if (progressObserver) {
        progressObserver.dispose();
    }
    progressObserver = activeWorkspace.progress.observe(updateProgress);
    // Update UI ourselves immediately and don't wait for value update callbacks
    updateProgress(activeWorkspace.progress.value);
}
function whenChangingWorkspaceFolders(e) {
    // If a workspace is removed which is a Rust workspace, kill the client.
    for (const folder of e.removed) {
        const ws = workspaces.get(folder.uri.toString());
        if (ws) {
            workspaces.delete(folder.uri.toString());
            ws.stop();
        }
    }
}
// Don't use URI as it's unreliable the same path might not become the same URI.
const workspaces = new Map();
/**
 * Fetches a `ClientWorkspace` for a given URI. If missing and `initializeIfMissing`
 * option was provided, it is additionally initialized beforehand, if applicable.
 */
function clientWorkspaceForUri(uri, options) {
    const rootFolder = vscode_1.workspace.getWorkspaceFolder(uri);
    if (!rootFolder) {
        return;
    }
    const folder = workspace_1.nearestParentWorkspace(rootFolder, uri.fsPath);
    if (!folder) {
        return undefined;
    }
    const existing = workspaces.get(folder.uri.toString());
    if (!existing && options && options.initializeIfMissing) {
        const workspace = new ClientWorkspace(folder);
        workspaces.set(folder.uri.toString(), workspace);
        workspace.autoStart();
    }
    return workspaces.get(folder.uri.toString());
}
// We run one RLS and one corresponding language client per workspace folder
// (VSCode workspace, not Cargo workspace). This class contains all the per-client
// and per-workspace stuff.
class ClientWorkspace {
    constructor(folder) {
        this.lc = null;
        this.config = configuration_1.RLSConfiguration.loadFromWorkspace(folder.uri.fsPath);
        this.folder = folder;
        this.disposables = [];
        this._progress = new observable_1.Observable({ state: 'standby' });
    }
    get progress() {
        return this._progress;
    }
    /**
     * Attempts to start a server instance, if not configured otherwise via
     * applicable `rust-client.autoStartRls` setting.
     * @returns whether the server has started.
     */
    autoStart() {
        return __awaiter(this, void 0, void 0, function* () {
            return this.config.autoStartRls && this.start().then(() => true);
        });
    }
    start() {
        return __awaiter(this, void 0, void 0, function* () {
            this._progress.value = { state: 'progress', message: 'Starting' };
            const serverOptions = () => __awaiter(this, void 0, void 0, function* () {
                yield this.autoUpdate();
                return this.makeRlsProcess();
            });
            // This accepts `vscode.GlobPattern` under the hood, which requires only
            // forward slashes. It's worth mentioning that RelativePattern does *NOT*
            // work in remote scenarios (?), so rely on normalized fs path from VSCode URIs.
            const pattern = `${this.folder.uri.fsPath.replace(path.sep, '/')}/**`;
            const clientOptions = {
                // Register the server for Rust files
                documentSelector: [
                    { language: 'rust', scheme: 'file', pattern },
                    { language: 'rust', scheme: 'untitled', pattern },
                ],
                diagnosticCollectionName: `rust-${this.folder.uri}`,
                synchronize: { configurationSection: 'rust' },
                // Controls when to focus the channel rather than when to reveal it in the drop-down list
                revealOutputChannelOn: this.config.revealOutputChannelOn,
                initializationOptions: {
                    omitInitBuild: true,
                    cmdRun: true,
                },
                workspaceFolder: this.folder,
            };
            // Changes paths between Windows and Windows Subsystem for Linux
            if (this.config.useWSL) {
                clientOptions.uriConverters = {
                    code2Protocol: (uri) => {
                        const res = vscode_1.Uri.file(wslpath_1.uriWindowsToWsl(uri.fsPath)).toString();
                        console.log(`code2Protocol for path ${uri.fsPath} -> ${res}`);
                        return res;
                    },
                    protocol2Code: (wslUri) => {
                        const urlDecodedPath = vscode_1.Uri.parse(wslUri).path;
                        const winPath = vscode_1.Uri.file(wslpath_1.uriWslToWindows(urlDecodedPath));
                        console.log(`protocol2Code for path ${wslUri} -> ${winPath.fsPath}`);
                        return winPath;
                    },
                };
            }
            // Create the language client and start the client.
            this.lc = new vscode_languageclient_1.LanguageClient('rust-client', 'Rust Language Server', serverOptions, clientOptions);
            const selector = { language: 'rust', scheme: 'file', pattern };
            this.setupProgressCounter();
            this.disposables.push(tasks_1.activateTaskProvider(this.folder));
            this.disposables.push(this.lc.start());
            this.disposables.push(vscode_1.languages.registerSignatureHelpProvider(selector, new signatureHelpProvider_1.SignatureHelpProvider(this.lc), '(', ','));
        });
    }
    stop() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.lc) {
                yield this.lc.stop();
                this.lc = null;
                this._progress.value = { state: 'standby' };
            }
            this.disposables.forEach(d => d.dispose());
        });
    }
    restart() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.stop();
            return this.start();
        });
    }
    runRlsCommand(cmd) {
        return tasks_1.runRlsCommand(this.folder, cmd);
    }
    rustupUpdate() {
        return rustup_1.rustupUpdate(this.config.rustupConfig());
    }
    setupProgressCounter() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.lc) {
                return;
            }
            const runningProgress = new Set();
            yield this.lc.onReady();
            this.lc.onNotification(new vscode_languageclient_1.NotificationType('window/progress'), progress => {
                if (progress.done) {
                    runningProgress.delete(progress.id);
                }
                else {
                    runningProgress.add(progress.id);
                }
                if (runningProgress.size) {
                    let status = '';
                    if (typeof progress.percentage === 'number') {
                        status = `${Math.round(progress.percentage * 100)}%`;
                    }
                    else if (progress.message) {
                        status = progress.message;
                    }
                    else if (progress.title) {
                        status = `[${progress.title.toLowerCase()}]`;
                    }
                    this._progress.value = { state: 'progress', message: status };
                }
                else {
                    this._progress.value = { state: 'ready' };
                }
            });
        });
    }
    getSysroot(env) {
        return __awaiter(this, void 0, void 0, function* () {
            const wslWrapper = child_process_1.withWsl(this.config.useWSL);
            const rustcPrintSysroot = () => this.config.rustupDisabled
                ? wslWrapper.exec('rustc --print sysroot', { env })
                : wslWrapper.exec(`${this.config.rustupPath} run ${this.config.channel} rustc --print sysroot`, { env });
            const { stdout } = yield rustcPrintSysroot();
            return stdout
                .toString()
                .replace('\n', '')
                .replace('\r', '');
        });
    }
    // Make an evironment to run the RLS.
    makeRlsEnv(args = {
        setLibPath: false,
    }) {
        return __awaiter(this, void 0, void 0, function* () {
            // Shallow clone, we don't want to modify this process' $PATH or
            // $(DY)LD_LIBRARY_PATH
            const env = Object.assign({}, process.env);
            let sysroot;
            try {
                sysroot = yield this.getSysroot(env);
            }
            catch (err) {
                console.info(err.message);
                console.info(`Let's retry with extended $PATH`);
                env.PATH = `${env.HOME || '~'}/.cargo/bin:${env.PATH || ''}`;
                try {
                    sysroot = yield this.getSysroot(env);
                }
                catch (e) {
                    console.warn('Error reading sysroot (second try)', e);
                    vscode_1.window.showWarningMessage(`Error reading sysroot: ${e.message}`);
                    return env;
                }
            }
            console.info(`Setting sysroot to`, sysroot);
            if (args.setLibPath) {
                function appendEnv(envVar, newComponent) {
                    const old = process.env[envVar];
                    return old ? `${newComponent}:${old}` : newComponent;
                }
                const newComponent = path.join(sysroot, 'lib');
                env.DYLD_LIBRARY_PATH = appendEnv('DYLD_LIBRARY_PATH', newComponent);
                env.LD_LIBRARY_PATH = appendEnv('LD_LIBRARY_PATH', newComponent);
            }
            return env;
        });
    }
    makeRlsProcess() {
        return __awaiter(this, void 0, void 0, function* () {
            // Run "rls" from the PATH unless there's an override.
            const rlsPath = this.config.rlsPath || 'rls';
            // We don't need to set [DY]LD_LIBRARY_PATH if we're using rustup,
            // as rustup will set it for us when it chooses a toolchain.
            // NOTE: Needs an installed toolchain when using rustup, hence we don't call
            // it immediately here.
            const makeRlsEnv = () => this.makeRlsEnv({
                setLibPath: this.config.rustupDisabled,
            });
            const cwd = this.folder.uri.fsPath;
            let childProcess;
            if (this.config.rustupDisabled) {
                console.info(`running without rustup: ${rlsPath}`);
                const env = yield makeRlsEnv();
                childProcess = child_process.spawn(rlsPath, [], {
                    env,
                    cwd,
                    shell: true,
                });
            }
            else {
                console.info(`running with rustup: ${rlsPath}`);
                const config = this.config.rustupConfig();
                yield rustup_1.ensureToolchain(config);
                if (!this.config.rlsPath) {
                    // We only need a rustup-installed RLS if we weren't given a
                    // custom RLS path.
                    console.info('will use a rustup-installed RLS; ensuring present');
                    yield rustup_1.checkForRls(config);
                }
                const env = yield makeRlsEnv();
                childProcess = child_process_1.withWsl(config.useWSL).spawn(config.path, ['run', config.channel, rlsPath], { env, cwd, shell: true });
            }
            childProcess.on('error', (err) => {
                if (err.code === 'ENOENT') {
                    console.error(`Could not spawn RLS: ${err.message}`);
                    vscode_1.window.showWarningMessage(`Could not spawn RLS: \`${err.message}\``);
                }
            });
            if (this.config.logToFile) {
                const logPath = path.join(this.folder.uri.fsPath, `rls${Date.now()}.log`);
                const logStream = fs.createWriteStream(logPath, { flags: 'w+' });
                childProcess.stderr.pipe(logStream);
            }
            return childProcess;
        });
    }
    autoUpdate() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.config.updateOnStartup && !this.config.rustupDisabled) {
                yield rustup_1.rustupUpdate(this.config.rustupConfig());
            }
        });
    }
}
/**
 * Tracks the most current VSCode workspace as opened by the user. Used by the
 * commands to know in which workspace these should be executed.
 */
let activeWorkspace;
/**
 * Registers the VSCode [commands] used by the extension.
 *
 * [commands]: https://code.visualstudio.com/api/extension-guides/command
 */
function registerCommands() {
    return [
        vscode_1.commands.registerCommand('rls.update', () => activeWorkspace && activeWorkspace.rustupUpdate()),
        vscode_1.commands.registerCommand('rls.restart', () => __awaiter(this, void 0, void 0, function* () { return activeWorkspace && activeWorkspace.restart(); })),
        vscode_1.commands.registerCommand('rls.run', (cmd) => activeWorkspace && activeWorkspace.runRlsCommand(cmd)),
        vscode_1.commands.registerCommand('rls.start', () => activeWorkspace && activeWorkspace.start()),
        vscode_1.commands.registerCommand('rls.stop', () => activeWorkspace && activeWorkspace.stop()),
    ];
}
/**
 * Sets up additional language configuration that's impossible to do via a
 * separate language-configuration.json file. See [1] for more information.
 *
 * [1]: https://github.com/Microsoft/vscode/issues/11514#issuecomment-244707076
 */
function configureLanguage() {
    return vscode_1.languages.setLanguageConfiguration('rust', {
        onEnterRules: [
            {
                // Doc single-line comment
                // e.g. ///|
                beforeText: /^\s*\/{3}.*$/,
                action: { indentAction: vscode_1.IndentAction.None, appendText: '/// ' },
            },
            {
                // Parent doc single-line comment
                // e.g. //!|
                beforeText: /^\s*\/{2}\!.*$/,
                action: { indentAction: vscode_1.IndentAction.None, appendText: '//! ' },
            },
            {
                // Begins an auto-closed multi-line comment (standard or parent doc)
                // e.g. /** | */ or /*! | */
                beforeText: /^\s*\/\*(\*|\!)(?!\/)([^\*]|\*(?!\/))*$/,
                afterText: /^\s*\*\/$/,
                action: { indentAction: vscode_1.IndentAction.IndentOutdent, appendText: ' * ' },
            },
            {
                // Begins a multi-line comment (standard or parent doc)
                // e.g. /** ...| or /*! ...|
                beforeText: /^\s*\/\*(\*|\!)(?!\/)([^\*]|\*(?!\/))*$/,
                action: { indentAction: vscode_1.IndentAction.None, appendText: ' * ' },
            },
            {
                // Continues a multi-line comment
                // e.g.  * ...|
                beforeText: /^(\ \ )*\ \*(\ ([^\*]|\*(?!\/))*)?$/,
                action: { indentAction: vscode_1.IndentAction.None, appendText: '* ' },
            },
            {
                // Dedents after closing a multi-line comment
                // e.g.  */|
                beforeText: /^(\ \ )*\ \*\/\s*$/,
                action: { indentAction: vscode_1.IndentAction.None, removeText: 1 },
            },
        ],
    });
}
//# sourceMappingURL=extension.js.map