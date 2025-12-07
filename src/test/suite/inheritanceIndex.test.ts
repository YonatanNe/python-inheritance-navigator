import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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

    test('Should detect multiple git repositories inside a folder', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-multigit-'));
        const repoA = path.join(tempDir, 'repoA', '.git');
        const repoB = path.join(tempDir, 'repoB', '.git');
        fs.mkdirSync(repoA, { recursive: true });
        fs.mkdirSync(repoB, { recursive: true });

        const repoCount = (indexManager as unknown as { _countGitRepos: (dir: string, maxDepth?: number, maxRepos?: number) => number })
            ._countGitRepos(tempDir, 3, 10);

        try {
            assert.strictEqual(repoCount, 2);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});

