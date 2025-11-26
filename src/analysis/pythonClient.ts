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

            process.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            process.stderr.on('data', (data) => {
                const stderrData = data.toString();
                stderr += stderrData;
                // Parse stats from stderr if present
                if (stderrData.includes('[STATS]')) {
                    const statsMatch = stderrData.match(/Scanned (\d+) Python files, found inheritance in (\d+) files/);
                    if (statsMatch) {
                        this.indexingStats.totalScanned = parseInt(statsMatch[1], 10);
                        this.indexingStats.filesWithInheritance = parseInt(statsMatch[2], 10);
                        logger.info('Indexing statistics', { 
                            totalScanned: this.indexingStats.totalScanned, 
                            filesWithInheritance: this.indexingStats.filesWithInheritance 
                        });
                    }
                }
            });

            process.on('close', (code) => {
                logger.debug('Python process closed', { code, stdoutLength: stdout.length, stderrLength: stderr.length });
                
                if (code !== 0) {
                    logger.error('Python analyzer failed', { code, stderr });
                    reject(new Error(`Python analyzer exited with code ${code}: ${stderr}`));
                    return;
                }

                try {
                    const result = JSON.parse(stdout);
                    const fileCount = Object.keys(result).length;
                    logger.info('Workspace analysis completed', { 
                        fileCount,
                        stats: stderr.includes('[STATS]') ? stderr.match(/\[STATS\].*/)?.[0] : undefined
                    });
                    resolve(result as InheritanceIndex);
                } catch (error) {
                    logger.error('Failed to parse analyzer output', { error, stdout: stdout.substring(0, 500) });
                    reject(new Error(`Failed to parse analyzer output: ${error}`));
                }
            });

            process.on('error', (error) => {
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
                stderr += data.toString();
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
}

