export type AppStatus = 'idle' | 'connecting' | 'listening' | 'processing' | 'error';

export interface TranscriptEntry {
    speaker: 'user' | 'model';
    text: string;
    timestamp: Date;
}
