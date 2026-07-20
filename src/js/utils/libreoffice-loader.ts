/**
 * LibreOffice WASM Converter Wrapper
 *
 * Uses @matbee/libreoffice-converter package for document conversion.
 * Handles progress tracking and provides simpler API.
 */

import { WorkerBrowserConverter } from '@matbee/libreoffice-converter/browser';
import type { InputFormat } from '@matbee/libreoffice-converter/browser';

const LIBREOFFICE_LOCAL_PATH =
  import.meta.env.VITE_WASM_LIBREOFFICE_URL ||
  import.meta.env.BASE_URL + 'libreoffice-wasm/';

export interface LoadProgress {
  phase: 'loading' | 'initializing' | 'converting' | 'complete' | 'ready';
  percent: number;
  message: string;
}

export type ProgressCallback = (progress: LoadProgress) => void;

// Cross-Origin-Embedder-Policy (required on this site for
// self.crossOriginIsolated / SharedArrayBuffer) blocks `new Worker(url)`
// when `url` is cross-origin -- even when the response carries a correct
// Cross-Origin-Resource-Policy header. This is a stricter, separate check
// from ordinary CORS/fetch and is often called the "framed resource"
// restriction. A plain fetch() to the same URL is NOT blocked by it.
//
// The workaround: fetch the script ourselves (same-origin fetch is exempt),
// wrap the bytes in a Blob, and hand `new Worker()` a `blob:` URL instead of
// the original cross-origin one. `blob:` URLs are always treated as
// same-origin to the page that created them, so the framed-resource check
// never triggers. This does not touch the 3 data files that load via
// fetch()/locateFile() (soffice.wasm.gz, soffice.data.gz,
// soffice.worker.js) -- only scripts passed to `new Worker()` need this.
async function fetchAsBlobUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch worker script for blob conversion: ${url} (status ${response.status})`
    );
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

// Singleton for converter instance
let converterInstance: LibreOfficeConverter | null = null;

export class LibreOfficeConverter {
  private converter: WorkerBrowserConverter | null = null;
  private initialized = false;
  private initializing = false;
  private basePath: string;
  // Blob URLs created for cross-origin worker scripts (see initialize()).
  // Kept here so destroy() can revoke them; must NOT be revoked earlier,
  // since Emscripten's pthread runtime keeps reusing the soffice.js blob URL
  // for every new worker thread it spawns throughout the converter's life.
  private createdBlobUrls: string[] = [];

  constructor(basePath?: string) {
    this.basePath = basePath || LIBREOFFICE_LOCAL_PATH;
  }

  async initialize(onProgress?: ProgressCallback): Promise<void> {
    if (this.initialized) return;

    if (this.initializing) {
      while (this.initializing) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return;
    }

    this.initializing = true;
    let progressCallback = onProgress; // Store original callback

    try {
      progressCallback?.({
        phase: 'loading',
        percent: 0,
        message: 'Loading conversion engine...',
      });

      // sofficeJs and browserWorkerJs are both passed to `new Worker()`
      // internally (by @matbee/libreoffice-converter, and by Emscripten's
      // pthread runtime reusing sofficeJs for each worker thread it spawns).
      // Convert both to same-origin blob: URLs first -- see fetchAsBlobUrl()
      // for why. The other 3 files (wasm/data/worker-loader) are fetched
      // normally via locateFile() and don't need this treatment.
      const [sofficeJsBlobUrl, browserWorkerJsBlobUrl] = await Promise.all([
        fetchAsBlobUrl(`${this.basePath}soffice.js`),
        fetchAsBlobUrl(`${this.basePath}browser.worker.global.js`),
      ]);
      this.createdBlobUrls.push(sofficeJsBlobUrl, browserWorkerJsBlobUrl);

      this.converter = new WorkerBrowserConverter({
        sofficeJs: sofficeJsBlobUrl,
        sofficeWasm: `${this.basePath}soffice.wasm.gz`,
        sofficeData: `${this.basePath}soffice.data.gz`,
        sofficeWorkerJs: `${this.basePath}soffice.worker.js`,
        browserWorkerJs: browserWorkerJsBlobUrl,
        verbose: false,
        onProgress: (info: {
          phase: string;
          percent: number;
          message: string;
        }) => {
          if (progressCallback && !this.initialized) {
            const simplifiedMessage = `Loading conversion engine (${Math.round(info.percent)}%)...`;
            progressCallback({
              phase: info.phase as LoadProgress['phase'],
              percent: info.percent,
              message: simplifiedMessage,
            });
          }
        },
        onReady: () => {
          console.log('[LibreOffice] Ready!');
        },
        onError: (error: Error) => {
          console.error('[LibreOffice] Error:', error);
        },
      });

      await this.converter.initialize();
      this.initialized = true;

      // Call completion message
      progressCallback?.({
        phase: 'ready',
        percent: 100,
        message: 'Conversion engine ready!',
      });

      // Null out the callback to prevent any late-firing progress updates
      progressCallback = undefined;
    } finally {
      this.initializing = false;
    }
  }

  isReady(): boolean {
    return this.initialized && this.converter !== null;
  }

  async convertToPdf(file: File): Promise<Blob> {
    if (!this.converter) {
      throw new Error('Converter not initialized');
    }

    console.log(`[LibreOffice] Converting ${file.name} to PDF...`);
    console.log(
      `[LibreOffice] File type: ${file.type}, Size: ${file.size} bytes`
    );

    try {
      console.log(`[LibreOffice] Reading file as ArrayBuffer...`);
      const arrayBuffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      console.log(`[LibreOffice] File loaded, ${uint8Array.length} bytes`);

      console.log(`[LibreOffice] Calling converter.convert() with buffer...`);
      const startTime = Date.now();

      // Detect input format - critical for CSV to apply import filters
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      console.log(`[LibreOffice] Detected format from extension: ${ext}`);

      const result = await this.converter.convert(
        uint8Array,
        {
          outputFormat: 'pdf',
          inputFormat: ext as InputFormat,
        },
        file.name
      );

      const duration = Date.now() - startTime;
      console.log(
        `[LibreOffice] Conversion complete! Duration: ${duration}ms, Size: ${result.data.length} bytes`
      );

      // Create a copy to avoid SharedArrayBuffer type issues
      const data = new Uint8Array(result.data);
      return new Blob([data], { type: result.mimeType });
    } catch (error) {
      console.error(`[LibreOffice] Conversion FAILED for ${file.name}:`, error);
      console.error(`[LibreOffice] Error details:`, {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  async wordToPdf(file: File): Promise<Blob> {
    return this.convertToPdf(file);
  }

  async pptToPdf(file: File): Promise<Blob> {
    return this.convertToPdf(file);
  }

  async excelToPdf(file: File): Promise<Blob> {
    return this.convertToPdf(file);
  }

  async destroy(): Promise<void> {
    if (this.converter) {
      await this.converter.destroy();
    }
    this.converter = null;
    this.initialized = false;

    // Safe to revoke now that the converter (and every pthread worker it
    // spawned, which kept reusing the soffice.js blob URL) is fully torn
    // down. Revoking any earlier would break in-flight worker creation.
    for (const url of this.createdBlobUrls) {
      URL.revokeObjectURL(url);
    }
    this.createdBlobUrls = [];
  }
}

export function getLibreOfficeConverter(
  basePath?: string
): LibreOfficeConverter {
  if (!converterInstance) {
    converterInstance = new LibreOfficeConverter(basePath);
  }
  return converterInstance;
}
