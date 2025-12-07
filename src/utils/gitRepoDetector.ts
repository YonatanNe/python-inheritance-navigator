import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

const gitIgnoreDirs = new Set([
    '.git',
    'node_modules',
    '.venv',
    'venv',
    'env',
    '.env',
    'dist',
    'build',
    'out',
    '.vscode',
    '.idea',
    '__pycache__'
]);

export function countGitRepos(root: string, maxDepth = 3, maxRepos = 5): number {
    let count = 0;
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

    while (stack.length > 0) {
        const { dir, depth } = stack.pop() as { dir: string; depth: number };
        if (depth > maxDepth || count >= maxRepos) {
            continue;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (error) {
            logger.debug('Failed to read directory while counting Git repos', { dir, error });
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            if (entry.name === '.git') {
                count += 1;
                if (count >= maxRepos) {
                    return count;
                }
                continue;
            }

            if (gitIgnoreDirs.has(entry.name)) {
                continue;
            }

            stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        }
    }

    return count;
}

