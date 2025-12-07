import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PythonClient } from './analysis/pythonClient';
import { InheritanceIndex, MethodRelationship, FileInheritanceData } from './analysis/types';
import { FileWatcher } from './utils/fileWatcher';
import { logger } from './utils/logger';
import { countGitRepos } from './utils/gitRepoDetector';

export class InheritanceIndexManager {
    private index: InheritanceIndex = {};
    private pythonClient: PythonClient;
    private fileWatcher: FileWatcher | null = null;
    private _isIndexing = false;
    private indexingPromise: Promise<void> | null = null;
    private onIndexUpdatedEmitter: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onIndexUpdated: vscode.Event<void> = this.onIndexUpdatedEmitter.event;
    private indexingStats: { totalScanned?: number; filesWithInheritance?: number } = {};
    private storagePath: string | null = null;
    private indexFilePath: string | null = null;
    private workspaceRoot: string;

    isIndexing(): boolean {
        return this._isIndexing;
    }

    constructor(workspaceRoot: string, pythonPath = 'python3', extensionPath?: string, storagePath?: string) {
        this.workspaceRoot = workspaceRoot;
        this.pythonClient = new PythonClient(workspaceRoot, pythonPath, extensionPath);
        if (storagePath) {
            this.storagePath = storagePath;
            // Create storage directory if it doesn't exist
            if (!fs.existsSync(storagePath)) {
                fs.mkdirSync(storagePath, { recursive: true });
            }
            // Use workspace-relative path for index file name
            const workspaceHash = this._getWorkspaceHash(workspaceRoot);
            this.indexFilePath = path.join(storagePath, `inheritance-index-${workspaceHash}.json`);
        }
    }
    
    private _getWorkspaceHash(workspaceRoot: string): string {
        // Create a simple hash from workspace path for file naming
        let hash = 0;
        for (let i = 0; i < workspaceRoot.length; i++) {
            const char = workspaceRoot.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(36);
    }

    private async _shouldSkipForMultipleGitRepos(): Promise<boolean> {
        const config = vscode.workspace.getConfiguration('pythonInheritance');
        const skipEnabled = config.get<boolean>('skipFoldersWithMultipleGitRepos', true);
        if (!skipEnabled) {
            logger.debug('Skipping multi-repo guard because setting is disabled');
            return false;
        }
        const repoCount = countGitRepos(this.workspaceRoot, 3, 5);
        logger.info('Detected Git repositories in workspace', { workspaceRoot: this.workspaceRoot, repoCount });
        return repoCount > 1;
    }
    
    async loadIndexFromFile(): Promise<boolean> {
        if (!this.indexFilePath || !fs.existsSync(this.indexFilePath)) {
            logger.debug('No saved index file found');
            return false;
        }
        
        try {
            const indexData = fs.readFileSync(this.indexFilePath, 'utf-8');
            const parsed = JSON.parse(indexData);
            
            // Validate the index structure
            if (parsed && typeof parsed === 'object') {
                // Check if it has a version/timestamp to validate freshness
                if (parsed.version && parsed.index) {
                    this.index = parsed.index;
                    logger.info('Loaded index from file', { 
                        fileCount: Object.keys(this.index).length,
                        version: parsed.version,
                        timestamp: parsed.timestamp,
                        indexFilePath: this.indexFilePath
                    });
                    logger.info(`Index file location: ${this.indexFilePath}`);
                    logger.info(`To view in terminal: open "${this.indexFilePath}"`);
                    logger.info(`To view in VS Code: Run command "Python Inheritance Navigator: Open Index File"`);
                    return true;
                } else if (Object.keys(parsed).length > 0) {
                    // Legacy format - assume it's the index directly
                    this.index = parsed;
                    logger.info('Loaded index from file (legacy format)', { 
                        fileCount: Object.keys(this.index).length,
                        indexFilePath: this.indexFilePath
                    });
                    logger.info(`Index file location: ${this.indexFilePath}`);
                    logger.info(`To view in terminal: open "${this.indexFilePath}"`);
                    logger.info(`To view in VS Code: Run command "Python Inheritance Navigator: Open Index File"`);
                    return true;
                }
            }
        } catch (error) {
            logger.error('Failed to load index from file', { error, filePath: this.indexFilePath });
        }
        
        return false;
    }
    
    private _saveIndexToFile(): void {
        if (!this.indexFilePath) {
            return;
        }
        
        try {
            const indexData = {
                version: '1.0',
                timestamp: new Date().toISOString(),
                workspaceRoot: this.workspaceRoot,
                index: this.index
            };
            
            fs.writeFileSync(this.indexFilePath, JSON.stringify(indexData, null, 2), 'utf-8');
            logger.debug('Saved index to file', { 
                filePath: this.indexFilePath,
                fileCount: Object.keys(this.index).length 
            });
            logger.info(`Index saved to: ${this.indexFilePath}`);
            logger.info(`To view in terminal: open "${this.indexFilePath}"`);
            logger.info(`To view in VS Code: Run command "Python Inheritance Navigator: Open Index File"`);
        } catch (error) {
            logger.error('Failed to save index to file', { error, filePath: this.indexFilePath });
        }
    }
    
    getIndexFilePath(): string | null {
        return this.indexFilePath;
    }

    async initialize(): Promise<void> {
        logger.info('Initializing inheritance index manager');
        
        // Try to load index from file first
        const loaded = await this.loadIndexFromFile();
        if (loaded) {
            logger.info('Index loaded from cache, setting up file watcher');
            this._setupFileWatcher();
            // Still trigger a background refresh to ensure index is up to date
            this._refreshIndexInBackground();
            return;
        }
        
        const config = vscode.workspace.getConfiguration('pythonInheritance');
        const indexingScope = config.get<string>('indexingScope', 'workspace');

        if (this._isIndexing && this.indexingPromise) {
            logger.debug('Indexing already in progress, waiting...');
            return this.indexingPromise;
        }

        this._isIndexing = true;
        
        // Show progress notification
        this.indexingPromise = vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Python Inheritance Navigator',
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: 'Starting indexing...' });
            
            try {
                await this._performIndexing(indexingScope, progress);
                logger.info('Index initialization completed');
                
                // Get file count for notification
                const fileCount = Object.keys(this.index).length;
                
                // Get stats from PythonClient (they're set during analysis)
                if (this.pythonClient.indexingStats && this.pythonClient.indexingStats.totalScanned) {
                    this.indexingStats = { ...this.pythonClient.indexingStats };
                }
                
                // Build notification message with stats if available
                let message: string;
                if (this.indexingStats.totalScanned) {
                    message = `Python Inheritance Navigator: Scanned ${this.indexingStats.totalScanned} Python files, found inheritance in ${fileCount} files`;
                } else {
                    message = `Python Inheritance Navigator: Found inheritance relationships in ${fileCount} files`;
                }
                
                logger.info('Showing completion notification', { message, stats: this.indexingStats });
                
                // Show success notification
                vscode.window.showInformationMessage(
                    message,
                    'View Log'
                ).then(selection => {
                    if (selection === 'View Log') {
                        logger.showOutputChannel();
                    }
                });
            } finally {
                this._isIndexing = false;
                this.indexingPromise = null;
            }
        }) as Promise<void>;
        
                try {
                    await this.indexingPromise;
                    // Get stats from PythonClient if available (stats are set during analysis)
                    if (this.pythonClient.indexingStats && this.pythonClient.indexingStats.totalScanned) {
                        this.indexingStats = { ...this.pythonClient.indexingStats };
                        logger.info('Stored indexing stats', this.indexingStats);
                    }
                } catch (error) {
                    logger.error('Indexing failed', error);
                    this._isIndexing = false;
                    this.indexingPromise = null;
                    throw error;
                }

        this._setupFileWatcher();
    }

    private async _performIndexing(scope: string, progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
        logger.info('Starting indexing', { scope });
        try {
            if (scope === 'workspace') {
                logger.debug('Indexing entire workspace');
                const shouldSkip = await this._shouldSkipForMultipleGitRepos();
                if (shouldSkip) {
                    logger.warn('Indexing skipped because folder contains multiple Git repositories and skip setting is enabled');
                    vscode.window.showWarningMessage('Python Inheritance Navigator: Skipped indexing because the folder contains multiple Git repositories (adjust setting "Skip folders with multiple Git repos" to override)');
                    progress?.report({ increment: 100, message: 'Indexing skipped (multiple Git repos detected)' });
                    return;
                }
                progress?.report({ increment: 0, message: 'Scanning workspace for Python files...' });
                
                // Start the analysis (it runs in background)
                const analysisPromise = this.pythonClient.analyzeWorkspace();
                
                // Simulate progress updates while waiting (since we can't track Python process progress)
                let progressValue = 10;
                let intervalActive = true;
                const progressInterval = setInterval(() => {
                    if (intervalActive && progressValue < 90) {
                        progressValue += 2;
                        progress?.report({ increment: 2, message: 'Analyzing Python files...' });
                    }
                }, 300);
                
                try {
                    // Wait for analysis to complete
                    this.index = await analysisPromise;
                    intervalActive = false;
                    clearInterval(progressInterval);
                    
                    const fileCount = Object.keys(this.index).length;
                    logger.info('Workspace indexing completed', { fileCount });
                    
                    // Save index to file (do this before completing progress)
                    this._saveIndexToFile();
                    
                    // Complete the progress to 100%
                    const remaining = 100 - progressValue;
                    if (remaining > 0) {
                        progress?.report({ increment: remaining, message: `Found inheritance relationships in ${fileCount} files` });
                    } else {
                        progress?.report({ increment: 0, message: `Found inheritance relationships in ${fileCount} files` });
                    }
                } catch (error) {
                    intervalActive = false;
                    clearInterval(progressInterval);
                    throw error;
                }
            } else {
                logger.debug('Indexing open files only');
                const openFiles = vscode.workspace.textDocuments
                    .filter(doc => doc.languageId === 'python' && doc.uri.scheme === 'file')
                    .map(doc => doc.uri.fsPath);
                
                logger.debug('Found open Python files', { count: openFiles.length });
                progress?.report({ increment: 0, message: `Indexing ${openFiles.length} open files...` });
                
                const totalFiles = openFiles.length;
                for (let i = 0; i < openFiles.length; i++) {
                    const filePath = openFiles[i];
                    const fileName = path.basename(filePath);
                    try {
                        progress?.report({ 
                            increment: (100 / totalFiles) * (i / totalFiles),
                            message: `Analyzing ${fileName}... (${i + 1}/${totalFiles})`
                        });
                        
                        const fileIndex = await this.pythonClient.analyzeFile(filePath);
                        this._mergeIndex(fileIndex);
                        logger.debug('Indexed file', { filePath });
                    } catch (error) {
                        logger.error(`Failed to index file`, { filePath, error });
                        console.error(`Failed to index ${filePath}:`, error);
                    }
                }
                progress?.report({ increment: 100, message: 'Indexing completed!' });
            }
        } catch (error) {
            logger.error('Failed to index workspace', error);
            console.error('Failed to index workspace:', error);
            progress?.report({ increment: 100, message: 'Indexing failed' });
            vscode.window.showErrorMessage(`Failed to index Python files: ${error}`);
        }
    }

    private _mergeIndex(newIndex: InheritanceIndex): void {
        for (const [filePath, fileData] of Object.entries(newIndex)) {
            if (filePath in this.index) {
                const existing = this.index[filePath];
                if (Array.isArray(existing) && Array.isArray(fileData)) {
                    this.index[filePath] = [...existing, ...fileData];
                } else if (typeof existing === 'object' && typeof fileData === 'object') {
                    const existingData = existing as FileInheritanceData;
                    const newData = fileData as FileInheritanceData;
                    this.index[filePath] = {
                        methods: [...(existingData.methods || []), ...(newData.methods || [])],
                        classes: { ...(existingData.classes || {}), ...(newData.classes || {}) }
                    };
                } else {
                    this.index[filePath] = fileData;
                }
            } else {
                this.index[filePath] = fileData;
            }
        }
    }

    private _setupFileWatcher(): void {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }

        const pattern = new vscode.RelativePattern(
            vscode.workspace.workspaceFolders?.[0] || vscode.Uri.file(''),
            '**/*.py'
        );

        this.fileWatcher = new FileWatcher(pattern);
        this.fileWatcher.onDidChange(async (uri) => {
            logger.debug('File changed, re-indexing', { filePath: uri.fsPath });
            try {
                const fileIndex = await this.pythonClient.analyzeFile(uri.fsPath);
                this._updateFileInIndex(uri.fsPath, fileIndex);
            } catch (error) {
                logger.error('Failed to update index for file', { filePath: uri.fsPath, error });
                console.error(`Failed to update index for ${uri.fsPath}:`, error);
            }
        });
        
        this.fileWatcher.onDidCreate(async (uri) => {
            logger.debug('New file created, indexing', { filePath: uri.fsPath });
            try {
                const fileIndex = await this.pythonClient.analyzeFile(uri.fsPath);
                this._updateFileInIndex(uri.fsPath, fileIndex);
            } catch (error) {
                logger.error('Failed to index new file', { filePath: uri.fsPath, error });
                console.error(`Failed to index new file ${uri.fsPath}:`, error);
            }
        });
    }

    private _updateFileInIndex(filePath: string, fileIndex: InheritanceIndex): void {
        if (filePath in fileIndex) {
            this.index[filePath] = fileIndex[filePath];
            const fileData = fileIndex[filePath];
            const methodCount = Array.isArray(fileData) ? fileData.length : (fileData as FileInheritanceData).methods?.length || 0;
            logger.debug('Updated index for file', { filePath, methodCount });
        } else {
            delete this.index[filePath];
            logger.debug('Removed file from index', { filePath });
        }
        // Save index to file
        this._saveIndexToFile();
        // Notify that index was updated
        this.onIndexUpdatedEmitter.fire();
    }
    
    private _refreshIndexInBackground(): void {
        // Refresh index in background without blocking
        const config = vscode.workspace.getConfiguration('pythonInheritance');
        const indexingScope = config.get<string>('indexingScope', 'workspace');
        
        // Run in background without showing progress
        this._performIndexing(indexingScope).then(() => {
            logger.info('Background index refresh completed');
            this._saveIndexToFile();
        }).catch((error) => {
            logger.error('Background index refresh failed', error);
        });
    }

    getRelationshipsForMethod(
        filePath: string,
        className: string,
        methodName: string,
        line: number
    ): MethodRelationship | null {
        if (!(filePath in this.index)) {
            return null;
        }

        const fileData = this.index[filePath];
        const relationships = Array.isArray(fileData) ? fileData : (fileData as FileInheritanceData).methods || [];
        
        for (const rel of relationships) {
            if (
                rel.method.class_name === className &&
                rel.method.name === methodName &&
                Math.abs(rel.method.line - line) <= 1
            ) {
                return rel;
            }
        }

        return null;
    }

    getClassInheritance(
        filePath: string,
        className: string,
        _line?: number
    ): { baseClasses: string[]; subClasses: string[]; classLine?: number } | null {
        if (!(filePath in this.index)) {
            return null;
        }

        const fileData = this.index[filePath];
        
        // Check if we have class-level inheritance data
        if (fileData && typeof fileData === 'object' && 'classes' in fileData) {
            const fileInheritance = fileData as FileInheritanceData;
            if (fileInheritance.classes && fileInheritance.classes[className]) {
                const classInfo = fileInheritance.classes[className];
                // Extract short names from full names for display
                const baseClasses = classInfo.base_classes.map((fullName: string) => {
                    const parts = fullName.split('.');
                    return parts[parts.length - 1];
                });
                const subClasses = classInfo.sub_classes.map((fullName: string) => {
                    const parts = fullName.split('.');
                    return parts[parts.length - 1];
                });
                return { 
                    baseClasses, 
                    subClasses,
                    classLine: classInfo.line  // Include class definition line
                };
            }
        }

        // Fallback: Find all relationships for this class (method-based inference)
        const baseClasses = new Set<string>();
        const subClasses = new Set<string>();

        const relationships = Array.isArray(fileData) ? fileData : (fileData as FileInheritanceData).methods || [];
        for (const rel of relationships) {
            if (rel.method.class_name === className) {
                // Check if this method has base methods (class inherits from another)
                for (const baseMethod of rel.base_methods) {
                    baseClasses.add(baseMethod.class_name);
                }
                // Check if this method has overrides (other classes inherit from this)
                for (const overrideMethod of rel.override_methods) {
                    subClasses.add(overrideMethod.class_name);
                }
            }
        }

        // Also check reverse - if other classes have methods that override this class's methods
        for (const [, otherFileData] of Object.entries(this.index)) {
            const otherRelationships = Array.isArray(otherFileData) ? otherFileData : (otherFileData as FileInheritanceData).methods || [];
            for (const rel of otherRelationships) {
                // If this class's methods are base methods for other classes
                for (const baseMethod of rel.base_methods) {
                    if (baseMethod.class_name === className) {
                        subClasses.add(rel.method.class_name);
                    }
                }
            }
        }

        if (baseClasses.size > 0 || subClasses.size > 0) {
            return {
                baseClasses: Array.from(baseClasses),
                subClasses: Array.from(subClasses)
            };
        }

        return null;
    }

    findClassDefinitionSync(className: string): { filePath: string; line: number; column: number } | null {
        // Search through the index to find class definitions (synchronous version)
        for (const [filePath, fileData] of Object.entries(this.index)) {
            // Check class inheritance data - this has the class definition line
            if (fileData && typeof fileData === 'object' && 'classes' in fileData) {
                const fileInheritance = fileData as FileInheritanceData;
                if (fileInheritance.classes && fileInheritance.classes[className]) {
                    const classInfo = fileInheritance.classes[className];
                    // Use the stored class definition line if available
                    if (classInfo.line && classInfo.line > 0) {
                        return {
                            filePath: filePath,
                            line: classInfo.line,
                            column: 0  // Column will be found in async version if needed
                        };
                    }
                    // Fallback: Try to find the class definition line from method relationships
                    const relationships = fileInheritance.methods || [];
                    for (const rel of relationships) {
                        if (rel.method.class_name === className) {
                            // Use the first method's location as a starting point
                            // The class definition should be before the first method
                            return {
                                filePath: filePath,
                                line: Math.max(1, rel.method.line - 10), // Start searching a few lines before first method
                                column: 0
                            };
                        }
                    }
                    // If no methods found, return file path - will search in async version
                    return {
                        filePath: filePath,
                        line: 0,
                        column: 0
                    };
                }
            }
            
            // Also check method relationships for the class (fallback)
            const relationships = Array.isArray(fileData) ? fileData : (fileData as FileInheritanceData).methods || [];
            for (const rel of relationships) {
                if (rel.method.class_name === className) {
                    // This gives us a method line, not the class line, but it's better than nothing
                    return {
                        filePath: filePath,
                        line: Math.max(1, rel.method.line - 10), // Estimate class is before first method
                        column: 0
                    };
                }
            }
        }
        
        return null;
    }

    async findClassDefinition(className: string): Promise<{ filePath: string; line: number; column: number } | null> {
        // Search through the index to find class definitions
        const syncResult = this.findClassDefinitionSync(className);
        if (!syncResult) {
            return null;
        }
        
        // If we have a file but no exact line, search for the class definition
        if (syncResult.line === 0 || syncResult.line < 10) {
            try {
                const uri = vscode.Uri.file(syncResult.filePath);
                const document = await vscode.workspace.openTextDocument(uri);
                // Search from the beginning or from the estimated location
                const startLine = syncResult.line > 0 ? Math.max(0, syncResult.line - 10) : 0;
                for (let i = startLine; i < document.lineCount; i++) {
                    const line = document.lineAt(i);
                    const trimmed = line.text.trim();
                    // Match class definition: "class ClassName" or "class ClassName("
                    const match = trimmed.match(new RegExp(`^class\\s+${className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:(]`));
                    if (match) {
                        return {
                            filePath: syncResult.filePath,
                            line: i + 1,
                            column: line.firstNonWhitespaceCharacterIndex
                        };
                    }
                }
            } catch (error) {
                logger.error('Error finding class definition', { className, filePath: syncResult.filePath, error });
            }
        } else {
            // We have a line number, use it
            return syncResult;
        }
        
        return null;
    }

    async refreshIndex(): Promise<void> {
        if (this._isIndexing) {
            vscode.window.showInformationMessage('Indexing already in progress');
            return;
        }

        this.index = {};

        const config = vscode.workspace.getConfiguration('pythonInheritance');
        const indexingScope = config.get<string>('indexingScope', 'workspace');

        this._isIndexing = true;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Python Inheritance Navigator',
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: 'Refreshing index...' });

            try {
                await this._performIndexing(indexingScope, progress);

                // Get file count for notification
                const fileCount = Object.keys(this.index).length;

                // Show success notification
                vscode.window.showInformationMessage(
                    `Python Inheritance Navigator: Index refreshed - found inheritance in ${fileCount} files`,
                    'View Log'
                ).then(selection => {
                    if (selection === 'View Log') {
                        logger.showOutputChannel();
                    }
                });

                // Save index to file
                this._saveIndexToFile();
            } finally {
                this._isIndexing = false;
            }
        });
    }

    async cleanAndReindex(): Promise<void> {
        if (this._isIndexing) {
            vscode.window.showInformationMessage('Indexing already in progress');
            return;
        }

        // Delete the saved index file if it exists
        if (this.indexFilePath && fs.existsSync(this.indexFilePath)) {
            try {
                fs.unlinkSync(this.indexFilePath);
                logger.info('Deleted saved index file', { filePath: this.indexFilePath });
            } catch (error) {
                logger.error('Failed to delete saved index file', { error, filePath: this.indexFilePath });
            }
        }

        // Clear the in-memory index
        this.index = {};

        const config = vscode.workspace.getConfiguration('pythonInheritance');
        const indexingScope = config.get<string>('indexingScope', 'workspace');

        this._isIndexing = true;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Python Inheritance Navigator',
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: 'Cleaning and rebuilding index...' });

            try {
                await this._performIndexing(indexingScope, progress);

                // Get file count for notification
                const fileCount = Object.keys(this.index).length;

                // Show success notification
                vscode.window.showInformationMessage(
                    `Python Inheritance Navigator: Index cleaned and rebuilt - found inheritance in ${fileCount} files`,
                    'View Log'
                ).then(selection => {
                    if (selection === 'View Log') {
                        logger.showOutputChannel();
                    }
                });

                // Save new index to file
                this._saveIndexToFile();
            } finally {
                this._isIndexing = false;
            }
        });
    }

    dispose(): void {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
            this.fileWatcher = null;
        }
    }
}

