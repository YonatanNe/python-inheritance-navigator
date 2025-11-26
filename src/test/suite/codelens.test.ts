import * as assert from 'assert';
import * as vscode from 'vscode';
import { InheritanceCodeLensProvider } from '../../codelens';
import { InheritanceIndexManager } from '../../index';

suite('CodeLens Provider Tests', () => {
    let indexManager: InheritanceIndexManager;
    let codeLensProvider: InheritanceCodeLensProvider;
    const testWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || __dirname;

    setup(() => {
        indexManager = new InheritanceIndexManager(testWorkspaceRoot, 'python3');
        codeLensProvider = new InheritanceCodeLensProvider(indexManager);
    });

    teardown(() => {
        if (indexManager) {
            indexManager.dispose();
        }
    });

    test('CodeLens provider should be created', () => {
        assert.ok(codeLensProvider);
    });

    test('Should provide empty CodeLens for non-Python files', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'plaintext',
            content: 'This is not Python code'
        });
        const codeLenses = await codeLensProvider.provideCodeLenses(document);
        assert.ok(Array.isArray(codeLenses));
    });
});

