import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: ['--disable-extensions'],
            extensionTestsEnv: {
                KEEP_VSCODE_OPEN: 'true'
            }
        });
    } catch (err) {
        console.error('Failed to run tests:', err);
        console.log('\nVS Code will remain open for manual testing.');
        console.log('Close this window when done testing.');
        process.exit(1);
    }
}

main();

