import type { TarType } from './types';
import fs from 'fs';

/**
 * The size for each tar block. This is usually 512 bytes.
 */
const BLOCK_SIZE = 512;

function computeChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    sum += i >= 148 && i < 156 ? 32 : header[i]; // Fill checksum with spaces
  }
  return sum;
}

function createHeader(filePath: string, stat: fs.Stats, type: TarType): Buffer {
  const size = type === '0' ? stat.size : 0;

  const header = Buffer.alloc(BLOCK_SIZE, 0);

  // The TAR headers follow this structure
  // Start    Size    Description
  // ------------------------------
  // 0        100     File name (first 100 bytes)
  // 100      8       File permissions (null-padded octal)
  // 108      8       Owner UID (null-padded octal)
  // 116      8       Owner GID (null-padded octal)
  // 124      12      File size (null-padded octal, 0 for directories)
  // 136      12      Mtime (null-padded octal)
  // 148      8       Checksum (fill with ASCII spaces for computation)
  // 156      1       Type flag (0 for file, 5 for directory)
  // 157      100     File owner name (null-terminated ASCII/UTF-8)
  // 257      6       'ustar\0' (magic string)
  // 263      2       '00' (ustar version)
  // 265      32      Owner user name (null-terminated ASCII/UTF-8)
  // 297      32      Owner group name (null-terminated ASCII/UTF-8)
  // 329      8       Device major (unset in this implementation)
  // 337      8       Device minor (unset in this implementation)
  // 345      155     File name (last 155 bytes, total 255 bytes, null-padded)
  // 500      12      '\0' (unused)

  // FIXME: Assuming file path is under 100 characters long
  header.write(filePath, 0, 100, 'utf8');
  // File permissions name will be null
  // Owner uid will be null
  // Owner gid will be null
  header.write(size.toString(8).padStart(7, '0') + '\0', 124, 12, 'ascii');
  // Mtime will be null
  header.write('        ', 148, 8, 'ascii'); // Placeholder for checksum
  header.write(type, 156, 1, 'ascii');
  // File owner name will be null
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 2, 'ascii');
  // Owner user name will be null
  // Owner group name will be null
  // Device major will be null
  // Device minor will be null
  // Extended file name will be null

  // Updating with the new checksum
  const checksum = computeChecksum(header);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

  return header;
}

async function* readFile(filePath: string): AsyncGenerator<Buffer, void, void> {
  const fileHandle = await fs.promises.open(filePath, 'r');
  const buffer = Buffer.alloc(BLOCK_SIZE);
  let bytesRead = -1; // Initialisation value

  try {
    while (bytesRead !== 0) {
      buffer.fill(0);
      const result = await fileHandle.read(buffer, 0, BLOCK_SIZE, null);
      bytesRead = result.bytesRead;

      if (bytesRead === 0) break; // EOF reached
      if (bytesRead < 512) buffer.fill(0, bytesRead, BLOCK_SIZE);

      yield buffer;
    }
  } finally {
    await fileHandle.close();
  }
}

// TODO: change path from filepath to a basedir (plus get a fs)
async function* createTar(filePath: string): AsyncGenerator<Buffer, void, void> {
  // Create header
  const stat = await fs.promises.stat(filePath);
  yield createHeader(filePath, stat, '0');
  // Get file contents
  yield *readFile(filePath);
  // End-of-archive marker
  yield Buffer.alloc(BLOCK_SIZE, 0);
  yield Buffer.alloc(BLOCK_SIZE, 0);
}

async function writeArchive(inputFile: string, outputFile: string) {
  const fileHandle = await fs.promises.open(outputFile, 'w+');
  for await (const chunk of createTar(inputFile)) {
    await fileHandle.write(chunk);
  }
  await fileHandle.close();
}

export { createHeader, readFile, createTar, writeArchive };
