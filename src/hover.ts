import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { InheritanceIndexManager } from './index';
import { MethodLocation } from './analysis/types';
import { logger } from './utils/logger';

export class InheritanceHoverProvider implements vscode.HoverProvider {
    private indexManager: InheritanceIndexManager;

    constructor(indexManager: InheritanceIndexManager) {
        this.indexManager = indexManager;
    }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | null> {
        const config = vscode.workspace.getConfiguration('pythonInheritance');
        const enableHover = config.get<boolean>('enableHover', true);

        if (!enableHover || document.languageId !== 'python') {
            return null;
        }

        // Wait a bit for index to be ready if it's still initializing
        if (this.indexManager.isIndexing()) {
            return null;
        }

        const filePath = document.uri.fsPath;
        
        // Check a wider range of lines to catch codelens hover (codelens appears above the code)
        // Check current line, line above (for codelens), and a few lines below
        const checkLines = [
            position.line,      // Current line
            position.line - 1,  // Line above (where codelens might be)
            position.line + 1,  // Line below
            position.line + 2  // One more line below
        ].filter(lineNum => lineNum >= 0 && lineNum < document.lineCount);

        // Check if we're hovering over a method (check multiple lines for codelens support)
        for (const checkLine of checkLines) {
            const checkPosition = new vscode.Position(checkLine, position.character);
            const methodMatch = this._extractMethodAtPosition(document, checkPosition);
            if (methodMatch) {
                const line = checkLine + 1;
                const relationship = this.indexManager.getRelationshipsForMethod(
                    filePath,
                    methodMatch.className,
                    methodMatch.methodName,
                    line
                );

                if (relationship) {
                    const hoverContent = await this._buildMethodHoverContent(relationship, document);
                    if (hoverContent) {
                        return new vscode.Hover(hoverContent);
                    }
                }
            }
        }

        // Check if we're hovering over a class definition (check multiple lines for codelens support)
        for (const checkLine of checkLines) {
            const checkPosition = new vscode.Position(checkLine, position.character);
            const classMatch = this._extractClassAtPosition(document, checkPosition);
            if (classMatch) {
                const line = checkLine + 1;
                const classInheritance = this.indexManager.getClassInheritance(
                    filePath,
                    classMatch.className,
                    line
                );

                if (classInheritance && (classInheritance.baseClasses.length > 0 || classInheritance.subClasses.length > 0)) {
                    const hoverContent = await this._buildClassHoverContent(
                        classMatch.className,
                        classInheritance,
                        filePath
                    );
                    if (hoverContent) {
                        return new vscode.Hover(hoverContent);
                    }
                }
            }
        }

        return null;
    }

    private _extractMethodAtPosition(
        document: vscode.TextDocument,
        position: vscode.Position
    ): { className: string; methodName: string } | null {
        // Check current line and a few lines around it for method definition
        const checkLines = [position.line, position.line - 1, position.line + 1];
        
        for (const lineNum of checkLines) {
            if (lineNum < 0 || lineNum >= document.lineCount) {
                continue;
            }
            
            const line = document.lineAt(lineNum);
            const text = line.text;
            const trimmed = text.trim();

            // Check if we're on a method definition line
            if (!trimmed.startsWith('def ') && !trimmed.startsWith('async def ')) {
                continue;
            }

            const methodMatch = trimmed.match(/(?:async\s+)?def\s+(\w+)/);
            if (!methodMatch) {
                continue;
            }

            const methodName = methodMatch[1];
            const methodLine = lineNum;

            // Find the class this method belongs to
            let currentClass: string | null = null;
            let classIndent = 0;

            for (let i = methodLine - 1; i >= 0; i--) {
                const currentLine = document.lineAt(i);
                const currentText = currentLine.text.trim();

                if (currentText.startsWith('class ')) {
                    const classMatch = currentText.match(/class\s+(\w+)/);
                    if (classMatch) {
                        currentClass = classMatch[1];
                        classIndent = currentLine.firstNonWhitespaceCharacterIndex;
                        break;
                    }
                }

                // If we hit a line with less or equal indent that's not empty, we're out of the class
                if (currentText && currentLine.firstNonWhitespaceCharacterIndex <= classIndent) {
                    break;
                }
            }

            if (!currentClass) {
                continue;
            }

            // Verify the method is actually inside the class (indentation check)
            const methodIndent = line.firstNonWhitespaceCharacterIndex;
            if (methodIndent <= classIndent) {
                continue;
            }

            return { className: currentClass, methodName };
        }

        return null;
    }

    private _extractClassAtPosition(
        document: vscode.TextDocument,
        position: vscode.Position
    ): { className: string } | null {
        const line = document.lineAt(position.line);
        const text = line.text.trim();

        if (text.startsWith('class ')) {
            const classMatch = text.match(/class\s+(\w+)/);
            if (classMatch) {
                return { className: classMatch[1] };
            }
        }

        return null;
    }

    private async _buildMethodHoverContent(
        relationship: {
            method: MethodLocation;
            base_methods: MethodLocation[];
            override_methods: MethodLocation[];
        },
        currentDocument: vscode.TextDocument
    ): Promise<vscode.MarkdownString[]> {
        const contents: vscode.MarkdownString[] = [];
        const markdown = new vscode.MarkdownString();

        // Show base methods
        if (relationship.base_methods.length > 0) {
            markdown.appendMarkdown('### Base Methods\n\n');
            for (const baseMethod of relationship.base_methods) {
                const snippet = await this._getMethodSnippet(baseMethod);
                if (snippet) {
                    const filePath = path.relative(
                        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
                        baseMethod.file_path
                    );
                    const uri = vscode.Uri.file(baseMethod.file_path);
                    const commandUri = vscode.Uri.parse(`command:pythonInheritance.navigateToLocation?${encodeURIComponent(JSON.stringify([baseMethod.file_path, baseMethod.line, baseMethod.column]))}`);
                    const filePathUri = vscode.Uri.parse(`command:pythonInheritance.navigateToLocation?${encodeURIComponent(JSON.stringify([baseMethod.file_path, baseMethod.line, baseMethod.column]))}`);
                    markdown.appendMarkdown(`[**${baseMethod.class_name}.${baseMethod.name}**](${commandUri})`);
                    markdown.appendMarkdown(` [\`${filePath}:${baseMethod.line}\`](${filePathUri})`);
                    markdown.appendMarkdown(' *(Click to navigate)*\n\n');
                    markdown.appendCodeblock(snippet, 'python');
                    markdown.appendMarkdown('\n\n');
                }
            }
        }

        // Show override methods
        if (relationship.override_methods.length > 0) {
            markdown.appendMarkdown('### Override Methods\n\n');
            for (const overrideMethod of relationship.override_methods) {
                const snippet = await this._getMethodSnippet(overrideMethod);
                if (snippet) {
                    const filePath = path.relative(
                        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
                        overrideMethod.file_path
                    );
                    const commandUri = vscode.Uri.parse(`command:pythonInheritance.navigateToLocation?${encodeURIComponent(JSON.stringify([overrideMethod.file_path, overrideMethod.line, overrideMethod.column]))}`);
                    const filePathUri = vscode.Uri.parse(`command:pythonInheritance.navigateToLocation?${encodeURIComponent(JSON.stringify([overrideMethod.file_path, overrideMethod.line, overrideMethod.column]))}`);
                    markdown.appendMarkdown(`[**${overrideMethod.class_name}.${overrideMethod.name}**](${commandUri})`);
                    markdown.appendMarkdown(` [\`${filePath}:${overrideMethod.line}\`](${filePathUri})`);
                    markdown.appendMarkdown(' *(Click to navigate)*\n\n');
                    markdown.appendCodeblock(snippet, 'python');
                    markdown.appendMarkdown('\n\n');
                }
            }
        }

        if (markdown.value.trim()) {
            markdown.isTrusted = true;
            contents.push(markdown);
        }

        return contents;
    }

    private async _buildClassHoverContent(
        className: string,
        classInheritance: {
            baseClasses: string[];
            subClasses: string[];
        },
        currentFilePath: string
    ): Promise<vscode.MarkdownString[]> {
        const contents: vscode.MarkdownString[] = [];
        const markdown = new vscode.MarkdownString();

        // Show base classes
        if (classInheritance.baseClasses.length > 0) {
            markdown.appendMarkdown('### Base Classes\n\n');
            for (const baseClass of classInheritance.baseClasses) {
                const classLocation = this.indexManager.findClassDefinitionSync(baseClass);
                if (classLocation) {
                    const snippet = await this._getClassSnippet(classLocation);
                    if (snippet) {
                        const filePath = path.relative(
                            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
                            classLocation.filePath
                        );
                        const commandUri = vscode.Uri.parse(`command:pythonInheritance.navigateToLocation?${encodeURIComponent(JSON.stringify([classLocation.filePath, classLocation.line, classLocation.column || 0]))}`);
                        const filePathUri = vscode.Uri.parse(`command:pythonInheritance.navigateToLocation?${encodeURIComponent(JSON.stringify([classLocation.filePath, classLocation.line, classLocation.column || 0]))}`);
                        markdown.appendMarkdown(`[**${baseClass}**](${commandUri})`);
                        markdown.appendMarkdown(` [\`${filePath}:${classLocation.line}\`](${filePathUri})`);
                        markdown.appendMarkdown(' *(Click to navigate)*\n\n');
                        markdown.appendCodeblock(snippet, 'python');
                        markdown.appendMarkdown('\n\n');
                    }
                }
            }
        }

        // Show sub classes
        if (classInheritance.subClasses.length > 0) {
            markdown.appendMarkdown('### Sub Classes\n\n');
            for (const subClass of classInheritance.subClasses) {
                const classLocation = this.indexManager.findClassDefinitionSync(subClass);
                if (classLocation) {
                    const snippet = await this._getClassSnippet(classLocation);
                    if (snippet) {
                        const filePath = path.relative(
                            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
                            classLocation.filePath
                        );
                        const commandUri = vscode.Uri.parse(`command:pythonInheritance.navigateToLocation?${encodeURIComponent(JSON.stringify([classLocation.filePath, classLocation.line, classLocation.column || 0]))}`);
                        const filePathUri = vscode.Uri.parse(`command:pythonInheritance.navigateToLocation?${encodeURIComponent(JSON.stringify([classLocation.filePath, classLocation.line, classLocation.column || 0]))}`);
                        markdown.appendMarkdown(`[**${subClass}**](${commandUri})`);
                        markdown.appendMarkdown(` [\`${filePath}:${classLocation.line}\`](${filePathUri})`);
                        markdown.appendMarkdown(' *(Click to navigate)*\n\n');
                        markdown.appendCodeblock(snippet, 'python');
                        markdown.appendMarkdown('\n\n');
                    }
                }
            }
        }

        if (markdown.value.trim()) {
            markdown.isTrusted = true;
            contents.push(markdown);
        }

        return contents;
    }

    private async _getMethodSnippet(method: MethodLocation): Promise<string | null> {
        if (!method.file_path || !fs.existsSync(method.file_path)) {
            return null;
        }

        try {
            const uri = vscode.Uri.file(method.file_path);
            const document = await vscode.workspace.openTextDocument(uri);
            const startLine = Math.max(0, method.line - 1);
            const endLine = method.end_line > 0 ? Math.min(document.lineCount - 1, method.end_line - 1) : startLine + 10;

            // Find the actual method boundaries
            let methodStart = startLine;
            let methodEnd = endLine;

            // Find method start (def line)
            for (let i = startLine; i < document.lineCount; i++) {
                const line = document.lineAt(i);
                const trimmed = line.text.trim();
                if (trimmed.startsWith('def ') || trimmed.startsWith('async def ')) {
                    methodStart = i;
                    break;
                }
            }

            // Find method end (next def/class or dedent)
            const methodStartIndent = document.lineAt(methodStart).firstNonWhitespaceCharacterIndex;
            for (let i = methodStart + 1; i < document.lineCount; i++) {
                const line = document.lineAt(i);
                const lineIndent = line.firstNonWhitespaceCharacterIndex;
                const trimmed = line.text.trim();

                // Stop at next method, class, or dedent
                if (trimmed.startsWith('def ') || trimmed.startsWith('async def ') || trimmed.startsWith('class ')) {
                    methodEnd = i - 1;
                    break;
                }

                // Stop at dedent (but allow empty lines)
                if (trimmed && lineIndent <= methodStartIndent) {
                    methodEnd = i - 1;
                    break;
                }

                // Limit to 20 lines max
                if (i - methodStart > 20) {
                    methodEnd = i;
                    break;
                }
            }

            const lines: string[] = [];
            for (let i = methodStart; i <= methodEnd && i < document.lineCount; i++) {
                lines.push(document.lineAt(i).text);
            }

            return lines.join('\n');
        } catch (error) {
            logger.error('Failed to get method snippet', { error, method });
            return null;
        }
    }

    private async _getClassSnippet(classLocation: {
        filePath: string;
        line: number;
    }): Promise<string | null> {
        if (!classLocation.filePath || !fs.existsSync(classLocation.filePath)) {
            return null;
        }

        try {
            const uri = vscode.Uri.file(classLocation.filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            const startLine = Math.max(0, classLocation.line - 1);

            // Find class start
            let classStart = startLine;
            for (let i = startLine; i >= 0; i--) {
                const line = document.lineAt(i);
                const trimmed = line.text.trim();
                if (trimmed.startsWith('class ')) {
                    classStart = i;
                    break;
                }
            }

            // Find class end (next class or end of file)
            const classStartIndent = document.lineAt(classStart).firstNonWhitespaceCharacterIndex;
            let classEnd = classStart + 1;

            for (let i = classStart + 1; i < document.lineCount; i++) {
                const line = document.lineAt(i);
                const trimmed = line.text.trim();

                // Stop at next class
                if (trimmed.startsWith('class ')) {
                    classEnd = i - 1;
                    break;
                }

                // Stop at dedent (but allow empty lines and comments)
                if (trimmed && !trimmed.startsWith('#') && line.firstNonWhitespaceCharacterIndex <= classStartIndent) {
                    classEnd = i - 1;
                    break;
                }

                // Limit to 30 lines max
                if (i - classStart > 30) {
                    classEnd = i;
                    break;
                }
            }

            const lines: string[] = [];
            for (let i = classStart; i <= classEnd && i < document.lineCount; i++) {
                lines.push(document.lineAt(i).text);
            }

            return lines.join('\n');
        } catch (error) {
            logger.error('Failed to get class snippet', { error, classLocation });
            return null;
        }
    }
}

