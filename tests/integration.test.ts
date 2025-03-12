import type { VirtualFile, VirtualDirectory } from './types';
import type { MetadataKeywords } from '@/types';
import path from 'path';
import { test } from '@fast-check/jest';
import Generator from '@/Generator';
import Parser from '@/Parser';
import * as tarUtils from '@/utils';
import * as tarConstants from '@/constants';
import * as utils from './utils';

describe('integration testing', () => {
  test.skip.prop([utils.fileTreeArb])(
    'should archive and unarchive a virtual file system',
    (vfs) => {
      const generator = new Generator();
      const blocks: Array<Uint8Array> = [];

      const generateArchive = (entry: VirtualFile | VirtualDirectory) => {
        if (entry.path.length > tarConstants.STANDARD_PATH_SIZE) {
          // Push the extended metadata header
          const data = tarUtils.encodeExtendedHeader({ path: entry.path });
          blocks.push(generator.generateExtended(data.byteLength));

          // Push the content
          for (
            let offset = 0;
            offset < data.byteLength;
            offset += tarConstants.BLOCK_SIZE
          ) {
            blocks.push(
              generator.generateData(
                data.subarray(offset, offset + tarConstants.BLOCK_SIZE),
              ),
            );
          }
        }

        const filePath = entry.path.length <= 255 ? entry.path : '';

        switch (entry.type) {
          case 'file': {
            // Generate the header
            entry = entry as VirtualFile;
            blocks.push(generator.generateFile(filePath, entry.stat));

            // Generate the data
            const encoder = new TextEncoder();
            let content = entry.content;
            while (content.length > 0) {
              const dataChunk = content.slice(0, tarConstants.BLOCK_SIZE);
              blocks.push(generator.generateData(encoder.encode(dataChunk)));
              content = content.slice(tarConstants.BLOCK_SIZE);
            }
            break;
          }

          case 'directory': {
            // Generate the header
            entry = entry as VirtualDirectory;
            blocks.push(generator.generateDirectory(filePath, entry.stat));

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
      blocks.push(generator.generateEnd());
      blocks.push(generator.generateEnd());

      // The tar archive should be inside the blocks array now. Each block is
      // a single chunk aligned to 512-byte. Now we can parse it and check if
      // the parsed virtual file system matches the input.

      const parser = new Parser();
      const decoder = new TextDecoder();
      const reconstructedVfs: Array<VirtualFile | VirtualDirectory> = [];
      const pathStack: Map<string, any> = new Map();
      let currentEntry: VirtualFile;
      let extendedData: Uint8Array | undefined;
      let dataOffset = 0;

      for (const chunk of blocks) {
        const token = parser.write(chunk);
        if (token == null) continue;

        switch (token.type) {
          case 'header': {
            let parsedEntry: VirtualFile | VirtualDirectory | undefined;
            let extendedMetadata:
              | Partial<Record<MetadataKeywords, string>>
              | undefined;
            if (extendedData != null) {
              extendedMetadata = tarUtils.decodeExtendedHeader(extendedData);
            }

            const fullPath = extendedMetadata?.path?.trim()
              ? extendedMetadata.path
              : token.filePath;

            switch (token.fileType) {
              case 'file': {
                parsedEntry = {
                  type: 'file',
                  path: fullPath,
                  content: '',
                  stat: {
                    mode: token.fileMode,
                    uid: token.ownerUid,
                    gid: token.ownerGid,
                    size: token.fileSize,
                    mtime: token.fileMtime,
                  },
                };
                break;
              }
              case 'directory': {
                parsedEntry = {
                  type: 'directory',
                  path: fullPath,
                  children: [],
                  stat: {
                    mode: token.fileMode,
                    uid: token.ownerUid,
                    gid: token.ownerGid,
                    size: token.fileSize,
                    mtime: token.fileMtime,
                  },
                };
                break;
              }
              case 'metadata': {
                extendedData = new Uint8Array(token.fileSize);
                extendedMetadata = {};
                break;
              }
              default:
                throw new Error('Invalid state');
            }
            // If parsed entry has not been reassigned, then it was a metadata
            // header. Continue to fetch extended metadata.
            if (parsedEntry == null) continue;

            const parentPath = path.dirname(fullPath);

            // If this entry is a directory, then it is pushed to the root of
            // the reconstructed virtual file system and into a map at the same
            // time. This allows us to add new children to the directory by
            // looking up the path in a map rather than modifying the value in
            // the reconstructed file system.

            if (parentPath === '.') {
              reconstructedVfs.push(parsedEntry);
            } else {
              // It is guaranteed that in a valid tar file, the parent will
              // always exist.
              const parent: VirtualDirectory = pathStack.get(parentPath + '/');
              parent.children.push(parsedEntry);
            }

            if (parsedEntry.type === 'directory') {
              pathStack.set(fullPath, parsedEntry);
            } else {
              // Type narrowing doesn't work well with manually specified types
              currentEntry = parsedEntry as VirtualFile;
            }

            // If we were using the extended metadata for this header, reset it
            // for the next header.
            extendedData = undefined;
            dataOffset = 0;

            break;
          }

          case 'data': {
            if (extendedData == null) {
              // It is guaranteed that in a valid tar file, a data block will
              // always come after a header block for a file.
              currentEntry!['content'] += decoder.decode(token.data);
            } else {
              extendedData.set(token.data, dataOffset);
              dataOffset += token.data.byteLength;
            }
            break;
          }
        }
      }

      expect(reconstructedVfs).toContainAllValues(vfs);
    },
  );
});
