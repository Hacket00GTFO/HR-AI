import mammoth from 'mammoth';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { DOCX_MIME, PDF_MIME } from './fileValidation.js';

export interface ExtractionResult {
    text: string;
    pageCount?: number;
}

/**
 * Extract plain text from a stored document.
 * PDF → pdf-parse, DOCX → mammoth. Throws on unreadable content so the
 * worker can mark the document failed.
 */
export async function extractText(buffer: Buffer, mime: string): Promise<ExtractionResult> {
    if (mime === PDF_MIME) {
        // pdf.js (bundled by pdf-parse) reads a Node Buffer's WHOLE underlying
        // ArrayBuffer, ignoring byteOffset — pooled Buffers (S3 SDK, multer)
        // carry unrelated bytes and fail with 'bad XRef entry'. A plain
        // Uint8Array view is bounded correctly, so always hand one over.
        const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const result = await pdfParse(data);
        return { text: result.text ?? '', pageCount: result.numpages };
    }
    if (mime === DOCX_MIME) {
        const result = await mammoth.extractRawText({ buffer });
        return { text: result.value ?? '' };
    }
    throw new Error(`Unsupported mime for extraction: ${mime}`);
}
