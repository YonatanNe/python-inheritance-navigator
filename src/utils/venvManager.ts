import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger';

const execAsync = promisify(exec);

/**
 * Manages the extension's private Python virtual environment
 */
export class VenvManager {
    private venvPath: string;
    private venvPythonPath: string;
    private requirementsPath: string;
    private systemPythonPath: string;

    constructor(storagePath: string, extensionPath: string) {
        this.venvPath = path.join(storagePath, 'venv');
        this.venvPythonPath = this.getVenvPythonPath();
        this.requirementsPath = path.join(extensionPath, 'python', 'requirements.txt');
        this.systemPythonPath = this.findSystemPython();
    }

    private getVenvPythonPath(): string {
        // Use 'python' on Windows, 'python3' on Unix
        const pythonExecutable = process.platform === 'win32' ? 'python.exe' : 'python';
        return path.join(this.venvPath, process.platform === 'win32' ? 'Scripts' : 'bin', pythonExecutable);
    }

    private findSystemPython(): string {
        // Try common Python executable names
        const candidates = process.platform === 'win32' 
            ? ['python', 'python3', 'py']
            : ['python3', 'python'];
        
        // For now, default to python3 (will be checked at runtime)
        return 'python3';
    }

    /**
     * Ensures the venv exists and is set up with required dependencies
     * Shows progress notification if venv needs to be created
     */
    async ensureVenv(): Promise<string> {
        // Fast path: venv already exists
        if (fs.existsSync(this.venvPythonPath)) {
            logger.info('Using existing extension venv', { venvPythonPath: this.venvPythonPath });
            return this.venvPythonPath;
        }

        // Slow path: create venv (show progress)
        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Python Inheritance Navigator',
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: 'Initializing extension...' });
            
            try {
                // Create venv directory if it doesn't exist
                const venvDir = path.dirname(this.venvPath);
                if (!fs.existsSync(venvDir)) {
                    fs.mkdirSync(venvDir, { recursive: true });
                }

                // Find system Python
                const systemPython = await this.findAvailablePython();
                if (!systemPython) {
                    throw new Error('Could not find Python 3.6+ executable. Please install Python 3.6 or higher.');
                }

                logger.info('Creating venv', { systemPython, venvPath: this.venvPath });

                // Create venv
                progress.report({ increment: 10, message: 'Initializing extension...' });
                await this.createVenv(systemPython);
                
                progress.report({ increment: 30, message: 'Initializing extension...' });

                // Install dependencies
                progress.report({ increment: 40, message: 'Initializing extension...' });
                await this.installDependencies();
                
                progress.report({ increment: 90, message: 'Initializing extension...' });

                // Verify installation
                await this.verifyVenv();
                
                progress.report({ increment: 100, message: 'Initializing extension...' });
                
                logger.info('Venv setup completed', { venvPythonPath: this.venvPythonPath });
                return this.venvPythonPath;
            } catch (error) {
                logger.error('Failed to setup venv', error);
                throw error;
            }
        });
    }

    private async findAvailablePython(): Promise<string | null> {
        const candidates = process.platform === 'win32' 
            ? ['python', 'python3', 'py']
            : ['python3', 'python'];

        for (const candidate of candidates) {
            try {
                const { stdout } = await execAsync(`${candidate} --version`);
                // Check if version is 3.6 or higher
                const versionMatch = stdout.match(/Python (\d+)\.(\d+)/);
                if (versionMatch) {
                    const major = parseInt(versionMatch[1], 10);
                    const minor = parseInt(versionMatch[2], 10);
                    if (major === 3 && minor >= 6) {
                        logger.info('Found suitable Python', { candidate, version: stdout.trim() });
                        return candidate;
                    }
                }
            } catch (error) {
                // Try next candidate
                continue;
            }
        }

        return null;
    }

    private async createVenv(pythonExecutable: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            logger.info('Creating virtual environment', { pythonExecutable, venvPath: this.venvPath });
            
            const venvProcess = spawn(pythonExecutable, ['-m', 'venv', this.venvPath], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stderr = '';

            venvProcess.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            venvProcess.on('close', (code: number | null) => {
                if (code !== 0) {
                    logger.error('Failed to create venv', { code, stderr });
                    reject(new Error(`Failed to create virtual environment: ${stderr}`));
                    return;
                }
                logger.info('Venv created successfully');
                resolve();
            });

            venvProcess.on('error', (error: Error) => {
                logger.error('Failed to spawn venv creation process', error);
                reject(new Error(`Failed to create virtual environment: ${error.message}`));
            });
        });
    }

    private async installDependencies(): Promise<void> {
        if (!fs.existsSync(this.requirementsPath)) {
            throw new Error(`Requirements file not found: ${this.requirementsPath}`);
        }

        return new Promise<void>((resolve, reject) => {
            logger.info('Installing dependencies', { requirementsPath: this.requirementsPath });
            
            // Use pip from the venv
            const pipPath = process.platform === 'win32'
                ? path.join(this.venvPath, 'Scripts', 'pip')
                : path.join(this.venvPath, 'bin', 'pip');

            const pipProcess = spawn(pipPath, ['install', '--quiet', '--disable-pip-version-check', '-r', this.requirementsPath], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            pipProcess.stdout.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            pipProcess.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            pipProcess.on('close', (code: number | null) => {
                if (code !== 0) {
                    logger.error('Failed to install dependencies', { code, stdout, stderr });
                    reject(new Error(`Failed to install dependencies: ${stderr || stdout}`));
                    return;
                }
                logger.info('Dependencies installed successfully');
                resolve();
            });

            pipProcess.on('error', (error: Error) => {
                logger.error('Failed to spawn pip install process', error);
                reject(new Error(`Failed to install dependencies: ${error.message}`));
            });
        });
    }

    private async verifyVenv(): Promise<void> {
        // Verify that required packages are installed
        return new Promise<void>((resolve, reject) => {
            logger.info('Verifying venv installation');
            
            const verifyProcess = spawn(this.venvPythonPath, ['-c', 'import mrols; import jedi; import parso'], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stderr = '';

            verifyProcess.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            verifyProcess.on('close', (code: number | null) => {
                if (code !== 0) {
                    logger.error('Venv verification failed', { stderr });
                    reject(new Error(`Venv verification failed: Required packages not installed. ${stderr}`));
                    return;
                }
                logger.info('Venv verification successful');
                resolve();
            });

            verifyProcess.on('error', (error: Error) => {
                logger.error('Failed to verify venv', error);
                reject(new Error(`Failed to verify venv: ${error.message}`));
            });
        });
    }

    /**
     * Gets the Python path for the venv (does not ensure it exists)
     */
    getPythonPath(): string {
        return this.venvPythonPath;
    }

    /**
     * Checks if the venv exists
     */
    venvExists(): boolean {
        return fs.existsSync(this.venvPythonPath);
    }
}

