import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PythonClient } from './analysis/pythonClient';
import { InheritanceIndex, MethodRelationship, FileInheritanceData, ClassInheritance } from './analysis/types';
import { FileWatcher } from './utils/fileWatcher';
import { FileChangeQueue } from './utils/fileChangeQueue';
import { BatchProgressDisplay } from './utils/batchProgressDisplay';
import { logger } from './utils/logger';
import { countGitRepos } from './utils/gitRepoDetector';

export class InheritanceIndexManager {
    private index: InheritanceIndex = {};
    private pythonClient: PythonClient;
    private fileWatcher: FileWatcher | null = null;
    private fileChangeQueue: FileChangeQueue | null = null;
    private batchProgressDisplay: BatchProgressDisplay | null = null;
    private _isIndexing = false;
    private indexingPromise: Promise<void> | null = null;
    private onIndexUpdatedEmitter: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onIndexUpdated: vscode.Event<void> = this.onIndexUpdatedEmitter.event;
    private indexingStats: { totalScanned?: number; filesWithInheritance?: number } = {};
    private storagePath: string | null = null;
    private indexFilePath: string | null = null;
    private workspaceRoot: string;
    private filesBeingIndexed: Set<string> = new Set(); // Track files currently being indexed on-demand
    private filesWithSyntaxErrors: Set<string> = new Set(); // Track files that failed due to syntax errors

    isIndexing(): boolean {
        return this._isIndexing;
    }

    constructor(workspaceRoot: string, pythonPath = 'python3', extensionPath?: string, storagePath?: string) {
        this.workspaceRoot = workspaceRoot;
        const config = vscode.workspace.getConfiguration('pythonInheritance');
        this.pythonClient = new PythonClient(
            workspaceRoot,
            pythonPath,
            extensionPath
        );
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

        // Initialize FileChangeQueue with configuration
        const debounceMs = config.get<number>('fileChangeDebounceMs', 3000);
        const batchSize = config.get<number>('filesPerBatch', 50);
        const maxConcurrent = config.get<number>('maxConcurrentAnalyses', 10);

        // Create batch progress display
        this.batchProgressDisplay = new BatchProgressDisplay();

        this.fileChangeQueue = new FileChangeQueue(
            async (filePaths: string[]) => {
                // Batch processor callback
                const batchResult = await this.pythonClient.analyzeFiles(filePaths);
                // Update index for each file that appears in the batch result (without saving)
                for (const filePath of Object.keys(batchResult)) {
                    this._updateFileInIndexWithoutSaving(filePath, batchResult);
                }
                // Also handle files that were requested but don't appear in result
                // (e.g., files with no inheritance relationships)
                for (const filePath of filePaths) {
                    if (!(filePath in batchResult)) {
                        // File was analyzed but has no inheritance data - remove from index
                        delete this.index[filePath];
                        logger.debug('Removed file from index (no inheritance)', { filePath });
                    }
                }
                // Save index after batch update
                this._saveIndexToFile();
                // Notify that index was updated
                this.onIndexUpdatedEmitter.fire();
                return batchResult;
            },
            debounceMs,
            batchSize,
            maxConcurrent,
            this.batchProgressDisplay
        );
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

        // Clear syntax error tracking on initialization
        this.filesWithSyntaxErrors.clear();

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
        
        // Start indexing in background (no progress bar)
        this.indexingPromise = (async () => {
            try {
                await this._performIndexing(indexingScope);
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
                    message = `Python Inheritance Navigator: Indexing complete. Scanned ${this.indexingStats.totalScanned} Python files, found inheritance in ${fileCount} files`;
                } else {
                    message = `Python Inheritance Navigator: Indexing complete. Found inheritance relationships in ${fileCount} files`;
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
        })();
        
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

    private async _performIndexing(scope: string): Promise<void> {
        const startTime = Date.now();
        logger.info('Starting indexing', { scope, startTime });
        try {
            if (scope === 'workspace') {
                logger.debug('Indexing entire workspace');
                const shouldSkip = await this._shouldSkipForMultipleGitRepos();
                if (shouldSkip) {
                    logger.warn('Indexing skipped because folder contains multiple Git repositories and skip setting is enabled');
                    vscode.window.showWarningMessage('Python Inheritance Navigator: Skipped indexing because the folder contains multiple Git repositories (adjust setting "Skip folders with multiple Git repos" to override)');
                    return;
                }
                logger.info('Starting workspace indexing');
                
                // Start the analysis (it runs in background)
                const analysisPromise = this.pythonClient.analyzeWorkspace();
                    
                // Wait for analysis to complete
                this.index = await analysisPromise;
                    
                const fileCount = Object.keys(this.index).length;
                const stats = this.pythonClient.getIndexingStats();
                logger.info('Workspace indexing completed', { 
                    fileCount, 
                    totalScanned: stats.totalScanned,
                    filesWithInheritance: stats.filesWithInheritance
                });
                    
                // Save index to file
                this._saveIndexToFile();
            } else {
                logger.debug('Indexing open files only');
                const openFiles = vscode.workspace.textDocuments
                    .filter(doc => {
                        if (doc.languageId !== 'python' || doc.uri.scheme !== 'file') {
                            return false;
                        }
                        // Exclude .history directories
                        const filePath = doc.uri.fsPath;
                        return !filePath.includes('/.history/') && !filePath.includes('\\.history\\');
                    })
                    .map(doc => doc.uri.fsPath);
                
                logger.debug('Found open Python files', { count: openFiles.length });
                
                for (const filePath of openFiles) {
                    try {
                        const fileIndex = await this.pythonClient.analyzeFile(filePath);
                        this._mergeIndex(fileIndex);
                        logger.debug('Indexed file', { filePath });
                    } catch (error) {
                        logger.error(`Failed to index file`, { filePath, error });
                        console.error(`Failed to index ${filePath}:`, error);
                    }
                }
            }
        } catch (error) {
            const duration = Date.now() - startTime;
            logger.error('Failed to index workspace', { error, duration, scope });
            console.error('Failed to index workspace:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to index Python files: ${errorMessage}`);
        } finally {
            const duration = Date.now() - startTime;
            logger.info('Indexing completed', { scope, duration, indexFileCount: Object.keys(this.index).length });
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
        this.fileWatcher.onDidChange((uri) => {
            // Exclude .history directories
            if (uri.fsPath.includes('/.history/') || uri.fsPath.includes('\\.history\\')) {
                return;
            }
            logger.debug('File changed, adding to queue', { filePath: uri.fsPath });
            if (this.fileChangeQueue) {
                this.fileChangeQueue.addFile(uri.fsPath);
            }
        });
        
        this.fileWatcher.onDidCreate((uri) => {
            // Exclude .history directories
            if (uri.fsPath.includes('/.history/') || uri.fsPath.includes('\\.history\\')) {
                return;
            }
            logger.debug('New file created, adding to queue', { filePath: uri.fsPath });
            if (this.fileChangeQueue) {
                this.fileChangeQueue.addFile(uri.fsPath);
            }
        });
    }

    private _updateFileInIndex(filePath: string, fileIndex: InheritanceIndex): void {
        this._updateFileInIndexWithoutSaving(filePath, fileIndex);
        // Save index to file
        this._saveIndexToFile();
        // Notify that index was updated
        this.onIndexUpdatedEmitter.fire();
    }

    private _updateFileInIndexWithoutSaving(filePath: string, fileIndex: InheritanceIndex): void {
        if (filePath in fileIndex) {
            this.index[filePath] = fileIndex[filePath];
            const fileData = fileIndex[filePath];
            const methodCount = Array.isArray(fileData) ? fileData.length : (fileData as FileInheritanceData).methods?.length || 0;
            logger.debug('Updated index for file', { filePath, methodCount });
        } else {
            delete this.index[filePath];
            logger.debug('Removed file from index', { filePath });
        }
    }
    
    private async _indexFileOnDemand(filePath: string): Promise<void> {
        // Index a single file on-demand if it's not already in the index
        if (filePath in this.index) {
            return; // Already indexed
        }

        // Check if file has syntax errors (don't retry)
        if (this.filesWithSyntaxErrors.has(filePath)) {
            logger.debug('On-demand indexing skipped: file has syntax errors', { filePath });
            return;
        }

        // Check if file is already being indexed (prevent duplicate requests)
        if (this.filesBeingIndexed.has(filePath)) {
            logger.debug('On-demand indexing skipped: file already being indexed', { filePath });
            return;
        }

        // Check if file exists and is within workspace
        if (!fs.existsSync(filePath)) {
            logger.debug('On-demand indexing skipped: file does not exist', { filePath });
            return;
        }

        if (!filePath.startsWith(this.workspaceRoot)) {
            logger.debug('On-demand indexing skipped: file outside workspace', { filePath, workspaceRoot: this.workspaceRoot });
            return;
        }

        // Mark file as being indexed
        this.filesBeingIndexed.add(filePath);

        try {
            logger.debug('Indexing file on-demand', { filePath });
            const fileIndex = await this.pythonClient.analyzeFile(filePath);
            this._updateFileInIndex(filePath, fileIndex);
            // Clear any previous syntax error marking since indexing succeeded
            this.filesWithSyntaxErrors.delete(filePath);
            logger.debug('On-demand indexing completed', { filePath });
        } catch (error: any) {
            logger.debug('On-demand indexing failed', { filePath, error });

            // Check if error is due to syntax issues
            const errorMessage = error?.message || String(error);
            if (errorMessage.includes('invalid syntax') || errorMessage.includes('syntax error')) {
                this.filesWithSyntaxErrors.add(filePath);
                logger.debug('Marked file as having syntax errors', { filePath });
            }

            // Don't throw - this is best-effort
        } finally {
            // Always remove from set, even if indexing failed
            this.filesBeingIndexed.delete(filePath);
        }
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
        const classNameShort = className.split('.').pop() || className;
        let fileFoundInIndex = false;
        
        if (!(filePath in this.index)) {
            // Try to find the file with different path formats
            const normalizedPath = filePath.replace(/\\/g, '/');
            const indexKeys = Object.keys(this.index);
            const matchingKey = indexKeys.find(key => {
                const normalizedKey = key.replace(/\\/g, '/');
                return normalizedKey === normalizedPath || 
                       normalizedKey.endsWith(normalizedPath) ||
                       normalizedPath.endsWith(normalizedKey);
            });
            
            if (matchingKey) {
                logger.debug('getRelationshipsForMethod: found file with different path format', { 
                    requested: filePath, 
                    found: matchingKey 
                });
                filePath = matchingKey;
                fileFoundInIndex = true;
            } else {
                logger.debug('getRelationshipsForMethod: file not in index, searching by class and method name', { 
                    filePath, 
                    className, 
                    methodName,
                    indexFileCount: indexKeys.length,
                    sampleKeys: indexKeys.slice(0, 5)
                });
                // Try to index the file on-demand if it exists and is within workspace
                if (fs.existsSync(filePath) && filePath.startsWith(this.workspaceRoot)) {
                    logger.debug('getRelationshipsForMethod: attempting on-demand indexing', { filePath });
                    // Index asynchronously (don't block, but trigger indexing)
                    this._indexFileOnDemand(filePath).catch(err => {
                        logger.debug('On-demand indexing failed', { filePath, error: err });
                    });
                }
                // Continue to search by class/method name even if file is not indexed
                fileFoundInIndex = false;
            }
        } else {
            fileFoundInIndex = true;
        }

        // First, try to find the relationship in the file's data (if file is indexed)
        if (fileFoundInIndex) {
            const fileData = this.index[filePath];
            const relationships = Array.isArray(fileData) ? fileData : (fileData as FileInheritanceData).methods || [];
            
            logger.debug('getRelationshipsForMethod searching in file', { 
                filePath, 
                className, 
                classNameShort,
                methodName, 
                line,
                relationshipCount: relationships.length 
            });
            
            for (const rel of relationships) {
                const relClassName = rel.method.class_name;
                const relClassNameShort = relClassName.split('.').pop() || relClassName;
                
                // Match by both full name and short name
                const nameMatches = relClassName === className || relClassNameShort === classNameShort;
                const methodMatches = rel.method.name === methodName;
                const lineMatches = Math.abs(rel.method.line - line) <= 1;
                
                if (nameMatches && methodMatches && lineMatches) {
                    logger.debug('getRelationshipsForMethod found relationship', { 
                        className, 
                        methodName,
                        baseCount: rel.base_methods?.length || 0,
                        overrideCount: rel.override_methods?.length || 0
                    });
                    return rel;
                }
            }
        }

        // If not found in the file (or file not indexed), search through all indexed files
        // Look for relationships where:
        // 1. Other classes have methods that override this base class's methods (base_methods contains this class)
        // 2. This class's methods are in other classes' base_methods (to find overrides)
        logger.debug('getRelationshipsForMethod searching across all files', { 
            className, 
            classNameShort,
            methodName, 
            line
        });
        
        // First, try to find the method in the base class by searching for it directly
        for (const [, otherFileData] of Object.entries(this.index)) {
            const otherRelationships = Array.isArray(otherFileData) ? otherFileData : (otherFileData as FileInheritanceData).methods || [];
            for (const rel of otherRelationships) {
                const relClassName = rel.method.class_name;
                const relClassNameShort = relClassName.split('.').pop() || relClassName;
                
                // Match by both full name and short name
                const nameMatches = relClassName === className || relClassNameShort === classNameShort;
                const methodMatches = rel.method.name === methodName;
                // For cross-file search, be more lenient with line matching (within 5 lines)
                const lineMatches = Math.abs(rel.method.line - line) <= 5;
                
                if (nameMatches && methodMatches && lineMatches) {
                    logger.debug('getRelationshipsForMethod found relationship in other file', { 
                        className, 
                        methodName,
                        foundInFile: rel.method.file_path,
                        baseCount: rel.base_methods?.length || 0,
                        overrideCount: rel.override_methods?.length || 0
                    });
                    return rel;
                }
            }
        }
        
        // Second, look for methods in other classes that have this base class method in their base_methods
        // This finds subclasses that override the base class method
        for (const [, otherFileData] of Object.entries(this.index)) {
            const otherRelationships = Array.isArray(otherFileData) ? otherFileData : (otherFileData as FileInheritanceData).methods || [];
            for (const rel of otherRelationships) {
                // Check if any base_methods match the base class we're looking for
                for (const baseMethod of rel.base_methods) {
                    const baseClassName = baseMethod.class_name;
                    const baseClassNameShort = baseClassName.split('.').pop() || baseClassName;
                    const baseMethodMatches = baseMethod.name === methodName;
                    const baseNameMatches = baseClassName === className || baseClassNameShort === classNameShort;
                    
                    if (baseNameMatches && baseMethodMatches) {
                        // Found a subclass method that overrides this base class method
                        // Return a synthetic relationship showing the override
                        logger.debug('getRelationshipsForMethod found override relationship', { 
                            baseClassName, 
                            baseMethodName: methodName,
                            overrideClassName: rel.method.class_name,
                            overrideMethodName: rel.method.name,
                            foundInFile: rel.method.file_path
                        });
                        // Return the relationship from the subclass's perspective, but mark it as having an override
                        return {
                            method: {
                                name: methodName,
                                class_name: className,
                                file_path: filePath,
                                line: line,
                                column: 0,
                                end_line: line,
                                end_column: 0
                            },
                            base_methods: [],
                            override_methods: [rel.method]
                        };
                    }
                }
            }
        }
        
        logger.debug('getRelationshipsForMethod not found', { filePath, className, methodName, line });
        return null;
    }

    getClassInheritance(
        filePath: string,
        className: string,
        _line?: number
    ): { baseClasses: string[]; subClasses: string[]; classLine?: number } | null {
        const classNameShort = className.split('.').pop() || className;
        let fileFoundInIndex = false;
        
        if (!(filePath in this.index)) {
            // Try to find the file with different path formats
            const normalizedPath = filePath.replace(/\\/g, '/');
            const indexKeys = Object.keys(this.index);
            const matchingKey = indexKeys.find(key => {
                const normalizedKey = key.replace(/\\/g, '/');
                return normalizedKey === normalizedPath || 
                       normalizedKey.endsWith(normalizedPath) ||
                       normalizedPath.endsWith(normalizedKey);
            });
            
            if (matchingKey) {
                logger.debug('getClassInheritance: found file with different path format', { 
                    requested: filePath, 
                    found: matchingKey 
                });
                filePath = matchingKey;
                fileFoundInIndex = true;
            } else {
                logger.debug('getClassInheritance: file not in index, searching by class name', { 
                    filePath, 
                    className,
                    indexFileCount: indexKeys.length,
                    sampleKeys: indexKeys.slice(0, 5)
                });
                // Try to index the file on-demand if it exists and is within workspace
                if (fs.existsSync(filePath) && filePath.startsWith(this.workspaceRoot)) {
                    logger.debug('getClassInheritance: attempting on-demand indexing', { filePath });
                    // Index asynchronously (don't block, but trigger indexing)
                    this._indexFileOnDemand(filePath).catch(err => {
                        logger.debug('On-demand indexing failed', { filePath, error: err });
                    });
                }
                // Continue to search by class name even if file is not indexed
                fileFoundInIndex = false;
            }
        } else {
            fileFoundInIndex = true;
        }

        // First, try to find class-level inheritance data in the file (if file is indexed)
        let classInfo: ClassInheritance | null = null;
        let classLine: number | undefined = undefined;
        
        if (fileFoundInIndex) {
            const fileData = this.index[filePath];
            
            // Check if we have class-level inheritance data
            if (fileData && typeof fileData === 'object' && 'classes' in fileData) {
                const fileInheritance = fileData as FileInheritanceData;
                if (fileInheritance.classes) {
                    // Try exact match first
                    classInfo = fileInheritance.classes[className] || null;
                    
                    // If not found, try short name match
                    if (!classInfo) {
                        for (const [key, value] of Object.entries(fileInheritance.classes)) {
                            const keyShort = key.split('.').pop() || key;
                            if (keyShort === classNameShort || key === className) {
                                classInfo = value;
                                break;
                            }
                        }
                    }
                    
                    if (classInfo) {
                        classLine = classInfo.line;
                    }
                }
            }
        }
        
        // If file is not indexed or class info not found in indexed file, search all files by class name
        if (!classInfo) {
            for (const [, otherFileData] of Object.entries(this.index)) {
                if (otherFileData && typeof otherFileData === 'object' && 'classes' in otherFileData) {
                    const fileInheritance = otherFileData as FileInheritanceData;
                    if (fileInheritance.classes) {
                        // Try exact match first
                        let foundClassInfo = fileInheritance.classes[className];
                        
                        // If not found, try short name match
                        if (!foundClassInfo) {
                            for (const [key, value] of Object.entries(fileInheritance.classes)) {
                                const keyShort = key.split('.').pop() || key;
                                if (keyShort === classNameShort || key === className) {
                                    foundClassInfo = value;
                                    break;
                                }
                            }
                        }
                        
                        if (foundClassInfo) {
                            classInfo = foundClassInfo;
                            classLine = foundClassInfo.line;
                            break;
                        }
                    }
                }
            }
        }

        // If we found class-level inheritance data, use it
        if (classInfo) {
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
                classLine: classLine
            };
        }

        // Fallback: Find all relationships for this class (method-based inference)
        const baseClasses = new Set<string>();
        const subClasses = new Set<string>();

        // If file is indexed, check its relationships first
        if (fileFoundInIndex) {
            const fileData = this.index[filePath];
            const relationships = Array.isArray(fileData) ? fileData : (fileData as FileInheritanceData).methods || [];
            for (const rel of relationships) {
                const relClassName = rel.method.class_name;
                const relClassNameShort = relClassName.split('.').pop() || relClassName;
                
                // Match by both full name and short name
                if (relClassName === className || relClassNameShort === classNameShort) {
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
        }

        // Search through all indexed files to find relationships
        for (const [, otherFileData] of Object.entries(this.index)) {
            const otherRelationships = Array.isArray(otherFileData) ? otherFileData : (otherFileData as FileInheritanceData).methods || [];
            for (const rel of otherRelationships) {
                const relClassName = rel.method.class_name;
                const relClassNameShort = relClassName.split('.').pop() || relClassName;
                
                // If this class's methods are base methods for other classes
                for (const baseMethod of rel.base_methods) {
                    const baseClassName = baseMethod.class_name;
                    const baseClassNameShort = baseClassName.split('.').pop() || baseClassName;
                    if (baseClassName === className || baseClassNameShort === classNameShort) {
                        subClasses.add(relClassName);
                    }
                }
                
                // If this class has methods that override base class methods
                if (relClassName === className || relClassNameShort === classNameShort) {
                    for (const baseMethod of rel.base_methods) {
                        baseClasses.add(baseMethod.class_name);
                    }
                    for (const overrideMethod of rel.override_methods) {
                        subClasses.add(overrideMethod.class_name);
                    }
                }
            }
        }

        if (baseClasses.size > 0 || subClasses.size > 0) {
            return {
                baseClasses: Array.from(baseClasses),
                subClasses: Array.from(subClasses),
                classLine: classLine
            };
        }

        return null;
    }

    findClassDefinitionSync(className: string): { filePath: string; line: number; column: number } | null {
        // Search through the index to find class definitions (synchronous version)
        // className might be a short name (e.g., "BaseChannel") or full name
        const classNameShort = className.split('.').pop() || className;
        
        logger.debug('findClassDefinitionSync searching', { className, classNameShort, indexFileCount: Object.keys(this.index).length });
        
        for (const [filePath, fileData] of Object.entries(this.index)) {
            // Check class inheritance data - this has the class definition line
            if (fileData && typeof fileData === 'object' && 'classes' in fileData) {
                const fileInheritance = fileData as FileInheritanceData;
                if (fileInheritance.classes) {
                    // Try exact match first
                    let classInfo = fileInheritance.classes[className];
                    
                    // If not found, try short name match
                    if (!classInfo) {
                        for (const [key, value] of Object.entries(fileInheritance.classes)) {
                            const keyShort = key.split('.').pop() || key;
                            if (keyShort === classNameShort || key === className) {
                                classInfo = value;
                                break;
                            }
                        }
                    }
                    
                    if (classInfo) {
                        logger.debug('findClassDefinitionSync found class info', { className, filePath, line: classInfo.line });
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
                            const relClassName = rel.method.class_name;
                            const relClassNameShort = relClassName.split('.').pop() || relClassName;
                            if (relClassName === className || relClassNameShort === classNameShort) {
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
            }
            
            // Also check method relationships for the class (fallback)
            const relationships = Array.isArray(fileData) ? fileData : (fileData as FileInheritanceData).methods || [];
            for (const rel of relationships) {
                const relClassName = rel.method.class_name;
                const relClassNameShort = relClassName.split('.').pop() || relClassName;
                if (relClassName === className || relClassNameShort === classNameShort) {
                    // This gives us a method line, not the class line, but it's better than nothing
                    return {
                        filePath: filePath,
                        line: Math.max(1, rel.method.line - 10), // Estimate class is before first method
                        column: 0
                    };
                }
            }
        }
        
        logger.debug('findClassDefinitionSync not found', { className, classNameShort, searchedFiles: Object.keys(this.index).length });
        return null;
    }

    async findClassDefinition(className: string): Promise<{ filePath: string; line: number; column: number } | null> {
        // Search through the index to find class definitions
        const syncResult = this.findClassDefinitionSync(className);
        if (!syncResult) {
            logger.debug('findClassDefinition: sync search failed, trying file search', { className });
            // If sync search failed, try searching all Python files in workspace
            const classNameShort = className.split('.').pop() || className;
            const pattern = new vscode.RelativePattern(
                vscode.workspace.workspaceFolders?.[0] || vscode.Uri.file(''),
                '**/*.py'
            );
            const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 100);
            
            for (const file of files) {
                try {
                    const document = await vscode.workspace.openTextDocument(file);
                    for (let i = 0; i < document.lineCount; i++) {
                        const line = document.lineAt(i);
                        const trimmed = line.text.trim();
                        // Match class definition: "class ClassName" or "class ClassName("
                        const match = trimmed.match(new RegExp(`^class\\s+${classNameShort.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:(]`));
                        if (match) {
                            logger.debug('findClassDefinition: found via file search', { className, filePath: file.fsPath, line: i + 1 });
                            return {
                                filePath: file.fsPath,
                                line: i + 1,
                                column: line.firstNonWhitespaceCharacterIndex
                            };
                        }
                    }
                } catch (error) {
                    // Continue searching other files
                    continue;
                }
            }
            return null;
        }
        
        // If we have a file but no exact line, search for the class definition
        if (syncResult.line === 0 || syncResult.line < 10) {
            try {
                const uri = vscode.Uri.file(syncResult.filePath);
                const document = await vscode.workspace.openTextDocument(uri);
                const classNameShort = className.split('.').pop() || className;
                // Search from the beginning or from the estimated location
                const startLine = syncResult.line > 0 ? Math.max(0, syncResult.line - 10) : 0;
                for (let i = startLine; i < document.lineCount; i++) {
                    const line = document.lineAt(i);
                    const trimmed = line.text.trim();
                    // Match class definition: "class ClassName" or "class ClassName(" - try both full and short name
                    const fullNameMatch = trimmed.match(new RegExp(`^class\\s+${className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:(]`));
                    const shortNameMatch = trimmed.match(new RegExp(`^class\\s+${classNameShort.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:(]`));
                    if (fullNameMatch || shortNameMatch) {
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

        vscode.window.showInformationMessage(
            'Python Inheritance Navigator: Refreshing index in the background. A notification will appear when indexing is complete.'
        );

        try {
            await this._performIndexing(indexingScope);

            // Get file count for notification
            const fileCount = Object.keys(this.index).length;

            // Show success notification
            vscode.window.showInformationMessage(
                `Python Inheritance Navigator: Index refreshed - found inheritance in ${fileCount} files`
            );

            // Save index to file
            this._saveIndexToFile();
        } finally {
            this._isIndexing = false;
        }
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

        vscode.window.showInformationMessage(
            'Python Inheritance Navigator: Cleaning and rebuilding index in the background. A notification will appear when indexing is complete.'
        );

        try {
            await this._performIndexing(indexingScope);

            // Get file count for notification
            const fileCount = Object.keys(this.index).length;

            // Show success notification
            vscode.window.showInformationMessage(
                `Python Inheritance Navigator: Index cleaned and rebuilt - found inheritance in ${fileCount} files`
            );

            // Save new index to file
            this._saveIndexToFile();
        } finally {
            this._isIndexing = false;
        }
    }

    async clearAllIndexes(): Promise<void> {
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

        // Notify that index was cleared
        this.onIndexUpdatedEmitter.fire();

        logger.info('All indexes cleared');
        vscode.window.showInformationMessage('Python Inheritance Navigator: All indexes cleared');
    }

    dispose(): void {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
            this.fileWatcher = null;
        }
        if (this.fileChangeQueue) {
            this.fileChangeQueue.dispose();
            this.fileChangeQueue = null;
        }
        if (this.batchProgressDisplay) {
            this.batchProgressDisplay.dispose();
            this.batchProgressDisplay = null;
        }
    }
}

