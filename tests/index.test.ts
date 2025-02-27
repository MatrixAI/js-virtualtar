import type { FileType, DirectoryType } from './utils';
import path from 'path';
import { test } from '@fast-check/jest';
import { generateHeader, generateNullChunk } from '@/Generator';
import { EntryType } from '@/types';
import Parser from '@/Parser';
import * as tarUtils from '@/utils';
import * as tarConstants from '@/constants';
import * as utils from './utils';

describe('integration testing', () => {
  test.prop([utils.virtualFsArb])(
    'should archive and unarchive a virtual file system',
    (vfs) => {
      const blocks: Array<Uint8Array> = [];

      const generateArchive = (entry: FileType | DirectoryType) => {
        switch (entry.type) {
          case EntryType.FILE: {
            // Generate the header
            entry = entry as FileType;
            blocks.push(generateHeader(entry.path, entry.type, entry.stat));

            // Generate the data
            const encoder = new TextEncoder();
            let content = entry.content;
            do {
              const dataChunk = content.slice(0, tarConstants.BLOCK_SIZE);
              blocks.push(
                encoder.encode(dataChunk.padEnd(tarConstants.BLOCK_SIZE, '\0')),
              );
              content = content.slice(tarConstants.BLOCK_SIZE);
            } while (content.length > 0);
            break;
          }

          case EntryType.DIRECTORY: {
            // Generate the header
            entry = entry as DirectoryType;
            blocks.push(generateHeader(entry.path, entry.type, entry.stat));

            // Perform the same operation on all children
            for (const file of entry.children) {
              generateArchive(file);
            }
            break;
          }

          default:
            tarUtils.never('Invalid type');
        }
      };

      for (const entry of vfs) {
        generateArchive(entry);
      }
      blocks.push(generateNullChunk());
      blocks.push(generateNullChunk());

      // The tar archive should be inside the blocks array now. Each block is
      // a single chunk aligned to 512-byte. Now we can parse it and check if
      // the parsed virtual file system matches the input.

      const parser = new Parser();
      const decoder = new TextDecoder();
      const reconstructedVfs: Array<FileType | DirectoryType> = [];
      const pathStack: Map<string, any> = new Map();
      let currentEntry: FileType;

      for (const chunk of blocks) {
        const token = parser.write(chunk);
        if (token == null) continue;

        switch (token.type) {
          case 'header': {
            let parsedEntry: FileType | DirectoryType;

            if (token.fileType === 'file') {
              parsedEntry = {
                type: EntryType.FILE,
                path: token.filePath,
                content: '',
                stat: {
                  mode: token.fileMode,
                  uid: token.ownerUid,
                  gid: token.ownerGid,
                  size: token.fileSize,
                  mtime: token.fileMtime,
                },
              };
            } else {
              parsedEntry = {
                type: EntryType.DIRECTORY,
                path: token.filePath,
                children: [],
                stat: {
                  mode: token.fileMode,
                  uid: token.ownerUid,
                  gid: token.ownerGid,
                  size: token.fileSize,
                  mtime: token.fileMtime,
                },
              };
            }

            const parentPath = path.dirname(token.filePath);

            // If this entry is a directory, then it is pushed to the root of
            // the reconstructed virtual file system and into a map at the same
            // time. This allows us to add new children to the directory by
            // looking up the path in a map rather than modifying the value in
            // the reconstructed file system.

            if (parentPath === '/' || parentPath === '.') {
              reconstructedVfs.push(parsedEntry);
            } else {
              // It is guaranteed that in a valid tar file, the parent will
              // always exist.
              const parent: DirectoryType = pathStack.get(parentPath);
              parent.children.push(parsedEntry);
            }

            if (parsedEntry.type === EntryType.DIRECTORY) {
              pathStack.set(token.filePath, parsedEntry);
            } else {
              // Type narrowing doesn't work well with manually specified types
              currentEntry = parsedEntry as FileType;
            }

            break;
          }

          case 'data': {
            // It is guaranteed that in a valid tar file, a data block will
            // always come after a header block for a file.
            currentEntry!['content'] += decoder.decode(token.data);
            break;
          }
        }
      }

      expect(reconstructedVfs).toContainAllValues(vfs);
    },
  );
});
