import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { InheritanceIndexManager } from './index';
import { MethodLocation } from './analysis/types';
import { VenvManager } from './utils/venvManager';
import { logger } from './utils/logger';

export class CommandHandlers {
    private indexManager: InheritanceIndexManager;
    private venvManager: VenvManager;

    constructor(indexManager: InheritanceIndexManager, venvManager: VenvManager) {
        this.indexManager = indexManager;
        this.venvManager = venvManager;
    }

    async goToBaseMethod(method: MethodLocation | MethodLocation[]): Promise<void> {
        // Handle array of base classes (from class inheritance CodeLens)
        if (Array.isArray(method)) {
            if (method.length === 0) {
                vscode.window.showErrorMessage('Base class location not available');
                return;
            }
            
            // Filter out invalid entries (empty file_path or line 0)
            const validMethods = method.filter(m => m.file_path && m.line > 0);
            
            logger.debug('goToBaseMethod called with array', { 
                totalMethods: method.length, 
                validMethods: validMethods.length,
                methods: method.map(m => ({ class: m.class_name, file: m.file_path, line: m.line }))
            });
            
            if (validMethods.length === 0) {
                // Try to find class definitions for all base classes
                const foundLocations: MethodLocation[] = [];
                for (const m of method) {
                    const className = m.class_name || m.name;
                    if (className) {
                        try {
                            // If we have a file_path but line is 0, try searching in that file first
                            if (m.file_path && !m.line) {
                                try {
                                    const uri = vscode.Uri.file(m.file_path);
                                    const document = await vscode.workspace.openTextDocument(uri);
                                    for (let i = 0; i < document.lineCount; i++) {
                                        const line = document.lineAt(i);
                                        const trimmed = line.text.trim();
                                        const match = trimmed.match(new RegExp(`^class\\s+${className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:(]`));
                                        if (match) {
                                            foundLocations.push({
                                                file_path: m.file_path,
                                                class_name: className,
                                                name: className,
                                                line: i + 1,
                                                column: line.firstNonWhitespaceCharacterIndex,
                                                end_line: i + 1,
                                                end_column: line.firstNonWhitespaceCharacterIndex
                                            });
                                            break;
                                        }
                                    }
                                } catch (error) {
                                    console.error(`Error searching file ${m.file_path} for class ${className}:`, error);
                                }
                            }
                            
                            // If still not found, try async lookup
                            if (foundLocations.length === 0 || foundLocations[foundLocations.length - 1].class_name !== className) {
                                const found = await this.indexManager.findClassDefinition(className);
                                if (found && found.line > 0) {
                                    foundLocations.push({
                                        file_path: found.filePath,
                                        class_name: className,
                                        name: className,
                                        line: found.line,
                                        column: found.column,
                                        end_line: found.line,
                                        end_column: found.column
                                    });
                                }
                            }
                        } catch (error) {
                            console.error(`Error finding class ${className}:`, error);
                        }
                    }
                }
                
                if (foundLocations.length === 0) {
                    const classNames = method.map(m => m.class_name || m.name).filter(Boolean).join(', ');
                    vscode.window.showWarningMessage(`Could not locate base class definition${classNames ? ` (${classNames})` : ''}. The class may not be indexed yet.`);
                    return;
                }
                
                if (foundLocations.length === 1) {
                    await this.goToBaseMethod(foundLocations[0]);
                    return;
                }
                
                // Show quick pick for multiple found locations
                const items = foundLocations.map(m => ({
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
            
            if (validMethods.length === 1) {
                await this.goToBaseMethod(validMethods[0]);
                return;
            }
            
            // Show quick pick for multiple base classes
            const items = validMethods.map(m => ({
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
                try {
                    const found = await this.indexManager.findClassDefinition(className);
                    if (found && found.line > 0) {
                        await this.navigateToLocation(found.filePath, found.line, found.column);
                        return;
                    }
                } catch (error) {
                    console.error(`Error finding class ${className}:`, error);
                }
            }
            if (!method.file_path) {
                vscode.window.showWarningMessage('Base method location not available. The class may not be indexed yet.');
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
            vscode.window.showWarningMessage('Base method location not available. The class may not be indexed yet.');
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
        // The indexManager.refreshIndex() already shows notifications, so just call it directly
        await this.indexManager.refreshIndex();
    }

    async cleanAndReindex(): Promise<void> {
        // The indexManager.cleanAndReindex() already shows notifications, so just call it directly
        await this.indexManager.cleanAndReindex();
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

    async removeExtensionVenv(): Promise<void> {
        const result = await vscode.window.showWarningMessage(
            'Are you sure you want to remove the extension\'s virtual environment? This will delete the Python venv and all installed packages. The extension will recreate it automatically when needed.',
            { modal: true },
            'Remove Venv',
            'Cancel'
        );

        if (result === 'Remove Venv') {
            try {
                this.venvManager.removeVenv();
                vscode.window.showInformationMessage('Extension virtual environment removed successfully. It will be recreated automatically when needed.');
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to remove virtual environment: ${errorMessage}`);
                logger.error('Failed to remove extension venv', error);
            }
        }
    }
}

