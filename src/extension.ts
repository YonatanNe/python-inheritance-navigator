import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { InheritanceIndexManager } from './index';
import { InheritanceCodeLensProvider } from './codelens';
import { InheritanceHoverProvider } from './hover';
import { CommandHandlers } from './commands';
import { initializeLogger, getLogger } from './utils/logger';

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
    const pythonConfig = vscode.workspace.getConfiguration('python', workspaceFolder.uri);
    
    // Try to get Python path from configuration
    let pythonPath = pythonConfig.get<string>('pythonPath') || 
                     pythonConfig.get<string>('defaultInterpreterPath');
    
    // If not configured, try local venv first
    if (!pythonPath) {
        const venvPath = path.join(workspaceRoot, '.venv', 'bin', 'python');
        if (fs.existsSync(venvPath)) {
            pythonPath = venvPath;
            logger.info('Using local venv Python', { pythonPath: venvPath });
        }
    }
    
    // If still no path, try python3 (not python, which might not exist)
    if (!pythonPath) {
        pythonPath = 'python3';
        logger.warn('No venv or config found, using python3', { workspaceRoot });
    }
    
    // If path is "python" (which doesn't exist on macOS), change to python3
    if (pythonPath === 'python') {
        logger.warn('Python path is "python", changing to "python3"', { originalPath: pythonPath });
        pythonPath = 'python3';
    }
    
    // Verify the path exists (for absolute paths)
    if (pythonPath && path.isAbsolute(pythonPath) && !fs.existsSync(pythonPath)) {
        logger.error('Configured Python path does not exist', { pythonPath });
        // Fallback to venv or python3
        const venvPath = path.join(workspaceRoot, '.venv', 'bin', 'python');
        if (fs.existsSync(venvPath)) {
            pythonPath = venvPath;
            logger.info('Falling back to venv Python', { pythonPath: venvPath });
        } else {
            pythonPath = 'python3';
            logger.warn('Falling back to python3');
        }
    }
    
    logger.info('Final Python path', { 
        pythonPath, 
        isAbsolute: path.isAbsolute(pythonPath), 
        exists: path.isAbsolute(pythonPath) ? fs.existsSync(pythonPath) : 'N/A (will check at runtime)' 
    });
    
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

    const openIndexFileCommand = vscode.commands.registerCommand(
        'pythonInheritance.openIndexFile',
        async () => {
            if (commandHandlers) {
                await commandHandlers.openIndexFile();
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
        openIndexFileCommand,
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

