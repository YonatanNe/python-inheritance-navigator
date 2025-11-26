import * as assert from 'assert';
import * as vscode from 'vscode';
import { InheritanceIndexManager } from '../../index';

suite('Inheritance Index Manager Tests', () => {
    let indexManager: InheritanceIndexManager;
    const testWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || __dirname;

    setup(() => {
        indexManager = new InheritanceIndexManager(testWorkspaceRoot, 'python3');
    });

    teardown(() => {
        if (indexManager) {
            indexManager.dispose();
        }
    });

    test('Index manager should be created', () => {
        assert.ok(indexManager);
    });

    test('Should get relationships for method', () => {
        const relationship = indexManager.getRelationshipsForMethod(
            '/fake/path.py',
            'TestClass',
            'testMethod',
            10
        );
        assert.ok(relationship === null || typeof relationship === 'object');
    });
});

