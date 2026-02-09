export interface FileData {
    filename: string;
    fileData: ArrayBuffer;
}

export interface FileStorage {
    upload(data: FileData): Promise<void>;
    delete(filename: string): void;
    getObjectUri(filename: string): string;
}
