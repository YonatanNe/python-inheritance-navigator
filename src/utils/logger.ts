import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class FileLogger {
    private logFile: string;
    private logStream: fs.WriteStream | null = null;
    private outputChannel: vscode.OutputChannel;

    constructor() {
        // Create VS Code output channel
        this.outputChannel = vscode.window.createOutputChannel('Python Inheritance Navigator');
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        let logDir: string;
        
        if (workspaceFolder) {
            logDir = path.join(workspaceFolder.uri.fsPath, '.vscode');
        } else {
            const extensionPath = vscode.extensions.getExtension('python-inheritance-navigator')?.extensionPath;
            logDir = extensionPath 
                ? path.join(extensionPath, '.vscode')
                : path.join(__dirname, '../../.vscode');
        }
        
        this.logFile = path.join(logDir, 'python-inheritance-navigator.log');
        this.initialize();
    }

    private initialize(): void {
        try {
            console.log('[Python Inheritance Navigator] Initializing logger...');
            console.log('[Python Inheritance Navigator] Log file path:', this.logFile);
            
            if (fs.existsSync(this.logFile)) {
                fs.unlinkSync(this.logFile);
                console.log('[Python Inheritance Navigator] Deleted existing log file');
            }
            
            const logDir = path.dirname(this.logFile);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
                console.log('[Python Inheritance Navigator] Created log directory:', logDir);
            }

            this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
            console.log('[Python Inheritance Navigator] Log file created successfully:', this.logFile);
            this.log('INFO', 'Logger initialized', { logFile: this.logFile });
        } catch (error) {
            console.error('[Python Inheritance Navigator] Failed to initialize logger:', error);
            console.error('[Python Inheritance Navigator] Error details:', {
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                logFile: this.logFile
            });
        }
    }

    private log(level: string, message: string, data?: any): void {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            message,
            ...(data && { data })
        };
        
        const logLine = JSON.stringify(logEntry) + '\n';
        
        // Format message for output channel
        const dataStr = data ? ' ' + JSON.stringify(data) : '';
        const outputLine = `[${timestamp}] [${level}] ${message}${dataStr}`;
        
        // Write to VS Code output channel (visible in Output panel)
        this.outputChannel.appendLine(outputLine);
        
        // Also write to console for debugging
        console.log(`[Python Inheritance Navigator] [${level}] ${message}`, data || '');
        
        // Write to file if stream is available
        if (this.logStream) {
            try {
                this.logStream.write(logLine);
            } catch (error) {
                console.error('[Python Inheritance Navigator] Failed to write to log file:', error);
            }
        }
    }

    info(message: string, data?: any): void {
        this.log('INFO', message, data);
    }

    error(message: string, error?: any): void {
        const errorData = error instanceof Error 
            ? { message: error.message, stack: error.stack, name: error.name }
            : error;
        this.log('ERROR', message, errorData);
    }

    warn(message: string, data?: any): void {
        this.log('WARN', message, data);
    }

    debug(message: string, data?: any): void {
        this.log('DEBUG', message, data);
    }

    showOutputChannel(): void {
        this.outputChannel.show(true);
    }

    dispose(): void {
        if (this.logStream) {
            this.logStream.end();
            this.logStream = null;
        }
        this.outputChannel.dispose();
    }
}

export const logger = new FileLogger();

