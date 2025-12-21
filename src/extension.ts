import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { InheritanceIndexManager } from './index';
import { InheritanceCodeLensProvider } from './codelens';
import { InheritanceHoverProvider } from './hover';
import { CommandHandlers } from './commands';
import { initializeLogger, getLogger } from './utils/logger';
import { countGitRepos } from './utils/gitRepoDetector';
import { VenvManager } from './utils/venvManager';

let indexManager: InheritanceIndexManager | null = null;
let codeLensProvider: InheritanceCodeLensProvider | null = null;
let hoverProvider: InheritanceHoverProvider | null = null;
let commandHandlers: CommandHandlers | null = null;

export function activate(context: vscode.ExtensionContext) {
    // Read configuration
    const config = vscode.workspace.getConfiguration('pythonInheritance');
    const saveLogToFile = config.get<boolean>('saveLogToFile', false);
    const showOutputChannel = config.get<boolean>('showOutputChannel', false);
    
    // Initialize logger with configuration
    const logger = initializeLogger(saveLogToFile, showOutputChannel);
    
    // Show output channel on activation if enabled
    if (showOutputChannel) {
        logger.showOutputChannel();
    }
    logger.info('Extension activating', { extensionPath: context.extensionPath });
    
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        logger.warn('No workspace folder found');
        vscode.window.showWarningMessage('Python Inheritance Navigator requires an open workspace');
        return;
    }

    const workspaceRoot = workspaceFolder.uri.fsPath;
    const extensionConfig = vscode.workspace.getConfiguration('pythonInheritance');
    
    // Guard: disable extension entirely if workspace has multiple Git repos and setting is enabled
    const skipMultiRepo = extensionConfig.get<boolean>('skipFoldersWithMultipleGitRepos', true);
    if (skipMultiRepo) {
        const repoCount = countGitRepos(workspaceRoot, 3, 5);
        logger.info('Multi-repo guard check', { workspaceRoot, repoCount, skipMultiRepo });
        if (repoCount > 1) {
            const message = 'Python Inheritance Navigator disabled: workspace contains multiple Git repositories. Update setting "Skip folders with multiple Git repos" to enable.';
            logger.warn(message);
            vscode.window.showWarningMessage(message);
            return;
        }
    }
    
    const extensionPath = context.extensionPath;
    
    // Use VS Code's workspace storage path for persisting the index
    // Prefer globalStorageUri for workspace-specific storage
    let storagePath: string | undefined;
    if (context.globalStorageUri) {
        const extensionStoragePath = path.join(context.globalStorageUri.fsPath, 'python-inheritance-navigator');
        if (!fs.existsSync(extensionStoragePath)) {
            fs.mkdirSync(extensionStoragePath, { recursive: true });
        }
        storagePath = extensionStoragePath;
    } else if (context.storagePath) {
        storagePath = context.storagePath;
    }

    if (!storagePath) {
        logger.error('No storage path available');
        vscode.window.showErrorMessage('Python Inheritance Navigator: Unable to initialize storage path');
        return;
    }

    // Initialize venv manager and ensure venv is set up (async initialization)
    (async () => {
        const venvManager = new VenvManager(storagePath, extensionPath);
        let pythonPath: string;
        
        try {
            pythonPath = await venvManager.ensureVenv();
            logger.info('Using extension-managed venv', { pythonPath });
        } catch (error) {
            logger.error('Failed to setup extension venv', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to initialize Python Inheritance Navigator: ${errorMessage}`);
            return;
        }

        logger.info('Initializing components', { workspaceRoot, pythonPath, extensionPath, storagePath });

        indexManager = new InheritanceIndexManager(workspaceRoot, pythonPath, extensionPath, storagePath);
        codeLensProvider = new InheritanceCodeLensProvider(indexManager);
        hoverProvider = new InheritanceHoverProvider(indexManager);
        commandHandlers = new CommandHandlers(indexManager);
        
        // Refresh CodeLens when index is updated
        indexManager.onIndexUpdated(() => {
            if (codeLensProvider) {
                codeLensProvider.refresh();
            }
        });

        const codeLensDisposable = vscode.languages.registerCodeLensProvider(
            { language: 'python' },
            codeLensProvider
        );

        const hoverDisposable = vscode.languages.registerHoverProvider(
            { language: 'python' },
            hoverProvider
        );

        const goToBaseCommand = vscode.commands.registerCommand(
            'pythonInheritance.goToBase',
            async (method: unknown) => {
                if (commandHandlers) {
                    await commandHandlers.goToBaseMethod(method as {
                        file_path: string;
                        line: number;
                        column: number;
                        end_line: number;
                        end_column: number;
                        class_name: string;
                        name: string;
                    });
                }
            }
        );

        const goToOverridesCommand = vscode.commands.registerCommand(
            'pythonInheritance.goToOverrides',
            async (overrideMethods: unknown) => {
                if (commandHandlers) {
                    await commandHandlers.goToOverrides(overrideMethods as Array<{
                        file_path: string;
                        line: number;
                        column: number;
                        end_line: number;
                        end_column: number;
                        class_name: string;
                        name: string;
                    }>);
                }
            }
        );

        const refreshIndexCommand = vscode.commands.registerCommand(
            'pythonInheritance.refreshIndex',
            async () => {
                if (commandHandlers) {
                    await commandHandlers.refreshIndex();
                    if (codeLensProvider) {
                        codeLensProvider.refresh();
                    }
                }
            }
        );

        const cleanAndReindexCommand = vscode.commands.registerCommand(
            'pythonInheritance.cleanAndReindex',
            async () => {
                if (commandHandlers) {
                    await commandHandlers.cleanAndReindex();
                    if (codeLensProvider) {
                        codeLensProvider.refresh();
                    }
                }
            }
        );

        const openIndexFileCommand = vscode.commands.registerCommand(
            'pythonInheritance.openIndexFile',
            async () => {
                if (commandHandlers) {
                    await commandHandlers.openIndexFile();
                }
            }
        );

        const clearAllIndexesCommand = vscode.commands.registerCommand(
            'pythonInheritance.clearAllIndexes',
            async () => {
                if (commandHandlers) {
                    await commandHandlers.clearAllIndexes();
                    if (codeLensProvider) {
                        codeLensProvider.refresh();
                    }
                }
            }
        );

        const navigateToLocationCommand = vscode.commands.registerCommand(
            'pythonInheritance.navigateToLocation',
            async (filePath: string, line: number, column: number) => {
                if (commandHandlers) {
                    await commandHandlers.navigateToLocation(filePath, line, column);
                }
            }
        );

        context.subscriptions.push(
            codeLensDisposable,
            hoverDisposable,
            goToBaseCommand,
            goToOverridesCommand,
            refreshIndexCommand,
            cleanAndReindexCommand,
            openIndexFileCommand,
            clearAllIndexesCommand,
            navigateToLocationCommand
        );

        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('pythonInheritance')) {
                // Handle logger configuration changes
                if (e.affectsConfiguration('pythonInheritance.saveLogToFile') || 
                    e.affectsConfiguration('pythonInheritance.showOutputChannel')) {
                    const newConfig = vscode.workspace.getConfiguration('pythonInheritance');
                    const newSaveLogToFile = newConfig.get<boolean>('saveLogToFile', false);
                    const newShowOutputChannel = newConfig.get<boolean>('showOutputChannel', false);
                    // Update logger with new settings
                    const updatedLogger = initializeLogger(newSaveLogToFile, newShowOutputChannel);
                    updatedLogger.info('Logger configuration updated', { 
                        saveLogToFile: newSaveLogToFile, 
                        showOutputChannel: newShowOutputChannel 
                    });
                }
                
                if (codeLensProvider) {
                    codeLensProvider.refresh();
                }
            }
        });

        // Initialize index (progress bar is shown inside initialize())
        indexManager.initialize().then(() => {
            logger.info('Index initialization completed successfully');
            // Refresh CodeLens after a short delay to ensure index is fully ready
            setTimeout(() => {
                if (codeLensProvider) {
                    codeLensProvider.refresh();
                    logger.info('CodeLens refreshed after indexing');
                }
            }, 500);
            // Don't show info message - progress notification already shows completion
        }).catch((error) => {
            logger.error('Failed to initialize index', error);
            console.error('Failed to initialize index:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to initialize Python Inheritance Navigator: ${errorMessage}`);
        });
    })();
}

export function deactivate() {
    const logger = getLogger();
    logger.info('Extension deactivating');
    if (indexManager) {
        indexManager.dispose();
        indexManager = null;
    }
    codeLensProvider = null;
    hoverProvider = null;
    commandHandlers = null;
    logger.dispose();
}

