import type { TarType, DirectoryContent } from './types';
import fs from 'fs';
import path from 'path';
import { TarTypes } from './types';
import * as errors from './errors';

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
  if (filePath.length < 1 || filePath.length > 255) {
    throw new errors.ErrorVirtualTarInvalidFileName(
      'The file name must be longer than 1 character and shorter than 255 characters',
    );
  }

  const size = type === TarTypes.FILE ? stat.size : 0;
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

  header.write(filePath.slice(0, 99).padEnd(100, '\0'), 0, 100, 'utf8');
  header.write(stat.mode.toString(8).padStart(7, '0') + '\0', 100, 12, 'ascii');
  header.write(stat.uid.toString(8).padStart(7, '0') + '\0', 108, 12, 'ascii');
  header.write(stat.gid.toString(8).padStart(7, '0') + '\0', 116, 12, 'ascii');
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
  header.write(filePath.slice(100).padEnd(155, '\0'), 345, 155, 'utf8');

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

/**
 * Traverse a directory recursively and yield file entries.
 */
async function* walkDirectory(
  baseDir: string,
  relativePath: string = '',
): AsyncGenerator<DirectoryContent> {
  const entries = await fs.promises.readdir(path.join(baseDir, relativePath));

  // Sort the entries lexicographically
  for (const entry of entries.sort()) {
    const fullPath = path.join(baseDir, relativePath, entry);
    const stat = await fs.promises.stat(fullPath);
    const tarPath = path.join(relativePath, entry);

    if (stat.isDirectory()) {
      yield { path: tarPath + '/', stat: stat, type: TarTypes.DIRECTORY };
      yield* walkDirectory(baseDir, path.join(relativePath, entry));
    } else if (stat.isFile()) {
      yield { path: tarPath, stat: stat, type: TarTypes.FILE };
    }
  }
}

async function* createTar(baseDir: string): AsyncGenerator<Buffer, void, void> {
  for await (const entry of walkDirectory(baseDir)) {
    // Create header
    yield createHeader(entry.path, entry.stat, entry.type);

    if (entry.type === TarTypes.FILE) {
      // Get file contents
      yield* readFile(path.join(baseDir, entry.path));
    }
  }

  // End-of-archive marker - two 512-byte null blocks
  yield Buffer.alloc(BLOCK_SIZE, 0);
  yield Buffer.alloc(BLOCK_SIZE, 0);
}

export { createHeader, readFile, createTar };
