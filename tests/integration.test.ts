import type { FileStat, MetadataKeywords } from '@/types';
import { test } from '@fast-check/jest';
import Generator from '@/Generator';
import Parser from '@/Parser';
import * as tarUtils from '@/utils';
import * as tarConstants from '@/constants';
import * as utils from './utils';

describe('integration testing', () => {
  test.prop([utils.fileTreeArb()])(
    'should archive and unarchive a virtual file system',
    (fileTree) => {
      const generator = new Generator();
      const blocks: Array<Uint8Array> = [];
      const encoder = new TextEncoder();

      for (const entry of fileTree) {
        if (entry.path.length > tarConstants.STANDARD_PATH_SIZE) {
          // Push the extended header
          const extendedData = tarUtils.encodeExtendedHeader({
            path: entry.path,
          });
          blocks.push(generator.generateExtended(extendedData.byteLength));

          // Push each data chunk
          for (
            let offset = 0;
            offset < extendedData.byteLength;
            offset += tarConstants.BLOCK_SIZE
          ) {
            const chunk = extendedData.slice(
              offset,
              offset + tarConstants.BLOCK_SIZE,
            );
            blocks.push(generator.generateData(chunk));
          }
        }
        const filePath =
          entry.path.length <= tarConstants.STANDARD_PATH_SIZE
            ? entry.path
            : '';

        if (entry.type === 'file') {
          blocks.push(generator.generateFile(filePath, entry.stat));
          const data = encoder.encode(entry.content);

          // Push each data chunk
          for (
            let offset = 0;
            offset < data.byteLength;
            offset += tarConstants.BLOCK_SIZE
          ) {
            const chunk = data.slice(offset, offset + tarConstants.BLOCK_SIZE);
            blocks.push(generator.generateData(chunk));
          }
        } else {
          blocks.push(generator.generateDirectory(filePath, entry.stat));
        }
      }

      blocks.push(generator.generateEnd());
      blocks.push(generator.generateEnd());

      // The tar archive should be inside the blocks array now. Each block is
      // a single chunk aligned to 512-byte. Now we can parse it and check if
      // the parsed virtual file system matches the input.

      const parser = new Parser();
      const reconstructedTree: Record<
        string,
        {
          data?: Uint8Array;
          stat: FileStat;
        }
      > = {};
      let workingPath: string | undefined = undefined;
      let workingStat: FileStat | undefined = undefined;
      let workingData: Uint8Array = new Uint8Array();
      let extendedData: Uint8Array | undefined;
      let dataOffset = 0;

      for (const chunk of blocks) {
        const token = parser.write(chunk);
        if (token == null) continue;

        switch (token.type) {
          case 'header': {
            let extendedMetadata:
              | Partial<Record<MetadataKeywords, string>>
              | undefined;
            if (extendedData != null) {
              extendedMetadata = tarUtils.decodeExtendedHeader(extendedData);
            }

            const fullPath = extendedMetadata?.path
              ? extendedMetadata.path
              : token.filePath;

            if (workingPath != null && workingStat != null) {
              reconstructedTree[workingPath] = {
                stat: workingStat,
                data: workingData,
              };
              workingData = new Uint8Array();
              workingPath = undefined;
              workingStat = undefined;
            }

            const fileStat: FileStat = {
              size: token.fileSize,
              mtime: token.fileMtime,
              mode: token.fileMode,
              uid: token.ownerUid,
              gid: token.ownerGid,
              uname: token.ownerUserName,
              gname: token.ownerGroupName,
            };

            switch (token.fileType) {
              case 'file': {
                workingPath = fullPath;
                workingStat = fileStat;
                break;
              }
              case 'directory': {
                reconstructedTree[fullPath] = { stat: fileStat };
                break;
              }
              case 'extended': {
                extendedData = new Uint8Array(token.fileSize);
                extendedMetadata = {};
                break;
              }
              default:
                throw new Error('Invalid state');
            }

            // If we were using the extended metadata for this header, reset it
            // for the next header.
            extendedData = undefined;
            dataOffset = 0;

            break;
          }

          case 'data': {
            if (extendedData == null) {
              workingData = tarUtils.concatUint8Arrays(workingData, token.data);
            } else {
              extendedData.set(token.data, dataOffset);
              dataOffset += token.data.byteLength;
            }
            break;
          }

          case 'end': {
            // Finalise adding the last file into the tree
            if (workingPath != null && workingStat != null) {
              reconstructedTree[workingPath] = {
                stat: workingStat,
                data: workingData,
              };
              workingData = new Uint8Array();
              workingPath = undefined;
              workingStat = undefined;
            }
          }
        }
      }

      for (const entry of fileTree) {
        expect(entry.stat).toMatchObject(reconstructedTree[entry.path].stat);
        if (entry.type === 'file') {
          const content = encoder.encode(entry.content);
          expect(reconstructedTree[entry.path].data).toEqual(content);
        } else {
          expect(reconstructedTree[entry.path].data).toBeUndefined();
        }
      }
    },
  );
});
