import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'tdd',
        color: true
    });

    const testsRoot = path.resolve(__dirname, '..');

    return new Promise((c, e) => {
        try {
            const testFiles = findTestFiles(testsRoot);
            testFiles.forEach((f: string) => mocha.addFile(path.resolve(testsRoot, f)));

            mocha.run((failures: number) => {
                if (failures > 0) {
                    e(new Error(`${failures} test(s) failed.`));
                } else {
                    c();
                }
            });
        } catch (err) {
            console.error(err);
            e(err);
        }
    });
}

function findTestFiles(dir: string): string[] {
    const files: string[] = [];
    
    function walk(currentDir: string) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
                files.push(path.relative(dir, fullPath));
            }
        }
    }
    
    walk(dir);
    return files;
}

