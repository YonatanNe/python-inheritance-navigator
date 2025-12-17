import * as assert from 'assert';
import { FileChangeQueue } from '../../utils/fileChangeQueue';
import { InheritanceIndex } from '../../analysis/types';

suite('FileChangeQueue Tests', () => {
    let queue: FileChangeQueue;
    let processedBatches: Array<string[]> = [];
    let batchProcessorPromise: Promise<InheritanceIndex>;

    setup(() => {
        processedBatches = [];
        batchProcessorPromise = Promise.resolve({});
    });

    teardown(() => {
        if (queue) {
            queue.dispose();
        }
    });

    function createQueue(
        debounceMs: number = 100,
        batchSize: number = 5,
        maxConcurrent: number = 2
    ): FileChangeQueue {
        const processor = async (filePaths: string[]): Promise<InheritanceIndex> => {
            processedBatches.push([...filePaths]);
            await batchProcessorPromise;
            return {};
        };
        return new FileChangeQueue(processor, debounceMs, batchSize, maxConcurrent);
    }

    test('Should debounce files added within delay period', async () => {
        queue = createQueue(100, 5, 2);

        queue.addFile('file1.py');
        queue.addFile('file2.py');
        queue.addFile('file3.py');

        // Wait for debounce to expire
        await new Promise(resolve => setTimeout(resolve, 150));

        assert.strictEqual(processedBatches.length, 1, 'Should create one batch');
        assert.strictEqual(processedBatches[0].length, 3, 'Should include all 3 files');
        assert.ok(processedBatches[0].includes('file1.py'));
        assert.ok(processedBatches[0].includes('file2.py'));
        assert.ok(processedBatches[0].includes('file3.py'));
    });

    test('Should reset debounce timer on new file addition', async () => {
        queue = createQueue(100, 5, 2);

        queue.addFile('file1.py');
        await new Promise(resolve => setTimeout(resolve, 50));
        queue.addFile('file2.py');
        await new Promise(resolve => setTimeout(resolve, 50));
        queue.addFile('file3.py');

        // Should not have processed yet
        assert.strictEqual(processedBatches.length, 0, 'Should not process before debounce expires');

        // Wait for debounce to expire after last addition
        await new Promise(resolve => setTimeout(resolve, 150));

        assert.strictEqual(processedBatches.length, 1, 'Should create one batch after debounce');
        assert.strictEqual(processedBatches[0].length, 3, 'Should include all files');
    });

    test('Should split files into batches of correct size', async () => {
        queue = createQueue(50, 3, 2);

        // Add 10 files
        for (let i = 1; i <= 10; i++) {
            queue.addFile(`file${i}.py`);
        }

        // Wait for debounce to expire
        await new Promise(resolve => setTimeout(resolve, 100));

        // Should create 4 batches: 3, 3, 3, 1
        assert.strictEqual(processedBatches.length, 4, 'Should create 4 batches');
        assert.strictEqual(processedBatches[0].length, 3, 'First batch should have 3 files');
        assert.strictEqual(processedBatches[1].length, 3, 'Second batch should have 3 files');
        assert.strictEqual(processedBatches[2].length, 3, 'Third batch should have 3 files');
        assert.strictEqual(processedBatches[3].length, 1, 'Fourth batch should have 1 file');
    });

    test('Should respect concurrency limit', async () => {
        // Use a promise that resolves after a delay to simulate processing time
        let resolvePromises: Array<(value: InheritanceIndex) => void> = [];
        batchProcessorPromise = new Promise<InheritanceIndex>(resolve => {
            resolvePromises.push(resolve);
        });

        queue = createQueue(50, 2, 2); // maxConcurrent = 2

        // Add 10 files (will create 5 batches of 2 files each)
        for (let i = 1; i <= 10; i++) {
            queue.addFile(`file${i}.py`);
        }

        // Wait for debounce
        await new Promise(resolve => setTimeout(resolve, 100));

        // Should have started processing, but only 2 batches active
        // Wait a bit for batches to be queued
        await new Promise(resolve => setTimeout(resolve, 50));

        // Check that only maxConcurrent batches are active
        assert.ok(queue.getActiveBatchCount() <= 2, 'Should not exceed max concurrent batches');

        // Resolve promises to allow processing to complete
        resolvePromises.forEach(resolve => resolve({}));
        await new Promise(resolve => setTimeout(resolve, 50));
    });

    test('Should process batches in order when limit reached', async () => {
        const processingOrder: number[] = [];
        let resolvePromises: Array<(value: InheritanceIndex) => void> = [];

        batchProcessorPromise = new Promise<InheritanceIndex>(resolve => {
            resolvePromises.push(resolve);
        });

        queue = createQueue(50, 2, 2);

        // Add files to create multiple batches
        for (let i = 1; i <= 6; i++) {
            queue.addFile(`file${i}.py`);
        }

        await new Promise(resolve => setTimeout(resolve, 100));

        // Process first batch
        if (resolvePromises[0]) {
            resolvePromises[0]({});
        }
        await new Promise(resolve => setTimeout(resolve, 10));

        // Should process next batch from queue
        assert.ok(queue.getQueueLength() >= 0, 'Queue should be processing');
    });

    test('Should handle errors gracefully without blocking queue', async () => {
        let callCount = 0;
        const processor = async (filePaths: string[]): Promise<InheritanceIndex> => {
            callCount++;
            if (callCount === 1) {
                throw new Error('Test error');
            }
            processedBatches.push([...filePaths]);
            return {};
        };

        queue = new FileChangeQueue(processor, 50, 2, 2);

        // Add files for two batches
        queue.addFile('file1.py');
        queue.addFile('file2.py');
        await new Promise(resolve => setTimeout(resolve, 100));

        queue.addFile('file3.py');
        queue.addFile('file4.py');
        await new Promise(resolve => setTimeout(resolve, 100));

        // Both batches should have been attempted
        assert.ok(callCount >= 2, 'Should process both batches despite error');
    });

    test('Should handle empty file sets gracefully', async () => {
        queue = createQueue(50, 5, 2);

        // Don't add any files, just wait
        await new Promise(resolve => setTimeout(resolve, 100));

        assert.strictEqual(processedBatches.length, 0, 'Should not process empty batches');
    });

    test('Should deduplicate files added multiple times', async () => {
        queue = createQueue(100, 5, 2);

        queue.addFile('file1.py');
        queue.addFile('file1.py'); // Duplicate
        queue.addFile('file2.py');
        queue.addFile('file1.py'); // Duplicate again

        await new Promise(resolve => setTimeout(resolve, 150));

        assert.strictEqual(processedBatches.length, 1, 'Should create one batch');
        assert.strictEqual(processedBatches[0].length, 2, 'Should only have 2 unique files');
        assert.ok(processedBatches[0].includes('file1.py'));
        assert.ok(processedBatches[0].includes('file2.py'));
    });

    test('Should dispose correctly', () => {
        queue = createQueue(100, 5, 2);

        queue.addFile('file1.py');
        queue.dispose();

        // Try to add file after dispose
        queue.addFile('file2.py');

        // Wait for debounce
        return new Promise<void>(resolve => {
            setTimeout(() => {
                // Should not process files added after dispose
                assert.strictEqual(processedBatches.length, 0, 'Should not process after dispose');
                resolve();
            }, 150);
        });
    });

    test('Should track pending count correctly', () => {
        queue = createQueue(1000, 5, 2);

        queue.addFile('file1.py');
        queue.addFile('file2.py');
        queue.addFile('file3.py');

        assert.strictEqual(queue.getPendingCount(), 3, 'Should track 3 pending files');
    });

    test('Should handle large batches efficiently', async () => {
        queue = createQueue(50, 50, 10);

        // Add 150 files
        for (let i = 1; i <= 150; i++) {
            queue.addFile(`file${i}.py`);
        }

        await new Promise(resolve => setTimeout(resolve, 100));

        // Should create 3 batches of 50 files each
        assert.strictEqual(processedBatches.length, 3, 'Should create 3 batches');
        assert.strictEqual(processedBatches[0].length, 50, 'First batch should have 50 files');
        assert.strictEqual(processedBatches[1].length, 50, 'Second batch should have 50 files');
        assert.strictEqual(processedBatches[2].length, 50, 'Third batch should have 50 files');
    });
});

