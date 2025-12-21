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
     * Checks if the venv already exists
     */
    venvExists(): boolean {
        return fs.existsSync(this.venvPythonPath);
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

        // Slow path: create venv (no notification - handled at extension level)
        try {
            // Create venv directory if it doesn't exist
            const venvDir = path.dirname(this.venvPath);
            if (!fs.existsSync(venvDir)) {
                fs.mkdirSync(venvDir, { recursive: true });
            }

            // Find system Python
            const systemPython = await this.findAvailablePython();
            if (!systemPython) {
                const platform = process.platform;
                let installInstructions = 'Please install Python 3.10 or 3.11 (required for match statement support).';

                if (platform === 'darwin') {
                    installInstructions += '\n\nmacOS options:\n• Homebrew: brew install python@3.11 (or python@3.10)\n• pyenv: pyenv install 3.11 && pyenv global 3.11\n• Download from: https://www.python.org/downloads/';
                } else if (platform === 'win32') {
                    installInstructions += '\n\nWindows options:\n• Download from: https://www.python.org/downloads/\n• Chocolatey: choco install python311\n• Microsoft Store: Search for "Python 3.11"';
                } else {
                    installInstructions += '\n\nLinux options:\n• Ubuntu/Debian: sudo apt install python3.11\n• CentOS/RHEL: sudo yum install python311\n• Arch: sudo pacman -S python311\n• Or download from: https://www.python.org/downloads/';
                }

                throw new Error(`Could not find Python 3.10 or 3.11 executable.\n\n${installInstructions}`);
            }

            logger.info('Creating venv', { systemPython, venvPath: this.venvPath });

            // Create venv
            await this.createVenv(systemPython);

            // Install dependencies
            await this.installDependencies();

            // Verify installation
            await this.verifyVenv();

            logger.info('Venv setup completed', { venvPythonPath: this.venvPythonPath });

            return this.venvPythonPath;
        } catch (error) {
            logger.error('Failed to setup venv', error);
            throw error;
        }
    }

    private async findAvailablePython(): Promise<string | null> {
        // Build list of candidates: specific versions first, then generic ones
        // Support Python 3.10 and 3.11 (required for match statements)
        const specificVersions = ['python3.11', 'python3.10'];
        const genericCandidates = process.platform === 'win32'
            ? ['python', 'python3', 'py']
            : ['python3', 'python'];
        
        const candidates = [...specificVersions, ...genericCandidates];

        // Collect all available Python executables with their versions
        const availablePythons: Array<{candidate: string, version: string, major: number, minor: number}> = [];

        for (const candidate of candidates) {
            try {
                const { stdout } = await execAsync(`${candidate} --version`);
                // Check if version is 3.10 or 3.11 (required for match statements)
                const versionMatch = stdout.match(/Python (\d+)\.(\d+)/);
                if (versionMatch) {
                    const major = parseInt(versionMatch[1], 10);
                    const minor = parseInt(versionMatch[2], 10);
                    // Require 3.10 or 3.11 (supports match statements)
                    if (major === 3 && (minor === 10 || minor === 11)) {
                        availablePythons.push({
                            candidate,
                            version: stdout.trim(),
                            major,
                            minor
                        });
                    }
                }
            } catch (error) {
                // Try next candidate
                continue;
            }
        }

        if (availablePythons.length === 0) {
            return null;
        }

        // Sort by version (highest first) and return the best one
        availablePythons.sort((a, b) => {
            if (a.major !== b.major) return b.major - a.major;
            return b.minor - a.minor;
        });

        const bestPython = availablePythons[0];
        logger.info('Found suitable Python versions, using the highest available', {
            selected: bestPython.candidate,
            version: bestPython.version,
            allAvailable: availablePythons.map(p => `${p.candidate} (${p.version})`)
        });

        return bestPython.candidate;
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

            // Install python-mro-language-server first (with its dependencies)
            // Then force upgrade jedi and parso to versions compatible with Python 3.11
            // Using --ignore-installed to override version constraints from python-mro-language-server
            const installSteps = [
                ['install', '--quiet', '--disable-pip-version-check', 'python-mro-language-server'],
                ['install', '--quiet', '--disable-pip-version-check', '--upgrade', '--ignore-installed', 'jedi>=0.19.1', 'parso>=0.8.5']
            ];

            let currentStep = 0;

            const runNextStep = () => {
                if (currentStep >= installSteps.length) {
                    logger.info('Dependencies installed successfully');
                    resolve();
                    return;
                }

                const args = installSteps[currentStep];
                logger.debug('Running pip install step', { step: currentStep + 1, args: args.slice(1) });
                
                const pipProcess = spawn(pipPath, args, {
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
                        logger.error('Failed to install dependencies', { step: currentStep + 1, code, stdout, stderr });
                        reject(new Error(`Failed to install dependencies at step ${currentStep + 1}: ${stderr || stdout}`));
                        return;
                    }
                    currentStep++;
                    runNextStep();
                });

                pipProcess.on('error', (error: Error) => {
                    logger.error('Failed to spawn pip install process', { step: currentStep + 1, error });
                    reject(new Error(`Failed to install dependencies at step ${currentStep + 1}: ${error.message}`));
                });
            };

            runNextStep();
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
     * Removes the extension's virtual environment
     */
    removeVenv(): void {
        if (fs.existsSync(this.venvPath)) {
            logger.info('Removing extension venv', { venvPath: this.venvPath });
            try {
                // Use rimraf-style recursive deletion
                const rimraf = (dirPath: string) => {
                    if (fs.existsSync(dirPath)) {
                        const files = fs.readdirSync(dirPath);
                        for (const file of files) {
                            const curPath = path.join(dirPath, file);
                            if (fs.lstatSync(curPath).isDirectory()) {
                                rimraf(curPath);
                            } else {
                                fs.unlinkSync(curPath);
                            }
                        }
                        fs.rmdirSync(dirPath);
                    }
                };
                rimraf(this.venvPath);
                logger.info('Extension venv removed successfully');
            } catch (error) {
                logger.error('Failed to remove extension venv', error);
                throw new Error(`Failed to remove virtual environment: ${error}`);
            }
        } else {
            logger.info('Extension venv does not exist, nothing to remove');
        }
    }
}

