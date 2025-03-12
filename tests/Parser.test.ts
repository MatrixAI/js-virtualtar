import type { VirtualFile, VirtualDirectory } from './types';
import type { MetadataKeywords } from '@/types';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { test } from '@fast-check/jest';
import fc from 'fast-check';
import * as tar from 'tar';
import Parser from '@/Parser';
import { HeaderOffset, ParserState } from '@/types';
import * as tarErrors from '@/errors';
import * as tarUtils from '@/utils';
import * as tarConstants from '@/constants';
import * as utils from './utils';

describe('parsing archive blocks', () => {
  test.prop([utils.tarEntryArb()])(
    'should parse headers with correct state',
    ({ headers, data }) => {
      const { type, path, stat } = data;
      const parser = new Parser();
      const token = parser.write(headers[0]);

      expect(token?.type).toEqual('header');
      if (token?.type !== 'header') tarUtils.never('Token type');

      // @ts-ignore: accessing protected member for state analysis
      const state = parser.state;

      switch (type) {
        case 'file':
          // The file can have an extended header or a regular header
          if (data.path.length > tarConstants.STANDARD_PATH_SIZE) {
            expect(token.fileType).toEqual('metadata');
            expect(state).toEqual(ParserState.DATA);
          } else {
            // If there is no data, then another header can be parsed immediately
            expect(token.fileType).toEqual('file');
            if (stat.size !== 0) expect(state).toEqual(ParserState.DATA);
            else expect(state).toEqual(ParserState.HEADER);
          }
          break;
        case 'directory':
          expect(state).toEqual(ParserState.HEADER);
          expect(token.fileType).toEqual('directory');
          break;
        default:
          tarUtils.never('Invalid state');
      }

      expect(token.filePath).toEqual(path);
      expect(token.ownerUid).toEqual(stat.uid);
      expect(token.ownerGid).toEqual(stat.gid);
    },
  );

  test.prop([fc.uint8Array({ minLength: 512, maxLength: 512 })])(
    'should fail to parse gibberish data',
    (data) => {
      // Make sure a null block doesn't get tested. It is reserved for ending a
      // tar archive.
      fc.pre(!tarUtils.isNullBlock(data));

      const parser = new Parser();
      expect(() => parser.write(data)).toThrowError(
        tarErrors.ErrorVirtualTarParserInvalidHeader,
      );
    },
  );

  test.prop([fc.uint8Array()])(
    'should fail to parse blocks with arbitrary size',
    (data) => {
      // Make sure a null block doesn't get tested. It is reserved for ending a
      // tar archive.
      fc.pre(data.length !== tarConstants.BLOCK_SIZE);

      const parser = new Parser();
      expect(() => parser.write(data)).toThrowError(
        tarErrors.ErrorVirtualTarParserBlockSize,
      );
    },
  );

  test.prop(
    [utils.tarEntryArb(), fc.uint8Array({ minLength: 8, maxLength: 8 })],
    {
      numRuns: 1,
    },
  )(
    'should fail to parse header with an invalid checksum',
    ({ headers }, checksum) => {
      headers[0].set(checksum, HeaderOffset.CHECKSUM);
      const parser = new Parser();
      expect(() => parser.write(headers[0])).toThrowError(
        tarErrors.ErrorVirtualTarParserInvalidHeader,
      );
    },
  );

  describe('parsing end of archive', () => {
    test('should parse end of archive', () => {
      const parser = new Parser();

      const token1 = parser.write(new Uint8Array(tarConstants.BLOCK_SIZE));
      expect(token1).toBeUndefined();
      // @ts-ignore: accessing protected member for state analysis
      expect(parser.state).toEqual(ParserState.NULL);

      const token2 = parser.write(new Uint8Array(tarConstants.BLOCK_SIZE));
      expect(token2?.type).toEqual('end');
      // @ts-ignore: accessing protected member for state analysis
      expect(parser.state).toEqual(ParserState.ENDED);
    });

    test.prop([utils.tarEntryArb()], { numRuns: 1 })(
      'should fail if end of archive is malformed',
      ({ headers }) => {
        const parser = new Parser();

        const token1 = parser.write(new Uint8Array(tarConstants.BLOCK_SIZE));
        expect(token1).toBeUndefined();

        expect(() => parser.write(headers[0])).toThrowError(
          tarErrors.ErrorVirtualTarParserEndOfArchive,
        );
      },
    );

    test.prop([utils.tarEntryArb()], { numRuns: 1 })(
      'should fail if data is written after parser ending',
      ({ headers }) => {
        const parser = new Parser();
        // @ts-ignore: updating parser state for testing
        parser.state = ParserState.ENDED;

        expect(() => parser.write(headers[0])).toThrowError(
          tarErrors.ErrorVirtualTarParserEndOfArchive,
        );
      },
    );
  });
});

describe('parsing extended metadata', () => {
  test.prop(
    [utils.tarEntryArb({ minFilePathSize: 256, maxFilePathSize: 512 })],
    {
      numRuns: 1,
    },
  )('should create pax header with long paths', ({ headers }) => {
    const parser = new Parser();
    const token = parser.write(headers[0]);
    expect(token?.type).toEqual('header');
    // @ts-ignore: accessing protected member for state analysis
    expect(parser.state).toEqual(ParserState.DATA);
  });

  test.prop(
    [utils.tarEntryArb({ minFilePathSize: 256, maxFilePathSize: 512 })],
    {
      numRuns: 1,
    },
  )('should retrieve full file path from pax header', ({ headers, data }) => {
    // Get the header size
    const parser = new Parser();
    const paxHeader = parser.write(headers[0]);
    if (paxHeader == null || paxHeader.type !== 'header') {
      throw new Error('Invalid state');
    }
    const size = paxHeader.fileSize;

    // Concatenate all the data into a single array
    const numDataBlocks = Math.ceil(size / tarConstants.BLOCK_SIZE);
    const dataBlock = new Uint8Array(size);
    let offset = 0;
    for (const header of headers.slice(1, 1 + numDataBlocks)) {
      const paxData = parser.write(header);
      if (paxData == null || paxData.type !== 'data') {
        throw new Error(`Invalid state: ${paxData?.type}`);
      }
      dataBlock.set(paxData.data, offset);
      offset += paxData.data.byteLength;
    }

    // Parse the data into a record
    const parsedHeader = tarUtils.decodeExtendedHeader(dataBlock);
    expect(parsedHeader.path).toEqual(data.path);

    // The actual path in the header is ignored if the PAX header contains
    // metadata for the file path. Ignoring this is dependant on the user
    // instead of on the parser.
  });
});

describe('testing against tar', () => {
  test.skip.prop([utils.fileTreeArb], { numRuns: 1 })(
    'should match output of tar',
    async (vfs) => {
      // Create a temp directory to use for node-tar
      const tempDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'js-virtualtar-test-'),
      );

      try {
        const vfsPath = path.join(tempDir, 'vfs');
        await fs.promises.mkdir(vfsPath);

        // Write the vfs to disk for tar to archive
        const writeVfs = async (entry: VirtualFile | VirtualDirectory) => {
          // Due to operating system restrictions, all the generated metadata
          // cannot be written to disk. The mode, mtime, uid, and gid is
          // determined by external variables, and as such, will not be tested.
          delete entry.stat.mode;
          delete entry.stat.mtime;
          delete entry.stat.uid;
          delete entry.stat.gid;

          const entryPath = path.join(vfsPath, entry.path);
          if (entry.type === 'directory') {
            await fs.promises.mkdir(entryPath);
            for (const file of entry.children) await writeVfs(file);
          } else {
            await fs.promises.writeFile(entryPath, entry.content);
          }
        };
        for (const entry of vfs) await writeVfs(entry);

        // Use tar to archive the file
        const archivePath = path.join(tempDir, 'archive.tar');
        const entries = await fs.promises.readdir(vfsPath);
        await new Promise<void>((resolve) => {
          tar
            .create(
              {
                cwd: vfsPath,
                preservePaths: true,
              },
              entries,
            )
            .pipe(fs.createWriteStream(archivePath))
            .on('close', resolve);
        });

        const chunks: Uint8Array[] = [];
        const stream = fs.createReadStream(archivePath, { highWaterMark: 512 });
        for await (const chunk of stream) {
          chunks.push(new Uint8Array(chunk.buffer));
        }

        const parser = new Parser();
        const decoder = new TextDecoder();
        const reconstructedVfs: Array<VirtualFile | VirtualDirectory> = [];
        const pathStack: Map<string, any> = new Map();
        let currentEntry: VirtualFile;
        let extendedData: Uint8Array | undefined;
        let dataOffset = 0;

        for (const chunk of chunks) {
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
                    stat: { size: token.fileSize },
                  };
                  break;
                }
                case 'directory': {
                  parsedEntry = {
                    type: 'directory',
                    path: fullPath,
                    children: [],
                    stat: { size: token.fileSize },
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
                const parent: VirtualDirectory = pathStack.get(
                  parentPath + '/',
                );
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

        expect(utils.deepSort(reconstructedVfs)).toEqual(utils.deepSort(vfs));
      } finally {
        await fs.promises.rm(tempDir, { force: true, recursive: true });
      }
    },
  );
});
