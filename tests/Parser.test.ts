import type { VirtualFile, VirtualDirectory } from './types.js';
import type { MetadataKeywords } from '@/types.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import fc from 'fast-check';
import { test } from '@fast-check/jest';
import * as tar from 'tar';
import Parser from '@/Parser.js';
import { ParserState } from '@/types.js';
import * as tarErrors from '@/errors.js';
import * as tarUtils from '@/utils.js';
import * as tarConstants from '@/constants.js';
import * as utils from './utils/index.js';

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
      headers[0].set(checksum, tarConstants.HEADER_OFFSET.CHECKSUM);
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
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await fs.promises.rm(tempDir, { force: true, recursive: true });
    }
  });

  test.prop([utils.fileTreeArb()], { numRuns: 100 })(
    'should match output of tar',
    async (fileTree) => {
      // Create a temp directory to use for node-tar
      const tempDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'js-virtualtar-test-'),
      );

      try {
        const fileTreePath = path.join(tempDir, 'tree');
        await fs.promises.mkdir(fileTreePath);

        // Write the vfs to disk for tar to archive
        const writeFileTree = async (entry: VirtualFile | VirtualDirectory) => {
          const entryPath = path.join(fileTreePath, entry.path);
          if (entry.type === 'directory') {
            await fs.promises.mkdir(entryPath, { recursive: true });
          } else {
            await fs.promises.writeFile(entryPath, entry.content);
          }
        };
        for (const entry of fileTree) await writeFileTree(entry);

        // Use tar to archive the file
        const archivePath = path.join(tempDir, 'archive.tar');
        const entries = await fs.promises.readdir(fileTreePath);
        const archive = tar.create(
          {
            cwd: fileTreePath,
            preservePaths: true,
          },
          entries,
        );

        const fd = await fs.promises.open(archivePath, 'w');
        for await (const chunk of archive) {
          await fd.write(chunk);
        }
        await fd.close();

        const chunks: Uint8Array[] = [];
        const stream = fs.createReadStream(archivePath, { highWaterMark: 512 });
        for await (const chunk of stream) {
          chunks.push(new Uint8Array(chunk.buffer));
        }

        const parser = new Parser();
        const encoder = new TextEncoder();
        const reconstructedTree: Record<string, Uint8Array | null> = {};
        let workingPath: string | undefined = undefined;
        let workingData: Uint8Array = new Uint8Array();
        let extendedData: Uint8Array | undefined;
        let dataOffset = 0;

        for (const chunk of chunks) {
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

              if (workingPath != null) {
                reconstructedTree[workingPath] = workingData;
                workingData = new Uint8Array();
                workingPath = undefined;
              }

              switch (token.fileType) {
                case 'file': {
                  workingPath = fullPath;
                  break;
                }
                case 'directory': {
                  reconstructedTree[fullPath] = null;
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
                workingData = tarUtils.concatUint8Arrays(
                  workingData,
                  token.data,
                );
              } else {
                extendedData.set(token.data, dataOffset);
                dataOffset += token.data.byteLength;
              }
              break;
            }

            case 'end': {
              // Finalise adding the last file into the tree
              if (workingPath != null) {
                reconstructedTree[workingPath] = workingData;
                workingData = new Uint8Array();
                workingPath = undefined;
              }
            }
          }
        }

        for (const entry of fileTree) {
          if (entry.type === 'file') {
            const content = encoder.encode(entry.content);
            expect(reconstructedTree[entry.path]).toEqual(content);
          } else {
            expect(reconstructedTree[entry.path]).toBeNull();
          }
        }
      } finally {
        await fs.promises.rm(tempDir, { force: true, recursive: true });
      }
    },
  );
});
