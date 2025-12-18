import { InheritanceIndex } from '../analysis/types';
import { logger } from './logger';
import { BatchProgressDisplay } from './batchProgressDisplay';

export type BatchProcessor = (filePaths: string[]) => Promise<InheritanceIndex>;

export class FileChangeQueue {
    private pendingFiles: Set<string> = new Set();
    private batchQueue: Array<string[]> = [];
    private activeBatchCount: number = 0;
    private debounceTimer: NodeJS.Timeout | null = null;
    private isDisposed: boolean = false;
    private progressDisplay: BatchProgressDisplay;

    constructor(
        private batchProcessor: BatchProcessor,
        private debounceMs: number = 3000,
        private batchSize: number = 50,
        private maxConcurrent: number = 10,
        progressDisplay?: BatchProgressDisplay
    ) {
        this.progressDisplay = progressDisplay || new BatchProgressDisplay();
        logger.debug('FileChangeQueue initialized', {
            debounceMs,
            batchSize,
            maxConcurrent
        });
    }

    addFile(filePath: string): void {
        if (this.isDisposed) {
            logger.warn('FileChangeQueue is disposed, ignoring file', { filePath });
            return;
        }

        // Add to pending set (automatic deduplication)
        this.pendingFiles.add(filePath);

        // Reset debounce timer
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        // Start new debounce timer
        this.debounceTimer = setTimeout(() => {
            this.processBatch();
        }, this.debounceMs);

        // Update progress display
        this.progressDisplay.updateQueueStatus(
            this.pendingFiles.size,
            this.batchQueue.length,
            this.activeBatchCount
        );

        logger.debug('File added to queue', {
            filePath,
            pendingCount: this.pendingFiles.size
        });
    }

    private async processBatch(): Promise<void> {
        if (this.isDisposed) {
            return;
        }

        // Clear the timer
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }

        // Get all pending files
        const filesToProcess = Array.from(this.pendingFiles);
        this.pendingFiles.clear();

        if (filesToProcess.length === 0) {
            logger.debug('No files to process after debounce');
            return;
        }

        logger.info('Processing batch', {
            fileCount: filesToProcess.length
        });

        // Split into batches
        const batches: Array<string[]> = [];
        for (let i = 0; i < filesToProcess.length; i += this.batchSize) {
            batches.push(filesToProcess.slice(i, i + this.batchSize));
        }

        logger.debug('Created batches', {
            totalFiles: filesToProcess.length,
            batchCount: batches.length,
            batchSize: this.batchSize
        });

        // Add batches to queue
        this.batchQueue.push(...batches);

        // Update progress display
        this.progressDisplay.updateQueueStatus(
            this.pendingFiles.size,
            this.batchQueue.length,
            this.activeBatchCount
        );

        // Process queue
        this.processQueue();
    }

    private async processQueue(): Promise<void> {
        // Process batches up to concurrency limit
        while (
            !this.isDisposed &&
            this.batchQueue.length > 0 &&
            this.activeBatchCount < this.maxConcurrent
        ) {
            const batch = this.batchQueue.shift();
            if (!batch || batch.length === 0) {
                continue;
            }

            this.activeBatchCount++;
            
            // Start batch tracking
            const batchId = this.progressDisplay.startBatch(batch.length, batch);
            
            logger.debug('Starting batch processing', {
                batchSize: batch.length,
                activeBatches: this.activeBatchCount,
                queueLength: this.batchQueue.length,
                batchId
            });

            // Update progress display
            this.progressDisplay.updateQueueStatus(
                this.pendingFiles.size,
                this.batchQueue.length,
                this.activeBatchCount
            );

            // Process batch asynchronously (don't await - allows concurrent processing)
            this.processBatchAsync(batch, batchId).finally(() => {
            this.activeBatchCount--;
                
                logger.debug('Batch processing completed', {
                    batchSize: batch.length,
                    activeBatches: this.activeBatchCount,
                    queueLength: this.batchQueue.length,
                    batchId
                });

                // Update progress display
                this.progressDisplay.updateQueueStatus(
                    this.pendingFiles.size,
                    this.batchQueue.length,
                    this.activeBatchCount
                );

                // Process next batch in queue
                this.processQueue();
            });
        }
    }

    private async processBatchAsync(batch: string[], batchId: number): Promise<void> {
        try {
            logger.debug('Processing batch', {
                fileCount: batch.length,
                files: batch.slice(0, 5), // Log first 5 files
                batchId
            });

            const result = await this.batchProcessor(batch);
            const resultFileCount = Object.keys(result).length;
            
            // Report completion to progress display
            this.progressDisplay.completeBatch(batchId, resultFileCount);
            
            logger.debug('Batch processed successfully', {
                fileCount: batch.length,
                resultFileCount,
                batchId
            });
        } catch (error) {
            // Report completion even on error (with 0 results)
            this.progressDisplay.completeBatch(batchId, 0);
            
            logger.error('Batch processing failed', {
                error,
                fileCount: batch.length,
                files: batch.slice(0, 5), // Log first 5 files for debugging
                batchId
            });
            // Don't throw - continue processing other batches
        }
    }

    dispose(): void {
        if (this.isDisposed) {
            return;
        }

        this.isDisposed = true;

        // Clear debounce timer
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }

        // Clear pending files and queue
        this.pendingFiles.clear();
        this.batchQueue = [];

        // Clear progress display (but don't dispose it - it might be shared)
        this.progressDisplay.clear();

        logger.debug('FileChangeQueue disposed');
    }

    getPendingCount(): number {
        return this.pendingFiles.size;
    }

    getQueueLength(): number {
        return this.batchQueue.length;
    }

    getActiveBatchCount(): number {
        return this.activeBatchCount;
    }
}

