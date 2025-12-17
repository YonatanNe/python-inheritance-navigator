import * as vscode from 'vscode';
import * as path from 'path';

export interface BatchInfo {
    id: number;
    fileCount: number;
    startTime: number;
    files?: string[];
}

export interface BatchCompletion {
    id: number;
    fileCount: number;
    resultFileCount: number;
    duration: number;
    timestamp: number;
}

export class BatchProgressDisplay {
    private outputChannel: vscode.OutputChannel;
    private activeBatches: Map<number, BatchInfo> = new Map();
    private recentCompletions: BatchCompletion[] = [];
    private batchIdCounter: number = 0;
    private totalFilesProcessed: number = 0;
    private totalFilesWithInheritance: number = 0;
    private totalBatchTime: number = 0;
    private pendingFiles: number = 0;
    private queuedBatches: number = 0;
    private maxRecentCompletions: number = 5;
    private refreshTimer: NodeJS.Timeout | null = null;
    private refreshDebounceMs: number = 200; // Debounce refresh calls by 200ms
    private needsRefresh: boolean = false;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Python Inheritance Navigator - Batch Status');
    }

    updateQueueStatus(pendingFiles: number, queuedBatches: number, activeBatchCount: number): void {
        this.pendingFiles = pendingFiles;
        this.queuedBatches = queuedBatches;
        this.scheduleRefresh();
    }

    startBatch(fileCount: number, files?: string[]): number {
        const batchId = ++this.batchIdCounter;
        this.activeBatches.set(batchId, {
            id: batchId,
            fileCount,
            startTime: Date.now(),
            files: files?.slice(0, 3) // Show first 3 files as preview
        });
        this.refresh(); // Immediate refresh for batch start (important event)
        return batchId;
    }

    completeBatch(batchId: number, resultFileCount: number): void {
        const batch = this.activeBatches.get(batchId);
        if (!batch) {
            return;
        }

        const duration = Date.now() - batch.startTime;
        this.totalFilesProcessed += batch.fileCount;
        this.totalFilesWithInheritance += resultFileCount;
        this.totalBatchTime += duration;

        const completion: BatchCompletion = {
            id: batchId,
            fileCount: batch.fileCount,
            resultFileCount,
            duration,
            timestamp: Date.now()
        };

        this.recentCompletions.unshift(completion);
        if (this.recentCompletions.length > this.maxRecentCompletions) {
            this.recentCompletions.pop();
        }

        this.activeBatches.delete(batchId);
        this.refresh(); // Immediate refresh for batch completion (important event)
    }

    show(): void {
        this.outputChannel.show(true);
    }

    hide(): void {
        this.outputChannel.hide();
    }

    clear(): void {
        this.outputChannel.clear();
        this.activeBatches.clear();
        this.recentCompletions = [];
        this.batchIdCounter = 0;
        this.totalFilesProcessed = 0;
        this.totalFilesWithInheritance = 0;
        this.totalBatchTime = 0;
    }

    dispose(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.outputChannel.dispose();
    }

    private scheduleRefresh(): void {
        // Mark that refresh is needed
        this.needsRefresh = true;

        // If timer already exists, don't create a new one (debouncing)
        if (this.refreshTimer) {
            return;
        }

        // Schedule refresh after debounce delay
        this.refreshTimer = setTimeout(() => {
            if (this.needsRefresh) {
                this.refresh();
                this.needsRefresh = false;
            }
            this.refreshTimer = null;
        }, this.refreshDebounceMs);
    }

    private refresh(): void {
        const lines: string[] = [];
        
        // Header
        lines.push('Python Inheritance Navigator - Batch Processing Status');
        lines.push('═'.repeat(60));
        lines.push('');

        // Queue Status
        lines.push('Queue Status:');
        lines.push(`  Pending files: ${this.pendingFiles}`);
        lines.push(`  Queued batches: ${this.queuedBatches}`);
        lines.push(`  Active batches: ${this.activeBatches.size}`);
        lines.push('');

        // Active Batches
        if (this.activeBatches.size > 0) {
            lines.push('Active Batches:');
            const batches = Array.from(this.activeBatches.values()).sort((a, b) => a.id - b.id);
            
            for (const batch of batches) {
                const elapsed = Date.now() - batch.startTime;
                const elapsedSeconds = (elapsed / 1000).toFixed(1);
                const startTime = new Date(batch.startTime).toLocaleTimeString();
                
                // Create progress bar (20 characters)
                const progressBar = this.createProgressBar(100, 20); // 100% since we don't have per-file progress
                
                lines.push(`  [Batch ${batch.id}] ${progressBar} ${batch.fileCount} files`);
                
                if (batch.files && batch.files.length > 0) {
                    const fileNames = batch.files.map(f => path.basename(f)).join(', ');
                    const moreFiles = batch.fileCount > batch.files.length ? ` (+${batch.fileCount - batch.files.length} more)` : '';
                    lines.push(`    Files: ${fileNames}${moreFiles}`);
                }
                
                lines.push(`    Started: ${startTime} | Elapsed: ${elapsedSeconds}s`);
                lines.push('');
            }
        } else {
            lines.push('Active Batches: None');
            lines.push('');
        }

        // Recent Completions
        if (this.recentCompletions.length > 0) {
            lines.push('Recent Completions:');
            for (const completion of this.recentCompletions) {
                const durationSeconds = (completion.duration / 1000).toFixed(1);
                const timestamp = new Date(completion.timestamp).toLocaleTimeString();
                lines.push(`  ✓ Batch ${completion.id}: ${completion.fileCount} files → ${completion.resultFileCount} with inheritance (${durationSeconds}s) [${timestamp}]`);
            }
            lines.push('');
        }

        // Statistics
        if (this.totalFilesProcessed > 0) {
            lines.push('Statistics:');
            lines.push(`  Total files processed: ${this.totalFilesProcessed}`);
            lines.push(`  Files with inheritance: ${this.totalFilesWithInheritance}`);
            const avgBatchTime = this.recentCompletions.length > 0
                ? (this.recentCompletions.reduce((sum, c) => sum + c.duration, 0) / this.recentCompletions.length / 1000).toFixed(1)
                : '0.0';
            lines.push(`  Average batch time: ${avgBatchTime}s`);
            lines.push('');
        }

        // Footer
        lines.push('═'.repeat(60));
        lines.push(`Last updated: ${new Date().toLocaleTimeString()}`);

        // Update output channel
        this.outputChannel.clear();
        this.outputChannel.append(lines.join('\n'));
    }

    private createProgressBar(percentage: number, length: number): string {
        const filled = Math.floor((percentage / 100) * length);
        const empty = length - filled;
        return '█'.repeat(filled) + '░'.repeat(empty);
    }
}

