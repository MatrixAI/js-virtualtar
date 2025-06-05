import fs from 'fs';
import os from 'os';
import path from 'path';
import fc from 'fast-check';
import { test } from '@fast-check/jest';
import * as tar from 'tar';
import Generator from '@/Generator.js';
import { EntryType, GeneratorState } from '@/types.js';
import * as tarConstants from '@/constants.js';
import * as tarErrors from '@/errors.js';
import * as tarUtils from '@/utils.js';
import * as utils from './utils/index.js';

describe('generating archive', () => {
  test.prop([utils.fileArb()])(
    'should generate a valid file header',
    (file) => {
      // Generate and split the header
      const generator = new Generator();
      const header = generator.generateFile(file.path, file.stat);
      const { name, type, mode, uid, gid, size, mtime, format, version } =
        utils.splitHeaderData(header);

      // @ts-ignore: accessing protected member for state analysis
      const state = generator.state;
      if (file.stat.size === 0) expect(state).toEqual(GeneratorState.HEADER);
      else expect(state).toEqual(GeneratorState.DATA);

      // Compare the values to the expected ones
      expect(name).toEqual(file.path);
      expect(type).toEqual(EntryType.FILE);
      expect(mode).toEqual(file.stat.mode);
      expect(uid).toEqual(file.stat.uid);
      expect(gid).toEqual(file.stat.gid);
      expect(size).toEqual(file.stat.size);
      expect(mtime).toEqual(tarUtils.dateToTarTime(file.stat.mtime!));
      expect(format).toEqual('ustar');
      expect(version).toEqual('00');
    },
  );

  test.prop([utils.dirArb()])(
    'should generate a valid directory header',
    (file) => {
      // Generate and split the header
      const generator = new Generator();
      const header = generator.generateDirectory(file.path, file.stat);
      const { name, type, mode, uid, gid, size, mtime, format, version } =
        utils.splitHeaderData(header);

      // @ts-ignore: accessing protected member for state analysis
      const state = generator.state;
      if (file.stat.size === 0) expect(state).toEqual(GeneratorState.HEADER);

      // Compare the values to the expected ones
      expect(name).toEqual(file.path);
      expect(type).toEqual(EntryType.DIRECTORY);
      expect(mode).toEqual(file.stat.mode);
      expect(uid).toEqual(file.stat.uid);
      expect(gid).toEqual(file.stat.gid);
      expect(size).toEqual(0);
      expect(mtime).toEqual(tarUtils.dateToTarTime(file.stat.mtime!));
      expect(format).toEqual('ustar');
      expect(version).toEqual('00');
    },
  );

  test('should generate a valid null chunk', () => {
    const generator = new Generator();
    const nullChunk = generator.generateEnd();
    expect(nullChunk.reduce((sum, byte) => (sum += byte))).toBe(0);

    // @ts-ignore: accessing protected member for state analysis
    const state = generator.state;
    expect(state).toEqual(GeneratorState.NULL);
  });
});

describe('generator state robustness', () => {
  test.prop([utils.fileContentArb(0)], { numRuns: 1 })(
    'should fail writing data when header is expected',
    (data) => {
      const generator = new Generator();
      const encoder = new TextEncoder();
      expect(() => generator.generateData(encoder.encode(data))).toThrowError(
        tarErrors.ErrorVirtualTarGeneratorInvalidState,
      );
    },
  );

  test.prop([utils.fileArb(), utils.fileArb()], { numRuns: 1 })(
    'should fail writing new header if previous file header has not sent any data',
    (file1, file2) => {
      fc.pre(file1.stat.size !== 0);
      const generator = new Generator();

      // Writing first file
      generator.generateFile(file1.path, file1.stat);
      // @ts-ignore: accessing protected member for state analysis
      const state1 = generator.state;
      expect(state1).toEqual(GeneratorState.DATA);

      // Writing second file
      expect(() => generator.generateFile(file2.path, file2.stat)).toThrowError(
        tarErrors.ErrorVirtualTarGeneratorInvalidState,
      );
    },
  );

  test.prop(
    [fc.oneof(utils.fileContentArb(), utils.fileArb(), utils.dirArb())],
    { numRuns: 10 },
  )('should fail writing data when attempting to end archive', (data) => {
    const generator = new Generator();

    // Parse the type of incoming data and smartly switch between different
    // methods of writing to the generator.
    const writeData = () => {
      if (typeof data === 'string') {
        const encoder = new TextEncoder();
        generator.generateData(encoder.encode(data));
      } else if (data.type === 'file') {
        generator.generateFile(data.path, data.stat);
      } else {
        generator.generateDirectory(data.path, data.stat);
      }
    };

    generator.generateEnd();
    expect(writeData).toThrowError(
      tarErrors.ErrorVirtualTarGeneratorInvalidState,
    );
  });

  test.prop(
    [fc.oneof(utils.fileContentArb(), utils.fileArb(), utils.dirArb())],
    { numRuns: 10 },
  )('should fail writing data after ending archive', (data) => {
    const generator = new Generator();

    // Parse the type of incoming data and smartly switch between different
    // methods of writing to the generator.
    const writeData = () => {
      if (typeof data === 'string') {
        const encoder = new TextEncoder();
        generator.generateData(encoder.encode(data));
      } else if (data.type === 'file') {
        generator.generateFile(data.path, data.stat);
      } else {
        generator.generateDirectory(data.path, data.stat);
      }
    };

    generator.generateEnd();
    generator.generateEnd();
    expect(writeData).toThrowError(
      tarErrors.ErrorVirtualTarGeneratorInvalidState,
    );
  });
});

describe('testing against tar', () => {
  const encoder = new TextEncoder();

  test.prop([utils.fileTreeArb()])(
    'should match output of tar',
    async (fileTree) => {
      // Create a temp directory to use for node-tar
      const tempDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'js-virtualtar-test-'),
      );

      try {
        // Create the archive using the Generator
        const generator = new Generator();
        const blocks: Array<Uint8Array> = [];

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
              const chunk = data.slice(
                offset,
                offset + tarConstants.BLOCK_SIZE,
              );
              blocks.push(generator.generateData(chunk));
            }
          } else {
            blocks.push(generator.generateDirectory(filePath, entry.stat));
          }
        }

        blocks.push(generator.generateEnd());
        blocks.push(generator.generateEnd());

        // Write the archive to disk
        const archivePath = path.join(tempDir, 'archive.tar');
        const fd = await fs.promises.open(archivePath, 'w');
        for (const chunk of blocks) {
          await fd.write(chunk);
        }
        await fd.close();

        // Extract the archive from disk
        await tar.extract({
          file: archivePath,
          cwd: tempDir,
        });
        await fs.promises.rm(archivePath);

        for (const entry of fileTree) {
          // Note that writing files to disk will change some of the file stat
          // and metadata, so they are not being tested against the input file
          // tree.
          if (entry.type === 'file') {
            const filePath = path.join(tempDir, entry.path);
            const content = await fs.promises.readFile(filePath, 'utf8');
            expect(content).toBe(entry.content);
          } else {
            const dirPath = path.join(tempDir, entry.path);
            const stat = await fs.promises.stat(dirPath);
            expect(stat.isDirectory()).toBe(true);
          }
        }
      } finally {
        await fs.promises.rm(tempDir, { force: true, recursive: true });
      }
    },
  );
});
