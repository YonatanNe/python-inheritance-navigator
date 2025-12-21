import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { InheritanceIndexManager } from './index';
import { MethodLocation } from './analysis/types';

export class CommandHandlers {
    private indexManager: InheritanceIndexManager;

    constructor(indexManager: InheritanceIndexManager) {
        this.indexManager = indexManager;
    }

    async goToBaseMethod(method: MethodLocation | MethodLocation[]): Promise<void> {
        // Handle array of base classes (from class inheritance CodeLens)
        if (Array.isArray(method)) {
            if (method.length === 0) {
                vscode.window.showErrorMessage('Base class location not available');
                return;
            }
            
            if (method.length === 1) {
                await this.goToBaseMethod(method[0]);
                return;
            }
            
            // Show quick pick for multiple base classes
            const items = method.map(m => ({
                label: m.class_name || m.name,
                description: m.file_path ? path.relative(
                    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
                    m.file_path
                ) : 'Location unknown',
                detail: m.file_path ? `${m.file_path}:${m.line || 0}` : 'Location unknown',
                method: m
            }));
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select base class to navigate to'
            });
            
            if (selected) {
                await this.goToBaseMethod(selected.method);
            }
            return;
        }
        
        // Handle single method/class location
        if (!method.file_path || method.line === 0) {
            // Try to find the class definition in the workspace
            const className = method.class_name || method.name;
            if (className) {
                const found = await this.indexManager.findClassDefinition(className);
                if (found && found.line > 0) {
                    await this.navigateToLocation(found.filePath, found.line, found.column);
                    return;
                }
            }
            if (!method.file_path) {
                vscode.window.showErrorMessage('Base method location not available');
                return;
            }
            // If we have file_path but line is 0, search for the class in the file
            if (method.file_path && method.line === 0) {
                const className = method.class_name || method.name;
                if (className) {
                    try {
                        const uri = vscode.Uri.file(method.file_path);
                        const document = await vscode.workspace.openTextDocument(uri);
                        for (let i = 0; i < document.lineCount; i++) {
                            const line = document.lineAt(i);
                            const trimmed = line.text.trim();
                            const match = trimmed.match(new RegExp(`^class\\s+${className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:(]`));
                            if (match) {
                                await this.navigateToLocation(method.file_path, i + 1, line.firstNonWhitespaceCharacterIndex);
                                return;
                            }
                        }
                    } catch (error) {
                        console.error('Error searching for class:', error);
                    }
                }
            }
            vscode.window.showErrorMessage('Base method location not available');
            return;
        }

        await this.navigateToLocation(method.file_path, method.line, method.column);
    }
    
    async navigateToLocation(filePath: string, line: number, column: number): Promise<void> {
        const uri = vscode.Uri.file(filePath);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);

        const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, column));
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }

    async goToOverrides(overrideMethods: MethodLocation[]): Promise<void> {
        if (overrideMethods.length === 0) {
            vscode.window.showInformationMessage('No overrides found');
            return;
        }

        if (overrideMethods.length === 1) {
            await this.goToBaseMethod(overrideMethods[0]);
            return;
        }

        const items = overrideMethods.map(method => ({
            label: `${method.class_name}.${method.name}`,
            description: path.relative(
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
                method.file_path
            ),
            detail: `${method.file_path}:${method.line}`,
            method: method
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select override to navigate to'
        });

        if (selected) {
            await this.goToBaseMethod(selected.method);
        }
    }

    async refreshIndex(): Promise<void> {
        vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Refreshing inheritance index...',
                cancellable: false
            },
            async () => {
                await this.indexManager.refreshIndex();
                vscode.window.showInformationMessage('Inheritance index refreshed');
            }
        );
    }

    async cleanAndReindex(): Promise<void> {
        vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Cleaning and reindexing inheritance...',
                cancellable: false
            },
            async () => {
                await this.indexManager.cleanAndReindex();
                vscode.window.showInformationMessage('Inheritance index cleaned and rebuilt');
            }
        );
    }

    async openIndexFile(): Promise<void> {
        const indexFilePath = this.indexManager.getIndexFilePath();
        if (!indexFilePath) {
            vscode.window.showWarningMessage('Index file path not available');
            return;
        }

        if (!fs.existsSync(indexFilePath)) {
            vscode.window.showWarningMessage('Index file does not exist yet. Run indexing first.');
            return;
        }

        const uri = vscode.Uri.file(indexFilePath);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        vscode.window.showInformationMessage(`Index file opened: ${indexFilePath}`);
    }

    async clearAllIndexes(): Promise<void> {
        const result = await vscode.window.showWarningMessage(
            'Are you sure you want to clear all indexes? This will delete the saved index file and clear the in-memory index.',
            { modal: true },
            'Clear All',
            'Cancel'
        );

        if (result === 'Clear All') {
            await this.indexManager.clearAllIndexes();
        }
    }
}

