import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { InheritanceIndex } from './types';
import { logger } from '../utils/logger';

export class PythonClient {
    private pythonProcess: ChildProcess | null = null;
    private pythonPath: string;
    private analyzerPath: string;
    private workspaceRoot: string;
    public indexingStats: { totalScanned?: number; filesWithInheritance?: number } = {};
    
    getIndexingStats(): { totalScanned?: number; filesWithInheritance?: number } {
        return { ...this.indexingStats };
    }

    constructor(workspaceRoot: string, pythonPath = 'python3', extensionPath?: string) {
        this.workspaceRoot = workspaceRoot;
        this.pythonPath = pythonPath;
        if (extensionPath) {
            this.analyzerPath = path.join(extensionPath, 'python', 'inheritance_analyzer.py');
        } else {
            this.analyzerPath = path.join(__dirname, '../../python/inheritance_analyzer.py');
        }
    }

    async analyzeWorkspace(): Promise<InheritanceIndex> {
        logger.info('Starting workspace analysis', { 
            pythonPath: this.pythonPath, 
            analyzerPath: this.analyzerPath, 
            workspaceRoot: this.workspaceRoot 
        });

        // Verify Python path exists (only for absolute paths)
        // Only check existence for absolute paths
        // For relative paths like "python3", let spawn handle it
        if (path.isAbsolute(this.pythonPath) && !fs.existsSync(this.pythonPath)) {
            const error = `Python executable not found at: ${this.pythonPath}`;
            logger.error(error, { pythonPath: this.pythonPath });
            throw new Error(error);
        }
        
        // For relative paths, log a warning but continue (spawn will handle the error)
        if (!path.isAbsolute(this.pythonPath)) {
            logger.warn('Using relative Python path (may fail if not in PATH)', { pythonPath: this.pythonPath });
        }

        return new Promise((resolve, reject) => {
            logger.debug('Spawning Python process', { 
                command: `${this.pythonPath} ${this.analyzerPath} ${this.workspaceRoot}` 
            });

            const process = spawn(this.pythonPath, [this.analyzerPath, this.workspaceRoot], {
                cwd: this.workspaceRoot,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';
            let hasOutput = false;
            
            // Add timeout (30 minutes for large workspaces)
            const timeout = setTimeout(() => {
                if (!hasOutput) {
                    logger.error('Python analyzer timeout - no output received', { timeoutMs: 30 * 60 * 1000 });
                    process.kill('SIGTERM');
                    reject(new Error('Python analyzer timed out after 30 minutes. The workspace may be too large. Try using "Clean and Reindex" command.'));
                }
            }, 30 * 60 * 1000);

            process.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            process.stderr.on('data', (data) => {
                hasOutput = true;
                const stderrData = data.toString();
                stderr += stderrData;
                
                // Log warnings and errors from Python analyzer
                const lines = stderrData.split('\n').filter((line: string) => line.trim());
                for (const line of lines) {
                    // Skip traceback lines and common expected warnings to reduce noise
                    if (line.includes('Traceback') || line.startsWith('  File ') || line.startsWith('    ')) {
                        // Skip traceback lines - they're too verbose
                        continue;
                    }
                    // Only log actual errors, not expected MRO warnings for test classes
                    if (line.includes('Error analyzing') && !line.includes('list index out of range')) {
                        logger.warn('Python analyzer error', { line, filePath: this.workspaceRoot });
                    } else if (line.includes('[STATS]')) {
                        // Parse stats from stderr if present
                        const statsMatch = line.match(/Scanned (\d+) Python files, found inheritance in (\d+) files/);
                        if (statsMatch) {
                            this.indexingStats.totalScanned = parseInt(statsMatch[1], 10);
                            this.indexingStats.filesWithInheritance = parseInt(statsMatch[2], 10);
                            logger.info('Python analyzer statistics', { 
                                totalScanned: this.indexingStats.totalScanned, 
                                filesWithInheritance: this.indexingStats.filesWithInheritance 
                            });
                        }
                    } else if (line.includes('[PROGRESS]')) {
                        // Parse progress updates - can be file progress or relationship computation progress
                        const fileProgressMatch = line.match(/\[PROGRESS\] (\d+)\/(\d+) files(?: \((\d+)%\))?/);
                        const relationshipProgressMatch = line.match(/\[PROGRESS\] Computing relationships: (\d+)\/(\d+) classes(?: \((\d+)%\))?/);
                        const allFilesAnalyzedMatch = line.match(/\[PROGRESS\] All files analyzed\. Computing relationships for (\d+) classes/);
                        
                        if (fileProgressMatch) {
                            const current = parseInt(fileProgressMatch[1], 10);
                            const total = parseInt(fileProgressMatch[2], 10);
                            const percent = fileProgressMatch[3] ? parseInt(fileProgressMatch[3], 10) : Math.round((current / total) * 100);
                            // Update stats immediately so progress bar can use them
                            this.indexingStats.totalScanned = current;
                            logger.info('Python analyzer progress', { current, total, percent });
                        } else if (relationshipProgressMatch) {
                            const current = parseInt(relationshipProgressMatch[1], 10);
                            const total = parseInt(relationshipProgressMatch[2], 10);
                            const percent = relationshipProgressMatch[3] ? parseInt(relationshipProgressMatch[3], 10) : Math.round((current / total) * 100);
                            logger.info('Python analyzer computing relationships', { current, total, percent });
                        } else if (allFilesAnalyzedMatch) {
                            const totalClasses = parseInt(allFilesAnalyzedMatch[1], 10);
                            logger.info('Python analyzer starting relationship computation', { totalClasses });
                        }
                    } else if (line.trim() && !line.includes('Warning:') && !line.includes('Error')) {
                        // Log other non-warning, non-error stderr output as debug
                        logger.debug('Python analyzer', { line });
                    }
                }
            });

            process.on('close', (code) => {
                clearTimeout(timeout);
                logger.debug('Python process closed', { code, stdoutLength: stdout.length, stderrLength: stderr.length });
                
                if (code !== 0) {
                    logger.error('Python analyzer failed', { code, stderr: stderr.substring(0, 1000) });
                    reject(new Error(`Python analyzer exited with code ${code}: ${stderr.substring(0, 500)}`));
                    return;
                }

                try {
                    if (!stdout || stdout.trim().length === 0) {
                        logger.error('Python analyzer returned empty output', { stderr: stderr.substring(0, 500) });
                        reject(new Error('Python analyzer returned empty output. Check Python environment and dependencies.'));
                        return;
                    }
                    
                    const result = JSON.parse(stdout);
                    const fileCount = Object.keys(result).length;
                    logger.info('Workspace analysis completed', { 
                        fileCount,
                        stats: stderr.includes('[STATS]') ? stderr.match(/\[STATS\].*/)?.[0] : undefined
                    });
                    resolve(result as InheritanceIndex);
                } catch (error) {
                    logger.error('Failed to parse analyzer output', { 
                        error, 
                        stdoutLength: stdout.length,
                        stdoutPreview: stdout.substring(0, 500),
                        stderrPreview: stderr.substring(0, 500)
                    });
                    reject(new Error(`Failed to parse analyzer output: ${error}. Output length: ${stdout.length}`));
                }
            });

            process.on('error', (error) => {
                clearTimeout(timeout);
                logger.error('Failed to spawn Python process', { 
                    error, 
                    pythonPath: this.pythonPath, 
                    analyzerPath: this.analyzerPath 
                });
                reject(new Error(`Failed to spawn Python process: ${error.message}`));
            });
        });
    }

    async analyzeFile(filePath: string): Promise<InheritanceIndex> {
        logger.debug('Analyzing single file', { filePath });

        return new Promise((resolve, reject) => {
            const process = spawn(
                this.pythonPath,
                [this.analyzerPath, this.workspaceRoot, filePath],
                {
                    cwd: this.workspaceRoot,
                    stdio: ['pipe', 'pipe', 'pipe']
                }
            );

            let stdout = '';
            let stderr = '';

            process.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            process.stderr.on('data', (data) => {
                const stderrData = data.toString();
                stderr += stderrData;
                
                // Log warnings and errors from Python analyzer
                const lines = stderrData.split('\n').filter((line: string) => line.trim());
                for (const line of lines) {
                    // Skip traceback lines and common expected warnings to reduce noise
                    if (line.includes('Traceback') || line.startsWith('  File ') || line.startsWith('    ')) {
                        // Skip traceback lines - they're too verbose
                        continue;
                    }
                    // Only log actual errors, not expected MRO warnings for test classes
                    if (line.includes('Error analyzing') && !line.includes('list index out of range')) {
                        logger.warn('Python analyzer output', { line, filePath });
                    }
                }
            });

            process.on('close', (code) => {
                if (code !== 0) {
                    logger.error('Python analyzer failed for file', { code, filePath, stderr });
                    reject(new Error(`Python analyzer exited with code ${code}: ${stderr}`));
                    return;
                }

                try {
                    const result = JSON.parse(stdout);
                    logger.debug('File analysis completed', { filePath });
                    resolve(result as InheritanceIndex);
                } catch (error) {
                    logger.error('Failed to parse analyzer output for file', { error, filePath });
                    reject(new Error(`Failed to parse analyzer output: ${error}`));
                }
            });

            process.on('error', (error) => {
                logger.error('Failed to spawn Python process for file', { error, filePath });
                reject(new Error(`Failed to spawn Python process: ${error.message}`));
            });
        });
    }

    async analyzeFiles(filePaths: string[]): Promise<InheritanceIndex> {
        if (filePaths.length === 0) {
            logger.debug('No files to analyze');
            return {};
        }

        logger.debug('Analyzing multiple files', { fileCount: filePaths.length });

        return new Promise((resolve, reject) => {
            const args = [this.analyzerPath, this.workspaceRoot, ...filePaths];
            const process = spawn(
                this.pythonPath,
                args,
                {
                    cwd: this.workspaceRoot,
                    stdio: ['pipe', 'pipe', 'pipe']
                }
            );

            let stdout = '';
            let stderr = '';

            process.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            process.stderr.on('data', (data) => {
                const stderrData = data.toString();
                stderr += stderrData;
                
                // Log warnings and errors from Python analyzer
                const lines = stderrData.split('\n').filter((line: string) => line.trim());
                for (const line of lines) {
                    // Skip traceback lines and common expected warnings to reduce noise
                    if (line.includes('Traceback') || line.startsWith('  File ') || line.startsWith('    ')) {
                        // Skip traceback lines - they're too verbose
                        continue;
                    }
                    // Only log actual errors, not expected MRO warnings for test classes
                    if (line.includes('Error analyzing') && !line.includes('list index out of range')) {
                        logger.warn('Python analyzer output', { line });
                    } else if (line.includes('[STATS]')) {
                        // Parse stats from stderr if present
                        const statsMatch = line.match(/Scanned (\d+) Python files, found inheritance in (\d+) files/);
                        if (statsMatch) {
                            this.indexingStats.totalScanned = parseInt(statsMatch[1], 10);
                            this.indexingStats.filesWithInheritance = parseInt(statsMatch[2], 10);
                            logger.info('Batch indexing statistics', { 
                                totalScanned: this.indexingStats.totalScanned, 
                                filesWithInheritance: this.indexingStats.filesWithInheritance 
                            });
                        }
                    }
                }
            });

            process.on('close', (code) => {
                if (code !== 0) {
                    logger.error('Python analyzer failed for batch', { code, fileCount: filePaths.length, stderr });
                    reject(new Error(`Python analyzer exited with code ${code}: ${stderr}`));
                    return;
                }

                try {
                    const result = JSON.parse(stdout);
                    const fileCount = Object.keys(result).length;
                    logger.debug('Batch analysis completed', { 
                        fileCount,
                        inputFiles: filePaths.length,
                        stats: stderr.includes('[STATS]') ? stderr.match(/\[STATS\].*/)?.[0] : undefined
                    });
                    resolve(result as InheritanceIndex);
                } catch (error) {
                    logger.error('Failed to parse analyzer output for batch', { error, fileCount: filePaths.length });
                    reject(new Error(`Failed to parse analyzer output: ${error}`));
                }
            });

            process.on('error', (error) => {
                logger.error('Failed to spawn Python process for batch', { error, fileCount: filePaths.length });
                reject(new Error(`Failed to spawn Python process: ${error.message}`));
            });
        });
    }
}

