import * as vscode from 'vscode';

export class FileWatcher {
    private watcher: vscode.FileSystemWatcher | null = null;
    private onChangeCallbacks: ((uri: vscode.Uri) => void)[] = [];

    constructor(pattern: vscode.GlobPattern) {
        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.watcher.onDidChange((uri) => {
            if (uri.fsPath.endsWith('.py')) {
                this.onChangeCallbacks.forEach(callback => callback(uri));
            }
        });
        this.watcher.onDidCreate((uri) => {
            if (uri.fsPath.endsWith('.py')) {
                this.onChangeCallbacks.forEach(callback => callback(uri));
            }
        });
        this.watcher.onDidDelete((uri) => {
            if (uri.fsPath.endsWith('.py')) {
                this.onChangeCallbacks.forEach(callback => callback(uri));
            }
        });
    }

    onDidChange(callback: (uri: vscode.Uri) => void): void {
        this.onChangeCallbacks.push(callback);
    }
    
    onDidCreate(callback: (uri: vscode.Uri) => void): void {
        this.onChangeCallbacks.push(callback);
    }

    dispose(): void {
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = null;
        }
    }
}

