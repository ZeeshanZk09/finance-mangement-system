declare module 'clamdjs' {
  export interface ScanResult {
    is_infected: boolean;
    viruses?: string[];
  }

  export interface ClamDScanner {
    scanFile(filePath: string): Promise<ScanResult>;
  }

  export function createScanner(host: string, port: number): ClamDScanner;
  const _default: { createScanner: typeof createScanner };
  export default _default;
}
