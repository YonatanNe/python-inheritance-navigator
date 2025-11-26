import * as vscode from 'vscode';
import { InheritanceIndexManager } from './index';
import { logger } from './utils/logger';

export class InheritanceCodeLensProvider implements vscode.CodeLensProvider {
    private indexManager: InheritanceIndexManager;
    private onDidChangeCodeLensesEmitter: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this.onDidChangeCodeLensesEmitter.event;

    constructor(indexManager: InheritanceIndexManager) {
        this.indexManager = indexManager;
    }

    async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        const config = vscode.workspace.getConfiguration('pythonInheritance');
        const enableCodeLens = config.get<boolean>('enableCodeLens', true);
        const showBaseMethods = config.get<boolean>('showBaseMethods', true);
        const showOverrides = config.get<boolean>('showOverrides', true);

        if (!enableCodeLens || document.languageId !== 'python') {
            return [];
        }

        // Wait a bit for index to be ready if it's still initializing
        if (this.indexManager.isIndexing()) {
            logger.debug('Index still initializing, waiting...', { file: document.uri.fsPath });
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        const codeLenses: vscode.CodeLens[] = [];
        const filePath = document.uri.fsPath;

        const classMethodMap = this._extractClassMethods(document);
        const classDefinitions = this._extractClassDefinitions(document);
        logger.debug('Extracted class methods', { file: filePath, classes: Object.keys(classMethodMap) });

        // Add CodeLens for class definitions showing inheritance
        for (const classDef of classDefinitions) {
            const classInheritance = this.indexManager.getClassInheritance(filePath, classDef.name, classDef.line);
            logger.debug('Class inheritance check', { 
                file: filePath, 
                class: classDef.name, 
                line: classDef.line,
                hasInheritance: !!classInheritance,
                baseClasses: classInheritance?.baseClasses.length || 0,
                subClasses: classInheritance?.subClasses.length || 0
            });
            
            if (classInheritance && (classInheritance.baseClasses.length > 0 || classInheritance.subClasses.length > 0)) {
                const range = new vscode.Range(
                    classDef.line - 1,
                    classDef.column,
                    classDef.line - 1,
                    classDef.column + classDef.name.length
                );

                if (showBaseMethods && classInheritance.baseClasses.length > 0) {
                    // Show all base classes, joined with " | "
                    const baseClassesLabel = classInheritance.baseClasses.join(' | ');
                    
                    // Get base class locations from index (synchronous lookup)
                    const baseClassLocations = classInheritance.baseClasses.map((baseClass) => {
                        const location = this.indexManager.findClassDefinitionSync(baseClass);
                        if (location && location.line > 0) {
                            return {
                                file_path: location.filePath,
                                class_name: baseClass,
                                line: location.line,
                                column: location.column,
                                end_line: location.line,
                                end_column: location.column,
                                name: baseClass
                            };
                        }
                        // Fallback if not found - will trigger search in command handler
                        return {
                            file_path: location?.filePath || '',
                            class_name: baseClass,
                            line: 0,
                            column: 0,
                            end_line: 0,
                            end_column: 0,
                            name: baseClass
                        };
                    });
                    
                    const codeLens = new vscode.CodeLens(range, {
                        title: `Inherits from: ${baseClassesLabel}`,
                        command: 'pythonInheritance.goToBase',
                        arguments: [baseClassLocations]
                    });
                    codeLenses.push(codeLens);
                    logger.debug('Added class CodeLens for base', { class: classDef.name, baseClasses: classInheritance.baseClasses });
                }

                if (showOverrides && classInheritance.subClasses.length > 0) {
                    const codeLens = new vscode.CodeLens(range, {
                        title: `Extended by (${classInheritance.subClasses.length})`,
                        command: 'pythonInheritance.goToOverrides',
                        arguments: [classInheritance.subClasses.map(cls => ({ file_path: filePath, class_name: cls, line: 0, column: 0, end_line: 0, end_column: 0, name: cls }))]
                    });
                    codeLenses.push(codeLens);
                    logger.debug('Added class CodeLens for subclasses', { class: classDef.name, subClasses: classInheritance.subClasses.length });
                }
            }
        }

        // Add CodeLens for methods
        for (const [className, methods] of Object.entries(classMethodMap)) {
            for (const method of methods) {
                const relationship = this.indexManager.getRelationshipsForMethod(
                    filePath,
                    className,
                    method.name,
                    method.line
                );

                if (!relationship) {
                    logger.debug('No relationship found', { 
                        file: filePath, 
                        class: className, 
                        method: method.name 
                    });
                    continue;
                }

                logger.debug('Found relationship', { 
                    file: filePath, 
                    class: className, 
                    method: method.name,
                    baseCount: relationship.base_methods.length,
                    overrideCount: relationship.override_methods.length
                });

                const range = new vscode.Range(
                    method.line - 1,
                    method.column,
                    method.line - 1,
                    method.column + method.name.length
                );

                if (showBaseMethods && relationship.base_methods.length > 0) {
                    const baseMethod = relationship.base_methods[0];
                    const baseLabel = baseMethod.class_name
                        ? `${baseMethod.class_name}.${baseMethod.name}`
                        : baseMethod.name;
                    
                    const codeLens = new vscode.CodeLens(range, {
                        title: `Go to Base: ${baseLabel}`,
                        command: 'pythonInheritance.goToBase',
                        arguments: [baseMethod]
                    });
                    codeLenses.push(codeLens);
                }

                if (showOverrides && relationship.override_methods.length > 0) {
                    const overrideCount = relationship.override_methods.length;
                    const codeLens = new vscode.CodeLens(range, {
                        title: `Go to Overrides (${overrideCount})`,
                        command: 'pythonInheritance.goToOverrides',
                        arguments: [relationship.override_methods]
                    });
                    codeLenses.push(codeLens);
                }
            }
        }

        return codeLenses;
    }

    private _extractClassDefinitions(document: vscode.TextDocument): Array<{ name: string; line: number; column: number }> {
        const classDefinitions: Array<{ name: string; line: number; column: number }> = [];

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const text = line.text;
            const trimmed = text.trim();

            if (trimmed.startsWith('class ')) {
                const classMatch = trimmed.match(/class\s+(\w+)/);
                if (classMatch) {
                    classDefinitions.push({
                        name: classMatch[1],
                        line: i + 1,
                        column: line.firstNonWhitespaceCharacterIndex
                    });
                }
            }
        }

        return classDefinitions;
    }

    private _extractClassMethods(document: vscode.TextDocument): { [className: string]: Array<{ name: string; line: number; column: number }> } {
        const classMethodMap: { [className: string]: Array<{ name: string; line: number; column: number }> } = {};
        let currentClass: string | null = null;
        let classIndent = 0;

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const text = line.text;
            const trimmed = text.trim();

            if (trimmed.startsWith('class ')) {
                const classMatch = trimmed.match(/class\s+(\w+)/);
                if (classMatch) {
                    currentClass = classMatch[1];
                    classIndent = line.firstNonWhitespaceCharacterIndex;
                }
            } else if (trimmed.startsWith('def ') || trimmed.startsWith('async def ')) {
                if (currentClass && line.firstNonWhitespaceCharacterIndex > classIndent) {
                    const methodMatch = trimmed.match(/(?:async\s+)?def\s+(\w+)/);
                    if (methodMatch) {
                        if (!classMethodMap[currentClass]) {
                            classMethodMap[currentClass] = [];
                        }
                        classMethodMap[currentClass].push({
                            name: methodMatch[1],
                            line: i + 1,
                            column: line.firstNonWhitespaceCharacterIndex
                        });
                    }
                }
            } else if (trimmed && line.firstNonWhitespaceCharacterIndex <= classIndent && currentClass) {
                currentClass = null;
            }
        }

        return classMethodMap;
    }

    refresh(): void {
        this.onDidChangeCodeLensesEmitter.fire();
    }
}

